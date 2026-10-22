"""Remote-browser OnlyFans login (plan direct-login §C).

A **real** browser logs the creator account in — the local backend through the account's proxy,
Browserbase on its own managed proxies with the account's proxy bound afterwards — by typing the
supplied email + password into OnlyFans' own login form. When OnlyFans shows a Cloudflare /
Turnstile / reCAPTCHA / hCaptcha / GeeTest challenge, or asks for a 2FA code, the challenge is
**surfaced to a human** over a screencast + input channel; it is never solved or bypassed here.
On success the browser's cookies and a signed `/api2/v2` request it already made are handed to the
*same* capture pipeline a pasted cURL uses (`session_commit.commit_captured_session`), so the
resulting session is identical.

This module owns only the job state machine, the driver seam and the screencast/input plumbing.
The Playwright driver that drives a real Chromium is `PlaywrightDriver` (imported lazily so this
module loads on a box without Playwright or Chromium — it is meant to run on a host that has a
browser, not inside the slim runtime image). Tests inject a fake driver.

Nothing here logs the password or the live cookies, and `snapshot()` never carries them.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

log = logging.getLogger("upstream.browser_login")

# One job may stay open this long (the human needs time to solve a challenge / read a 2FA SMS).
JOB_TTL_S = 600.0
# How often the worker re-reads the page and refreshes the screencast frame.
POLL_INTERVAL_S = 1.0


class State(str, Enum):
    STARTING = "starting"
    TYPING = "typing"
    CHALLENGE = "challenge"
    OTP = "otp"
    CAPTURING = "capturing"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


TERMINAL = {State.DONE, State.ERROR, State.CANCELLED}


@dataclass
class Challenge:
    """A human-solvable challenge the page is showing. `w`/`h` size the canvas the popup paints the
    screencast onto; a click maps back as x = round((clientX-rect.left)*w/rect.width)."""
    kind: str  # cloudflare | turnstile | recaptcha | hcaptcha | geetest | unknown
    w: int = 0
    h: int = 0


@dataclass
class Observation:
    """What the driver sees on the page right now."""
    kind: str  # working | challenge | otp | ready
    challenge: Challenge | None = None


@dataclass
class CapturedLogin:
    """Everything a successful login yields, shaped so it can be replayed through the pasted-cURL
    pipeline. `headers` are the signed `/api2/v2` request's headers the real page already sent
    (user-id, x-bc, x-of-rev, sign, time, user-agent, accept-language); `cookie` is the raw Cookie
    header. `static_param` is read off the page when available (else the pipeline falls back to a
    same-revision session or env STATIC_PARAM)."""
    url: str
    headers: dict[str, str]
    cookie: str
    static_param: str | None = None


class LoginDriver(Protocol):
    """A real browser the orchestrator drives. All methods are async and run on the event loop
    (Playwright's async API fits; it is never shared across threads)."""

    async def launch(self, *, proxy_url: str | None, profile_dir: str) -> None: ...
    async def submit_credentials(self, email: str, password: str) -> None: ...
    async def observe(self) -> Observation: ...
    async def screenshot(self) -> tuple[bytes, int, int]: ...
    async def click(self, x: int, y: int) -> None: ...
    async def type_text(self, text: str) -> None: ...
    async def submit_otp(self, code: str) -> None: ...
    async def harvest(self) -> CapturedLogin: ...
    async def close(self) -> None: ...


def build_login_curl(cap: CapturedLogin) -> str:
    """Render a captured login as the DevTools-style curl `session_bootstrap.from_curl` parses, so a
    browser capture flows through exactly the same derivation and record shape as a pasted cURL."""
    import shlex

    parts = ["curl", shlex.quote(cap.url)]
    for name, value in cap.headers.items():
        if value is None:
            continue
        parts += ["-H", shlex.quote(f"{name}: {value}")]
    parts += ["-b", shlex.quote(cap.cookie)]
    return " ".join(parts)


class LoginJob:
    """One remote-browser login attempt and its state machine:

        starting → typing → [challenge ↔ typing] → [otp → typing] → capturing → done | error | cancelled

    Inputs (a human's click / typed text / 2FA code / cancel) arrive on a queue and are applied by
    the worker on the same loop that drives the browser. The latest screencast frame and a version
    counter let the SSE stream push updates without polling the browser from another task."""

    def __init__(self, *, principal: str, email: str, password: str,
                 proxy_url: str | None, nickname: str | None = None) -> None:
        self.id = secrets.token_urlsafe(16)
        self.stream_token = secrets.token_urlsafe(24)
        self.principal = principal
        self._email = email
        self._password = password
        self._proxy_url = proxy_url
        self.nickname = nickname

        self.state = State.STARTING
        self.message: str | None = None
        self.challenge: Challenge | None = None
        self.needs_otp = False
        self.account_id: int | None = None
        self.username: str | None = None
        self.error: str | None = None
        # Set by a driver that has one (Browserbase): the operator's live view.
        self.live_view_url: str | None = None

        self.created_at = time.monotonic()
        self.deadline = self.created_at + JOB_TTL_S
        self.frame: tuple[bytes, int, int] | None = None  # png bytes, w, h
        self.version = 0
        self._updated = asyncio.Event()
        self._inputs: asyncio.Queue[dict] = asyncio.Queue()
        self._task: asyncio.Task | None = None

    # ── state / notifications ──────────────────────────────────────

    def _bump(self) -> None:
        self.version += 1
        self._updated.set()

    def _set_state(self, state: State, message: str | None = None) -> None:
        self.state = state
        if message is not None:
            self.message = message
        self._bump()

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL

    @property
    def expired(self) -> bool:
        return time.monotonic() > self.deadline

    def snapshot(self) -> dict[str, Any]:
        """Status for a poll — never the password, cookies or stream token."""
        return {
            "jobId": self.id,
            "state": self.state.value,
            "message": self.message,
            "challenge": None if self.challenge is None
            else {"kind": self.challenge.kind, "w": self.challenge.w, "h": self.challenge.h},
            "needsOtp": self.needs_otp,
            "accountId": self.account_id,
            "username": self.username,
            "error": self.error,
            "liveViewUrl": self.live_view_url,
        }

    async def wait_update(self, since: int, timeout: float = POLL_INTERVAL_S) -> int:
        """Block until the version moves past `since` (or `timeout`); returns the current version."""
        if self.version > since:
            return self.version
        self._updated.clear()
        try:
            await asyncio.wait_for(self._updated.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return self.version

    # ── input channel ──────────────────────────────────────────────

    def submit_input(self, event: dict) -> None:
        """Queue a human input: {type: click, x, y} | {type: text, text} | {type: otp, code} |
        {type: cancel}. Rejected once the job is terminal."""
        if self.terminal:
            raise ValueError("job is no longer live")
        self._inputs.put_nowait(event)

    async def _drain_inputs(self, driver: LoginDriver) -> bool:
        """Apply every queued input; returns True if a cancel was seen."""
        cancelled = False
        while True:
            try:
                event = self._inputs.get_nowait()
            except asyncio.QueueEmpty:
                break
            kind = event.get("type")
            if kind == "cancel":
                cancelled = True
            elif kind == "click":
                await driver.click(int(event["x"]), int(event["y"]))
            elif kind == "text":
                await driver.type_text(str(event["text"]))
            elif kind == "otp":
                await driver.submit_otp(str(event["code"]))
                self.needs_otp = False
                self._set_state(State.TYPING, "2FA code submitted")
        return cancelled

    # ── the worker ─────────────────────────────────────────────────

    async def run(self, driver: LoginDriver, finalize: Any) -> None:
        """Drive the browser to a captured session. `finalize(captured, proxy_url)` is an async
        callback that runs the shared capture pipeline and returns {accountId, username}."""
        try:
            self._set_state(State.STARTING, "launching browser")
            await driver.launch(proxy_url=self._proxy_url, profile_dir=f"login-{self.id}")
            self.live_view_url = getattr(driver, "live_view_url", None)
            self._set_state(State.TYPING, "entering credentials")
            await driver.submit_credentials(self._email, self._password)
            # Credentials are no longer needed in memory.
            self._email = self._password = ""

            while True:
                if self.expired:
                    raise TimeoutError("login timed out")
                if await self._drain_inputs(driver):
                    self._set_state(State.CANCELLED, "cancelled")
                    return
                obs = await driver.observe()
                await self._refresh_frame(driver)
                if obs.kind == "challenge":
                    if self.state is not State.CHALLENGE or self.challenge != obs.challenge:
                        self.challenge = obs.challenge
                        self._set_state(State.CHALLENGE, "solve the challenge in the popup")
                elif obs.kind == "otp":
                    self.challenge = None
                    if not self.needs_otp:
                        self.needs_otp = True
                        self._set_state(State.OTP, "enter the 2FA code")
                elif obs.kind == "ready":
                    self.challenge = None
                    self.needs_otp = False
                    self._set_state(State.CAPTURING, "capturing session")
                    captured = await driver.harvest()
                    result = await finalize(captured, self._proxy_url)
                    self.account_id = result.get("accountId")
                    self.username = result.get("username")
                    self._set_state(State.DONE, "connected")
                    return
                else:  # working
                    if self.state not in (State.TYPING, State.STARTING):
                        self._set_state(State.TYPING)
                await asyncio.sleep(POLL_INTERVAL_S)
        except asyncio.CancelledError:
            self._set_state(State.CANCELLED, "cancelled")
            raise
        except Exception as e:  # noqa: BLE001 — any driver/pipeline failure ends the job
            self.error = _scrub(str(e), self._password) or e.__class__.__name__
            log.warning("browser login %s failed: %s", self.id, self.error)
            self._set_state(State.ERROR, self.error)
        finally:
            with contextlib.suppress(Exception):
                await driver.close()

    async def _refresh_frame(self, driver: LoginDriver) -> None:
        try:
            png, w, h = await driver.screenshot()
        except Exception:  # noqa: BLE001 — a missing frame must not kill the job
            return
        self.frame = (png, w, h)
        self._bump()

    async def cancel(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task


def _scrub(text: str, *secrets_: str) -> str:
    """Remove the password (and any other secret) from a message before it is surfaced."""
    for s in secrets_:
        if s:
            text = text.replace(s, "***")
    return text


class LoginManager:
    """Owns the live jobs: at most one per principal, started-principal checks, TTL expiry.

    `driver_factory()` returns a fresh `LoginDriver`; `finalize(captured, proxy_url)` runs the shared
    capture pipeline on the event loop. Both are injected so the whole machine is testable without a
    real browser."""

    def __init__(self, driver_factory: Any, finalize: Any) -> None:
        self._driver_factory = driver_factory
        self._finalize = finalize
        self._jobs: dict[str, LoginJob] = {}

    def _prune(self) -> None:
        for jid in [jid for jid, j in self._jobs.items() if j.terminal or j.expired]:
            job = self._jobs[jid]
            if job.expired and not job.terminal:
                continue  # the worker will mark it; keep it until then
            del self._jobs[jid]

    def start(self, *, principal: str, email: str, password: str,
              proxy_url: str | None, nickname: str | None = None,
              driver_factory: Any = None, finalize: Any = None) -> LoginJob:
        """Begin a login. Replaces any live job the same principal still has open (one at a time).
        `driver_factory` / `finalize` override the manager's for this job (e.g. the Browserbase
        driver, or a finalize that binds a named proxy)."""
        self._prune()
        for jid, job in list(self._jobs.items()):
            if job.principal == principal and not job.terminal:
                asyncio.ensure_future(job.cancel())
                del self._jobs[jid]
        job = LoginJob(principal=principal, email=email, password=password,
                       proxy_url=proxy_url, nickname=nickname)
        self._jobs[job.id] = job
        job._task = asyncio.ensure_future(job.run((driver_factory or self._driver_factory)(),
                                                  finalize or self._finalize))
        return job

    def get(self, job_id: str, principal: str) -> LoginJob:
        """The job, if it exists and belongs to `principal` (the started-principal check)."""
        job = self._jobs.get(job_id)
        if job is None or job.principal != principal:
            raise KeyError(job_id)
        return job

    def get_for_stream(self, job_id: str, stream_token: str) -> LoginJob:
        """The job for an SSE subscriber: EventSource cannot set headers, so it authenticates with
        the per-job stream token in the query string instead of the principal."""
        import hmac

        job = self._jobs.get(job_id)
        if job is None or not hmac.compare_digest(job.stream_token, stream_token):
            raise KeyError(job_id)
        return job

"""The Browserbase `LoginDriver` for the remote-browser login: the same Playwright driving as
`PlaywrightDriver`, but the Chromium runs on Browserbase and is reached over CDP.

The operator watches (and, for a Cloudflare / 2FA challenge, takes over) the browser in Browserbase's
own live view (`live_view_url`, the session's `debuggerFullscreenUrl`). Browserbase's captcha solver is
forced off (`solveCaptchas: false`) and nothing here adds stealth or fingerprint spoofing: a human
solves every challenge.

Proxy policy: the chosen proxy is sent as a Browserbase *external* proxy. When Browserbase refuses it
(402 on the free plan, or any other error creating a proxied session) the session is created again
without proxies, so the login still works from Browserbase's IP; `proxy_fallback` records it. The
captured session is still bound to the chosen proxy afterwards, like an extension-captured login.

`BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` come from the environment only. Neither the OF
password nor the proxy password is ever logged or put into an error message.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import browser_login
from browser_login_playwright import (
    EMAIL_SELECTORS,
    LOGIN_URL,
    PASSWORD_SELECTORS,
    SUBMIT_SELECTORS,
    PlaywrightDriver,
)

log = logging.getLogger("upstream.browser_login.browserbase")

BROWSERBASE_API = "https://api.browserbase.com/v1"
HTTP_TIMEOUT_S = 30
NAV_TIMEOUT_MS = 45_000


class BrowserbaseError(RuntimeError):
    """A Browserbase API call failed; `status` is the HTTP status (None for a network error)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(os.environ.get("BROWSERBASE_API_KEY") and os.environ.get("BROWSERBASE_PROJECT_ID"))


def _env() -> tuple[str, str]:
    key, project = os.environ.get("BROWSERBASE_API_KEY"), os.environ.get("BROWSERBASE_PROJECT_ID")
    if not key or not project:
        raise BrowserbaseError("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set")
    return key, project


def _request(path: str, method: str = "GET", body: dict | None = None,
             secrets: tuple[str, ...] = ()) -> dict[str, Any]:
    """One Browserbase REST call (blocking; run it in a thread). Tests replace this symbol."""
    key, _ = _env()
    req = urllib.request.Request(
        f"{BROWSERBASE_API}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-BB-API-Key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        # The response body only (never the request, which carries the proxy password), scrubbed in
        # case Browserbase echoes the proxy back.
        detail = browser_login._scrub(e.read().decode(errors="replace")[:300], *secrets)
        raise BrowserbaseError(f"Browserbase {method} {path} failed (HTTP {e.code}): {detail}",
                               e.code) from None
    except urllib.error.URLError as e:
        raise BrowserbaseError(f"Browserbase {method} {path} failed: {e.reason}") from None
    return json.loads(raw.decode() or "{}")


async def _call(path: str, method: str = "GET", body: dict | None = None,
                secrets: tuple[str, ...] = ()) -> dict[str, Any]:
    return await asyncio.to_thread(_request, path, method, body, secrets)


def external_proxy(proxy_url: str) -> dict[str, str]:
    """A proxy URL as Browserbase's external proxy: `{type, server, username?, password?}`."""
    u = urlsplit(proxy_url)
    out = {"type": "external", "server": f"{u.scheme}://{u.hostname}:{u.port}"}
    if u.username:
        out["username"] = u.username
    if u.password:
        out["password"] = u.password
    return out


def session_body(project_id: str, proxy_url: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "projectId": project_id,
        # A human solves challenges in the live view; Browserbase's solver defaults to on.
        "browserSettings": {"solveCaptchas": False},
        # Outlive the job (Browserbase's default is 300 s) so the human has the job's full window.
        "timeout": int(browser_login.JOB_TTL_S) + 60,
    }
    if proxy_url:
        body["proxies"] = [external_proxy(proxy_url)]
    return body


async def create_session(proxy_url: str | None) -> tuple[dict[str, Any], int | None, bool]:
    """Create a session through `proxy_url`; when Browserbase refuses the proxy, create one without.
    Returns `(session, fallback_status, fell_back)` (`fallback_status` is the refusal's HTTP status)."""
    _, project = _env()
    secrets = tuple(s for s in (urlsplit(proxy_url).password if proxy_url else None,) if s)
    fell_back, status = False, None
    try:
        session = await _call("/sessions", "POST", session_body(project, proxy_url), secrets)
    except BrowserbaseError as e:
        if not proxy_url:
            raise
        fell_back, status = True, e.status
        log.warning("browserbase refused the proxy (HTTP %s); retrying without proxies", e.status)
        session = await _call("/sessions", "POST", session_body(project, None))
    if not session.get("id") or not session.get("connectUrl"):
        raise BrowserbaseError("Browserbase created a session without an id/connectUrl")
    return session, status, fell_back


async def live_view_url(session_id: str) -> str | None:
    try:
        dbg = await _call(f"/sessions/{session_id}/debug")
    except BrowserbaseError as e:
        log.warning("browserbase live view unavailable: %s", e)
        return None
    url = dbg.get("debuggerFullscreenUrl") or dbg.get("debuggerUrl")
    pages = dbg.get("pages") or []
    if not url and pages:
        url = pages[0].get("debuggerFullscreenUrl") or pages[0].get("debuggerUrl")
    return url


async def release(session_id: str) -> None:
    try:
        _, project = _env()
        await _call(f"/sessions/{session_id}", "POST", {"projectId": project, "status": "REQUEST_RELEASE"})
    except BrowserbaseError as e:  # the session times out on its own
        log.info("browserbase release failed: %s", e)


class BrowserbaseDriver(PlaywrightDriver):
    """`PlaywrightDriver` over CDP to a Browserbase session. `on_session(driver)` runs as soon as the
    session (and its live view URL) exists, before the CDP connect."""

    def __init__(self, on_session: Callable[[BrowserbaseDriver], Any] | None = None) -> None:
        super().__init__()
        self._on_session = on_session
        self._browser = None
        self._pending: tuple[str, str] | None = None
        self.session_id: str | None = None
        self.live_view_url: str | None = None
        self.proxy_fallback = False
        self.proxy_fallback_status: int | None = None

    async def launch(self, *, proxy_url: str | None, profile_dir: str) -> None:
        from playwright.async_api import async_playwright

        session, self.proxy_fallback_status, self.proxy_fallback = await create_session(proxy_url)
        self.session_id = session["id"]
        self.live_view_url = await live_view_url(self.session_id)
        if self._on_session is not None:
            self._on_session(self)
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.connect_over_cdp(session["connectUrl"])
        contexts = self._browser.contexts
        self._context = contexts[0] if contexts else await self._browser.new_context()
        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        self._page.on("request", self._note_request)

    async def submit_credentials(self, email: str, password: str) -> None:
        """Open OnlyFans and fill the form once it renders. A challenge may come first, so a missing
        form is not an error: `observe()` keeps trying until the human has cleared the challenge."""
        with contextlib.suppress(Exception):  # a slow proxy: inspect the page anyway
            await self._page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        self._pending = (email, password)
        await self._try_fill()

    async def _first(self, selectors: tuple[str, ...]):
        for sel in selectors:
            el = await self._page.query_selector(sel)
            if el is not None:
                return el
        return None

    async def _try_fill(self) -> None:
        if self._pending is None:
            return
        try:
            em, pw = await self._first(EMAIL_SELECTORS), await self._first(PASSWORD_SELECTORS)
            if em is None or pw is None:
                return
            email, password = self._pending
            await em.fill(email)
            await pw.fill(password)
            self._pending = None  # credentials typed: drop them
            submit = await self._first(SUBMIT_SELECTORS)
            if submit is not None:
                await submit.click()
            else:
                await pw.press("Enter")
        except Exception as e:  # noqa: BLE001 — never surface a message that could echo the password
            log.info("browserbase login form fill failed: %s", type(e).__name__)

    async def observe(self) -> browser_login.Observation:
        obs = await super().observe()
        if obs.kind == "working" and self._pending is not None:
            await self._try_fill()
        return obs

    async def close(self) -> None:
        self._pending = None
        for obj, closer in ((self._browser, "close"), (self._pw, "stop")):
            if obj is not None:
                with contextlib.suppress(Exception):
                    await getattr(obj, closer)()
        if self.session_id:
            await release(self.session_id)

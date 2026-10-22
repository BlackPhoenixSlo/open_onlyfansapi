"""The Browserbase `LoginDriver` for the remote-browser login: the same Playwright driving as
`PlaywrightDriver`, but the Chromium runs on Browserbase and is reached over CDP.

The operator watches (and, for a Cloudflare / 2FA challenge, takes over) the browser in Browserbase's
own live view (`live_view_url`, the session's `debuggerFullscreenUrl`). Browserbase's captcha solver is
forced off (`solveCaptchas: false`) and nothing here adds stealth or fingerprint spoofing: a human
solves every challenge.

Proxy policy: the session runs on Browserbase's managed proxies (`proxies: true`); our proxy is never
sent to Browserbase (residential/ISP proxies that work from the upstream answer Browserbase's CONNECT
with 403). The proxy the operator picked is bound to the account after the login, the way a pasted
cURL binds it, so every later call for the account egresses through it, like an extension-captured
login. A session that can't be created, or an OnlyFans page that won't load, fails the job at once.

`BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` come from the environment only. The OF password is
never logged or put into an error message.
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

import browser_login
from browser_login_playwright import STATIC_PARAM_HOOK, PlaywrightDriver

log = logging.getLogger("upstream.browser_login.browserbase")

BROWSERBASE_API = "https://api.browserbase.com/v1"
HTTP_TIMEOUT_S = 30
# A common laptop viewport, so the live view stays readable on a phone (Browserbase's default is 2560x1440).
VIEWPORT = {"width": 1280, "height": 800}


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


def _request(path: str, method: str = "GET", body: dict | None = None) -> dict[str, Any]:
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
        detail = e.read().decode(errors="replace")[:300]
        raise BrowserbaseError(f"Browserbase {method} {path} failed (HTTP {e.code}): {detail}",
                               e.code) from None
    except urllib.error.URLError as e:
        raise BrowserbaseError(f"Browserbase {method} {path} failed: {e.reason}") from None
    return json.loads(raw.decode() or "{}")


async def _call(path: str, method: str = "GET", body: dict | None = None) -> dict[str, Any]:
    return await asyncio.to_thread(_request, path, method, body)


def session_body(project_id: str) -> dict[str, Any]:
    return {
        "projectId": project_id,
        # Browserbase's managed proxies; ours is bound to the account after the login.
        "proxies": True,
        # A human solves challenges in the live view; Browserbase's solver defaults to on.
        "browserSettings": {"solveCaptchas": False, "viewport": dict(VIEWPORT)},
        # Outlive the job (Browserbase's default is 300 s) so the human has the job's full window.
        "timeout": int(browser_login.JOB_TTL_S) + 60,
    }


async def create_session() -> dict[str, Any]:
    """A session on Browserbase's managed proxies. Raises on any refusal: there is no fallback."""
    _, project = _env()
    try:
        session = await _call("/sessions", "POST", session_body(project))
    except BrowserbaseError as e:
        raise BrowserbaseError(f"couldn't start a Browserbase session on its managed proxies: {e}",
                               e.status) from None
    if not session.get("id") or not session.get("connectUrl"):
        raise BrowserbaseError("Browserbase created a session without an id/connectUrl")
    return session


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
        self.session_id: str | None = None
        self.live_view_url: str | None = None

    async def launch(self, *, proxy_url: str | None, profile_dir: str) -> None:
        """`proxy_url` is deliberately unused: the browser runs on Browserbase's managed proxies and the
        job binds the operator's proxy to the account after the login."""
        from playwright.async_api import async_playwright

        session = await create_session()
        self.session_id = session["id"]
        self.live_view_url = await live_view_url(self.session_id)
        if self._on_session is not None:
            self._on_session(self)
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.connect_over_cdp(session["connectUrl"])
        contexts = self._browser.contexts
        self._context = contexts[0] if contexts else await self._browser.new_context()
        await self._context.add_init_script(STATIC_PARAM_HOOK)
        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        self._page.on("request", self._note_request)

    async def close(self) -> None:
        for obj, closer in ((self._browser, "close"), (self._pw, "stop")):
            if obj is not None:
                with contextlib.suppress(Exception):
                    await getattr(obj, closer)()
        if self.session_id:
            await release(self.session_id)

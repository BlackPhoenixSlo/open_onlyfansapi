"""Runs the real upstream (services/upstream/app.py) for a slop run, with hooks OUTSIDE service code:

  * the loopback guard (lib/guard.py), installed before anything is imported; refusals go to $SLOP_GUARD_LOG;
  * OnlyFans' hosts pointed at the fake world, by module constant, before `app` is imported (routes import
    API_BASE by value):  of_client.API_BASE / HASH_BASE, session_bootstrap.CHUNK_URL_TPL -> $SLOP_OF_API;
    browser_login_browserbase.BROWSERBASE_API -> $SLOP_BB_API. browser_login_playwright.LOGIN_URL is left as is:
    the fake Browserbase's Chromium maps onlyfans.com to the fake site;
  * $SLOP_WS_RECONNECT_MAX_S (a scenario's declared knob): of_ws.RECONNECT_MAX_S, the socket's reconnect backoff cap
    (30 s in the product), so a reconnect loop shows within a short observation window;
  * $SLOP_FAULT, a named product fault (see FAULTS), patched into the live module.

Usage: python upstream_launcher.py <port>   (cwd and sys.path: services/upstream)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM = HERE.parents[1] / "services" / "upstream"
sys.path.insert(0, str(HERE))
import guard

guard.install(os.environ["SLOP_GUARD_LOG"])
sys.path.insert(0, str(UPSTREAM))

import of_client
import session_bootstrap

OF_API = os.environ["SLOP_OF_API"].rstrip("/")
of_client.API_BASE = f"{OF_API}/api2/v2"
of_client.HASH_BASE = f"{OF_API}/hash"
session_bootstrap.CHUNK_URL_TPL = f"{OF_API}/static/prod/f/{{rev}}/2313.js"

import browser_login_browserbase

browser_login_browserbase.BROWSERBASE_API = os.environ["SLOP_BB_API"].rstrip("/")


def _otp_code_never_consumed() -> None:
    """The worker never takes the 2FA code from the job's slot: a code is accepted (200, otpChecking)
    but never typed into OnlyFans' field."""
    import browser_login

    browser_login.LoginJob._take_otp = lambda self: None


_session_refused = of_client.session_refused


def _otpstate_not_refused() -> None:
    """master's classifier: OF's 400 code 101 ("otpState") is an ordinary 400, not a dead session. Wraps
    `of_client.session_refused` (whatever its rule) so a 400 with error code 101 answers False, in of_client and,
    after `app` is imported, in every module that imported the function by name (of_ws, deps, poll_loop, ...)."""

    def session_refused(resp, *, users_me: bool = False) -> bool:
        if getattr(resp, "status_code", None) == 400:
            try:
                err = resp.json().get("error")
            except Exception:  # noqa: BLE001 — no JSON body
                err = None
            if isinstance(err, dict) and err.get("code") == 101:
                return False
        return _session_refused(resp, users_me=users_me)

    of_client.session_refused = session_refused
    _REPATCH.append(session_refused)


def _challenge_ignores_visibility() -> None:
    """Challenge detection without its visibility rule: any challenge container or Cloudflare frame in the DOM counts,
    hidden or not (what `query_selector` and the bare frame-URL walk did before), so a leftover hidden captcha masks
    the 2FA prompt. The fake site's captchas are reCAPTCHA frames, so a run exercises the container half (`_shown`);
    the frame half is covered by the upstream's real-Chromium test."""
    import browser_login_playwright as blp

    async def shown(self, selector):
        return await self._page.query_selector(selector) is not None

    async def frame_shown(_frame):
        return True

    blp.PlaywrightDriver._shown = shown
    blp._frame_shown = frame_shown


_REPATCH: list = []
FAULTS = {"otp-code-never-consumed": _otp_code_never_consumed, "otpstate-not-refused": _otpstate_not_refused,
          "challenge-ignores-visibility": _challenge_ignores_visibility}

if os.environ.get("SLOP_WS_RECONNECT_MAX_S"):
    import of_ws

    of_ws.RECONNECT_MAX_S = int(os.environ["SLOP_WS_RECONNECT_MAX_S"])
    print(f"[slop] knob: of_ws.RECONNECT_MAX_S = {of_ws.RECONNECT_MAX_S}", flush=True)

fault = os.environ.get("SLOP_FAULT") or ""
if fault:
    FAULTS[fault]()
    print(f"[slop] fault applied: {fault}", flush=True)

import uvicorn

import app

for patched in _REPATCH:  # a module imported before the fault (or by `app`) holds the original by name
    for mod in list(sys.modules.values()):
        if getattr(mod, "session_refused", None) is _session_refused:
            mod.session_refused = patched
    held = sorted(m.__name__ for m in list(sys.modules.values()) if getattr(m, "session_refused", None) is patched)
    print(f"[slop] fault: session_refused is the patched one in {held}", flush=True)

for name, mod, attr in (("of_client.API_BASE", of_client, "API_BASE"), ("of_client.HASH_BASE", of_client, "HASH_BASE"),
                        ("session_bootstrap.CHUNK_URL_TPL", session_bootstrap, "CHUNK_URL_TPL"),
                        ("browser_login_browserbase.BROWSERBASE_API", browser_login_browserbase, "BROWSERBASE_API")):
    print(f"[slop] {name} = {getattr(mod, attr)}", flush=True)

uvicorn.run(app.app, host="127.0.0.1", port=int(sys.argv[1]), log_level="info")

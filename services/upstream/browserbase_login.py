"""Attended OnlyFans login on Browserbase, from a terminal. Uses the same job + driver as the API's
`backend: "browserbase"` login, but persists nothing: it reports success with cookie names only.

    OF_EMAIL=... OF_PASSWORD=... BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... \\
        python browserbase_login.py
    BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... python browserbase_login.py --smoke

Prints `LIVEVIEW: <url>` as soon as the session exists: open it and solve any Cloudflare / 2FA check
by hand. Then `LOGIN: SUCCESS` or `LOGIN: FAIL <reason>` (up to 10 minutes). `--smoke` only creates a
session, opens onlyfans.com, reports whether the login form renders and releases the session.
Both run on Browserbase's managed proxies, like the API's login (no proxy of ours goes to Browserbase).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

import browser_login
import browser_login_browserbase as bb
from browser_login_playwright import (
    EMAIL_SELECTORS,
    FORM_WAIT_S,
    LOGIN_URL,
    NAV_TIMEOUT_MS,
)


def say(line: str) -> None:
    print(line, flush=True)


def on_session(driver: bb.BrowserbaseDriver) -> None:
    say(f"SESSION: {driver.session_id}")
    say(f"LIVEVIEW: {driver.live_view_url or 'unavailable'}")


async def smoke() -> int:
    driver = bb.BrowserbaseDriver(on_session=on_session)
    try:
        await driver.launch(proxy_url=None, profile_dir="smoke")
        page = driver._page
        try:
            await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            say(f"NAV: {type(e).__name__} (inspecting the page anyway)")
        try:
            await page.locator(", ".join(EMAIL_SELECTORS)).first.wait_for(
                state="visible", timeout=FORM_WAIT_S * 1000)
        except Exception:  # noqa: BLE001
            challenge = await driver._detect_challenge()
            say(f"SMOKE: FAIL login form not rendered after {FORM_WAIT_S}s "
                f"(challenge={challenge or 'none'}, title={await page.title()!r})")
            return 1
        say(f"SMOKE: OK login form rendered (title={await page.title()!r})")
        return 0
    except Exception as e:  # noqa: BLE001
        say(f"SMOKE: FAIL {e}")
        return 1
    finally:
        await driver.close()
        say("RELEASED")


async def attended() -> int:
    email, password = os.environ.get("OF_EMAIL"), os.environ.get("OF_PASSWORD")
    if not email or not password:
        say("LOGIN: FAIL set OF_EMAIL and OF_PASSWORD")
        return 2
    captured: list[browser_login.CapturedLogin] = []

    async def finalize(cap: browser_login.CapturedLogin, _proxy_url: str | None) -> dict:
        captured.append(cap)  # nothing is persisted
        return {}

    job = browser_login.LoginJob(principal="cli", email=email, password=password, proxy_url=None)
    del password
    run = asyncio.ensure_future(job.run(bb.BrowserbaseDriver(on_session=on_session), finalize))
    seen = None
    while not run.done():
        if (job.state, job.message) != seen:
            seen = (job.state, job.message)
            say(f"STATE: {job.state.value} {job.message or ''}".rstrip())
        await asyncio.wait({run}, timeout=1)
    await run
    if job.state is browser_login.State.DONE and captured:
        names = sorted({c.split("=", 1)[0].strip() for c in captured[0].cookie.split(";") if "=" in c})
        say(f"LOGIN: SUCCESS user-id={captured[0].headers.get('user-id')} cookies={','.join(names)}")
        return 0
    say(f"LOGIN: FAIL {job.error or job.state.value}")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--smoke", action="store_true", help="only check that the OF login form renders")
    args = ap.parse_args()
    if not bb.configured():
        say("LOGIN: FAIL set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID")
        return 2
    return asyncio.run(smoke() if args.smoke else attended())


if __name__ == "__main__":
    sys.exit(main())

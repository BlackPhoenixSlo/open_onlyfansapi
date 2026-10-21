"""Attended OnlyFans login on Browserbase, from a terminal. Uses the same job + driver as the API's
`backend: "browserbase"` login, but persists nothing: it reports success with cookie names only.

    OF_EMAIL=... OF_PASSWORD=... BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... \\
        python browserbase_login.py [--proxy-label LABEL]
    BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... python browserbase_login.py --smoke [--proxy-label LABEL]

Prints `LIVEVIEW: <url>` as soon as the session exists: open it and solve any Cloudflare / 2FA check
by hand. Then `LOGIN: SUCCESS` or `LOGIN: FAIL <reason>` (up to 10 minutes). `--smoke` only creates a
session, opens onlyfans.com, reports whether the login form renders and releases the session.
`--proxy-label` reads the proxy from this upstream's proxies.json (UPSTREAM_STATE_DIR).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

import browser_login
import browser_login_browserbase as bb
from browser_login_playwright import EMAIL_SELECTORS, LOGIN_URL, PASSWORD_SELECTORS

SMOKE_WAIT_S = 30


def say(line: str) -> None:
    print(line, flush=True)


def on_session(driver: bb.BrowserbaseDriver) -> None:
    say(f"SESSION: {driver.session_id}")
    say(f"LIVEVIEW: {driver.live_view_url or 'unavailable'}")
    if driver.proxy_fallback:
        say(f"PROXY: Browserbase rejected the proxy ({driver.proxy_fallback_status or 'error'}); "
            "running on Browserbase's IP")


def proxy_url_for(label: str | None) -> str | None:
    if not label:
        return None
    import proxies

    entry = proxies.get_by_label(label)
    if entry is None:
        raise SystemExit(f"LOGIN: FAIL no proxy with label {label!r}")
    return proxies.proxy_url(entry)


async def smoke(proxy_url: str | None) -> int:
    driver = bb.BrowserbaseDriver(on_session=on_session)
    try:
        await driver.launch(proxy_url=proxy_url, profile_dir="smoke")
        page = driver._page
        try:
            await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=bb.NAV_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            say(f"NAV: {type(e).__name__} (inspecting the page anyway)")
        for _ in range(SMOKE_WAIT_S):
            if await driver._first(EMAIL_SELECTORS) and await driver._first(PASSWORD_SELECTORS):
                say(f"SMOKE: OK login form rendered (title={await page.title()!r})")
                return 0
            await asyncio.sleep(1)
        challenge = await driver._detect_challenge()
        say(f"SMOKE: FAIL login form not rendered after {SMOKE_WAIT_S}s "
            f"(challenge={challenge or 'none'}, title={await page.title()!r})")
        return 1
    except Exception as e:  # noqa: BLE001
        say(f"SMOKE: FAIL {e}")
        return 1
    finally:
        await driver.close()
        say("RELEASED")


async def attended(proxy_url: str | None) -> int:
    email, password = os.environ.get("OF_EMAIL"), os.environ.get("OF_PASSWORD")
    if not email or not password:
        say("LOGIN: FAIL set OF_EMAIL and OF_PASSWORD")
        return 2
    captured: list[browser_login.CapturedLogin] = []

    async def finalize(cap: browser_login.CapturedLogin, _proxy_url: str | None) -> dict:
        captured.append(cap)  # nothing is persisted
        return {}

    job = browser_login.LoginJob(principal="cli", email=email, password=password, proxy_url=proxy_url)
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
    ap.add_argument("--proxy-label", help="a proxy from this upstream's proxies.json")
    args = ap.parse_args()
    if not bb.configured():
        say("LOGIN: FAIL set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID")
        return 2
    proxy_url = proxy_url_for(args.proxy_label)
    return asyncio.run(smoke(proxy_url) if args.smoke else attended(proxy_url))


if __name__ == "__main__":
    sys.exit(main())

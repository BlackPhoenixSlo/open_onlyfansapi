"""The real Chromium `LoginDriver` for the remote-browser login (plan direct-login §C).

Imported lazily by `app` only when a browser login is actually started, and only on a host that
has Playwright + Chromium installed (the slim runtime image does not). It drives OnlyFans' own
login form, detects — but never solves — human challenges, and harvests a captured session.

Nothing here reconstructs OF request signing, pins a TLS fingerprint, or adds anti-automation
stealth: the login goes through a real browser and a human solves any challenge. The harvested
session is signed for ongoing calls by the existing `of_signer.py`, not by anything here.
"""
from __future__ import annotations

import logging

from browser_login import CapturedLogin, Challenge, Observation

log = logging.getLogger("upstream.browser_login.playwright")

LOGIN_URL = "https://onlyfans.com/"
API_RE = "**/api2/v2/**"

# Email/password are found by selector first, then by input type as a fallback.
EMAIL_SELECTORS = ("input[name='email']", "input[type='email']", "input#email")
PASSWORD_SELECTORS = ("input[name='password']", "input[type='password']", "input#password")
SUBMIT_SELECTORS = ("button[type='submit']", "button.g-btn.m-rounded.m-flex")

# Text OnlyFans/Cloudflare show on an interstitial challenge.
CHALLENGE_TEXT = ("just a moment", "verify you are human", "checking your browser")
# Challenge containers, matched in order; the value is the reported challenge kind.
CHALLENGE_SELECTORS = (
    ("[id^='challenge-']", "cloudflare"),
    (".cf-turnstile", "turnstile"),
    ("iframe[src*='challenges.cloudflare.com']", "turnstile"),
    ("iframe[src*='recaptcha']", "recaptcha"),
    ("iframe[src*='hcaptcha']", "hcaptcha"),
    ("iframe[src*='geetest']", "geetest"),
)
# A 2FA / OTP prompt.
OTP_SELECTORS = ("input[name='code']", "input[autocomplete='one-time-code']", "input[name='otp']")


class PlaywrightDriver:
    def __init__(self) -> None:
        self._pw = None
        self._context = None
        self._page = None
        self._last_signed: dict[str, str] | None = None
        self._last_url: str | None = None

    async def launch(self, *, proxy_url: str | None, profile_dir: str) -> None:
        from pathlib import Path

        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        proxy = {"server": proxy_url} if proxy_url else None
        import tempfile

        user_data = Path(tempfile.gettempdir()) / "of-login-profiles" / profile_dir
        user_data.mkdir(parents=True, exist_ok=True)
        # A persistent context keeps the profile per account; headed is best for a human to help.
        self._context = await self._pw.chromium.launch_persistent_context(
            str(user_data), headless=False, proxy=proxy)
        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        self._page.on("request", self._note_request)

    def _note_request(self, request: object) -> None:
        url = getattr(request, "url", "")
        if "/api2/v2/" not in url:
            return
        headers = getattr(request, "headers", {}) or {}
        if headers.get("sign") and headers.get("user-id"):
            self._last_signed = dict(headers)
            self._last_url = url

    async def submit_credentials(self, email: str, password: str) -> None:
        await self._page.goto(LOGIN_URL, wait_until="domcontentloaded")
        await self._fill(EMAIL_SELECTORS, email)
        await self._fill(PASSWORD_SELECTORS, password)
        for sel in SUBMIT_SELECTORS:
            el = await self._page.query_selector(sel)
            if el is not None:
                await el.click()
                return
        await self._page.keyboard.press("Enter")

    async def _fill(self, selectors: tuple[str, ...], value: str) -> None:
        for sel in selectors:
            el = await self._page.query_selector(sel)
            if el is not None:
                await el.fill(value)
                return
        raise RuntimeError("could not find the login field on the page")

    async def observe(self) -> Observation:
        # A challenge first — never solve it, just report it.
        kind = await self._detect_challenge()
        if kind is not None:
            vw = await self._page.evaluate("() => window.innerWidth") or 0
            vh = await self._page.evaluate("() => window.innerHeight") or 0
            return Observation("challenge", Challenge(kind, int(vw), int(vh)))
        for sel in OTP_SELECTORS:
            if await self._page.query_selector(sel) is not None:
                return Observation("otp")
        # Logged in once the auth cookie is set and the page has signed an API call.
        cookies = await self._context.cookies()
        if any(c.get("name") == "auth_id" for c in cookies) and self._last_signed is not None:
            return Observation("ready")
        return Observation("working")

    async def _detect_challenge(self) -> str | None:
        try:
            body = (await self._page.inner_text("body")).lower()
        except Exception:  # noqa: BLE001
            body = ""
        if any(t in body for t in CHALLENGE_TEXT):
            # Prefer a specific container's kind, else report a generic cloudflare interstitial.
            for sel, kind in CHALLENGE_SELECTORS:
                if await self._page.query_selector(sel) is not None:
                    return kind
            return "cloudflare"
        for sel, kind in CHALLENGE_SELECTORS:
            if await self._page.query_selector(sel) is not None:
                return kind
        # Walk every frame for a Turnstile widget hidden behind a closed shadow root.
        for frame in self._page.frames:
            if "challenges.cloudflare.com" in (frame.url or ""):
                return "turnstile"
        return None

    async def screenshot(self) -> tuple[bytes, int, int]:
        png = await self._page.screenshot(type="png")
        vw = int(await self._page.evaluate("() => window.innerWidth") or 0)
        vh = int(await self._page.evaluate("() => window.innerHeight") or 0)
        return png, vw, vh

    async def click(self, x: int, y: int) -> None:
        await self._page.mouse.click(x, y)

    async def type_text(self, text: str) -> None:
        await self._page.keyboard.type(text)

    async def submit_otp(self, code: str) -> None:
        for sel in OTP_SELECTORS:
            el = await self._page.query_selector(sel)
            if el is not None:
                await el.fill(code)
                await self._page.keyboard.press("Enter")
                return
        raise RuntimeError("no 2FA field on the page")

    async def harvest(self) -> CapturedLogin:
        if self._last_signed is None or self._last_url is None:
            raise RuntimeError("no signed /api2/v2 request was captured yet")
        h = self._last_signed
        headers = {
            "user-id": h.get("user-id", ""),
            "x-bc": h.get("x-bc", ""),
            "x-of-rev": h.get("x-of-rev", ""),
            "sign": h.get("sign", ""),
            "time": h.get("time", ""),
            "user-agent": h.get("user-agent", ""),
            "accept-language": h.get("accept-language", ""),
        }
        cookies = await self._context.cookies()
        cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name"))
        static_param = await self._read_static_param()
        return CapturedLogin(url=self._last_url, headers=headers, cookie=cookie,
                             static_param=static_param)

    async def _read_static_param(self) -> str | None:
        # Best-effort: the static_param lives in a webpack module, not on the wire. When it cannot be
        # read, the capture pipeline falls back to a same-revision session or env STATIC_PARAM.
        try:
            return await self._page.evaluate("() => window.__static_param__ || null")
        except Exception:  # noqa: BLE001
            return None

    async def close(self) -> None:
        import contextlib

        for obj, closer in ((self._context, "close"), (self._pw, "stop")):
            if obj is not None:
                with contextlib.suppress(Exception):
                    await getattr(obj, closer)()

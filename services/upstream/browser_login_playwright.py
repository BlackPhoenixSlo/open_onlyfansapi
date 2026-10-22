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

# OnlyFans renders its login form with JS after domcontentloaded (often seconds later on a remote
# browser), so the fields are waited for, never looked up once. Each tuple is one CSS selector list.
EMAIL_SELECTORS = ("input[name='email']", "input[type='email']", "input[autocomplete='username']", "input#email")
PASSWORD_SELECTORS = ("input[name='password']", "input[type='password']", "input#password")
SUBMIT_SELECTORS = ("button[type='submit']",)
# The cookie banner OnlyFans shows some egresses (EU): decline the optional cookies.
COOKIE_ONLY_NECESSARY = "button:has-text('Only necessary cookies')"
NAV_TIMEOUT_MS = 45_000
FORM_WAIT_S = 30          # the login form must show within this
FIELD_TIMEOUT_MS = 5_000  # one fill / read / click attempt
FILL_ATTEMPTS = 3         # fill, then retype key by key, verifying the value each time


class LoginFormError(RuntimeError):
    """OnlyFans' login form could not be filled. The message never carries the typed values."""

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

# OF signs with sha1(static_param + "\n" + time + "\n" + path + "\n" + user_id) from webpack module
# 89668 (js-sha1); static_param is never on the wire. This init script wraps that module as its
# (initial, pre-runtime) chunk is pushed and publishes the first line of a 4-line input as
# `window.__static_param__`, which `harvest()` reads. It only observes: the hash is unchanged.
STATIC_PARAM_HOOK = r"""
(() => {
  const chunks = (self.webpackChunkof_vue = self.webpackChunkof_vue || []);
  const push = chunks.push;
  chunks.push = function (chunk) {
    const mods = chunk && chunk[1];
    const orig = mods && mods[89668];
    if (typeof orig === "function") {
      mods[89668] = function (module, exports, require) {
        orig.call(this, module, exports, require);
        const sha1 = module.exports;
        if (typeof sha1 !== "function") return;
        const wrapped = function (input) {
          try {
            const lines = typeof input === "string" ? input.split("\n") : [];
            if (lines.length === 4 && lines[0]) window.__static_param__ = lines[0];
          } catch (_) {}
          return sha1.apply(this, arguments);
        };
        Object.assign(wrapped, sha1);
        wrapped.prototype = sha1.prototype;
        module.exports = wrapped;
      };
    }
    return push.apply(chunks, arguments);
  };
})();
"""


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
        await self._context.add_init_script(STATIC_PARAM_HOOK)
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
        """Open OnlyFans, wait for its login form, type and verify the email then the password, and
        submit. A page that won't load, a form that never shows, or a field that never takes its value
        fails at once (no typed value in the message) instead of leaving the job on a half-filled form."""
        try:
            await self._page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001 — nothing typed yet; the job scrubs the message anyway
            raise RuntimeError(f"couldn't open OnlyFans in the browser: {str(e).splitlines()[0][:200]}") from None
        await self.fill_login_form(email, password)
        await self.submit_login_form()

    async def fill_login_form(self, email: str, password: str, *, wait_s: float = FORM_WAIT_S) -> None:
        em = self._page.locator(", ".join(EMAIL_SELECTORS)).first
        pw = self._page.locator(", ".join(PASSWORD_SELECTORS)).first
        try:
            await em.wait_for(state="visible", timeout=int(wait_s * 1000))
        except Exception:  # noqa: BLE001
            why = " (a human-verification check is on screen)" if await self._detect_challenge() else ""
            raise LoginFormError(f"the OnlyFans login form did not appear within {wait_s:.0f}s{why}") from None
        await self._dismiss_cookie_banner()
        await _fill_verified(em, email, "email")
        await _fill_verified(pw, password, "password")

    async def _dismiss_cookie_banner(self) -> None:
        # Best effort: the banner does not block the form, it only crowds the view.
        try:
            btn = self._page.locator(COOKIE_ONLY_NECESSARY).first
            if await btn.is_visible():
                await btn.click(timeout=FIELD_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            log.info("declining OnlyFans' optional cookies failed: %s", type(e).__name__)

    async def submit_login_form(self) -> None:
        """Click LOG IN (enabled once both fields hold a value), else press Enter in the password field.
        A failed submit is left to the human watching the browser."""
        try:
            await self._page.locator(", ".join(SUBMIT_SELECTORS)).first.click(timeout=FIELD_TIMEOUT_MS)
            return
        except Exception as e:  # noqa: BLE001
            log.info("clicking OnlyFans' LOG IN failed: %s", type(e).__name__)
        try:
            await self._page.locator(", ".join(PASSWORD_SELECTORS)).first.press("Enter", timeout=FIELD_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            log.info("pressing Enter in OnlyFans' password field failed: %s", type(e).__name__)

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


async def _fill_verified(field, value: str, what: str) -> None:
    """Type `value` into `field` and read it back; when the page swallowed it, clear and type it key by
    key. Raises LoginFormError after FILL_ATTEMPTS. Only exception class names are logged: Playwright's
    messages echo the value."""
    for attempt in range(FILL_ATTEMPTS):
        try:
            if attempt == 0:
                await field.fill(value, timeout=FIELD_TIMEOUT_MS)
            else:
                await field.click(timeout=FIELD_TIMEOUT_MS)
                await field.fill("", timeout=FIELD_TIMEOUT_MS)
                await field.press_sequentially(value, delay=30, timeout=FIELD_TIMEOUT_MS * 4)
            if await field.input_value(timeout=FIELD_TIMEOUT_MS) == value:
                return
        except Exception as e:  # noqa: BLE001
            log.info("filling the OnlyFans %s field, attempt %d: %s", what, attempt + 1, type(e).__name__)
    raise LoginFormError(f"couldn't fill the OnlyFans {what} field — the login form did not take it")

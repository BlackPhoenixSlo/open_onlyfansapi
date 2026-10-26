"""Browserbase login: the session-create body (managed proxies, captcha solver off, 1280x800), a refused
create failing loudly, waiting for and verifying the OnlyFans form, password scrubbing, the live view
on the job, release, and that a success persists through the shared capture pipeline and binds the
proxy the way a pasted cURL does. Browserbase HTTP is faked.

The 2FA code: one code at a time in the job's slot (`otpChecking`), typed then sent, a code still on the
prompt after OTP_VERIFY_S asked for again, a code that can't be typed, leaving the prompt, cancel
between typing and sending, the /otp route's 403/404/409/400, and that the code is never logged, never
in a status or error. The `:visible` field rule, and that only a visible captcha is a challenge (a hidden
leftover one does not mask the 2FA prompt), run on a real headless Chromium when one is installed."""
import asyncio
import io
import json
import logging
import shutil
import subprocess
import urllib.error
from types import SimpleNamespace

import pytest
from conftest import AUTH
from fastapi.testclient import TestClient
from test_browser_login import (  # noqa: F401
    PRINCIPAL,
    FakeDriver,
    PromptDriver,
    _fast,
    _ok_finalize,
    _poll_until,
    _wait_state,
    login_fakes,
)

import app as upstream
import browser_login
import browser_login_browserbase as bb
import proxies
from browser_login import LoginManager, Observation, OtpConflict, State
from browser_login_playwright import OTP_FIELD, LoginFormError, PlaywrightDriver

PROXY_URL = "http://puser:proxy-secret@198.51.100.20:3128"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("BROWSERBASE_API_KEY", "bb_test_key")
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", "proj-1")


@pytest.fixture
def bb_http(monkeypatch):
    """Records Browserbase calls; `refuse` makes the session create answer 402."""
    calls = []
    state = {"refuse": False}

    def fake(path, method="GET", body=None):
        calls.append((method, path, body))
        if path == "/sessions" and method == "POST":
            if state["refuse"]:
                raise bb.BrowserbaseError("Browserbase POST /sessions failed (HTTP 402): upgrade", 402)
            return {"id": "sess-1", "connectUrl": "wss://connect.example.invalid/sess-1"}
        if path.endswith("/debug"):
            return {"debuggerFullscreenUrl": "https://live.example.invalid/sess-1"}
        return {}

    monkeypatch.setattr(bb, "_request", fake)
    return SimpleNamespace(calls=calls, state=state)


# ─── session create / release ──────────────────────────────────────

def test_the_session_runs_on_browserbases_managed_proxies_with_the_solver_off(bb_http):
    session = asyncio.run(bb.create_session())
    assert session["id"] == "sess-1"
    [(method, path, body)] = bb_http.calls
    assert (method, path) == ("POST", "/sessions")
    assert body["projectId"] == "proj-1"
    assert body["proxies"] is True
    assert body["browserSettings"] == {"solveCaptchas": False, "viewport": {"width": 1280, "height": 800}}
    assert body["timeout"] > 600  # outlives the 10-minute job


def test_a_refused_create_fails_loudly_with_no_retry(bb_http):
    bb_http.state["refuse"] = True
    with pytest.raises(bb.BrowserbaseError) as e:
        asyncio.run(bb.create_session())
    assert e.value.status == 402 and "managed proxies" in str(e.value)
    assert len(bb_http.calls) == 1


def test_an_http_error_keeps_its_status(monkeypatch):
    def urlopen(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 402, "Payment Required", {}, io.BytesIO(b'{"error":"upgrade"}'))

    monkeypatch.setattr(bb.urllib.request, "urlopen", urlopen)
    with pytest.raises(bb.BrowserbaseError) as e:
        bb._request("/sessions", "POST", {"proxies": True})
    assert e.value.status == 402 and "upgrade" in str(e.value)


def test_launch_installs_the_static_param_hook_before_any_navigation(bb_http, monkeypatch):
    import playwright.async_api

    events = []

    class Page:
        def on(self, *_):
            pass

    class Context:
        def __init__(self):
            self.pages = [Page()]

        async def add_init_script(self, script):
            events.append(("init", script))

    class Chromium:
        async def connect_over_cdp(self, url):
            events.append(("connect", url))
            return SimpleNamespace(contexts=[Context()])

    class PW:
        chromium = Chromium()

        async def start(self):
            return self

    monkeypatch.setattr(playwright.async_api, "async_playwright", PW)
    asyncio.run(bb.BrowserbaseDriver().launch(proxy_url=PROXY_URL, profile_dir="t"))
    assert events == [("connect", "wss://connect.example.invalid/sess-1"), ("init", bb.STATIC_PARAM_HOOK)]
    # Our proxy is never sent to Browserbase.
    assert "proxy-secret" not in json.dumps(bb_http.calls) and "198.51.100.20" not in json.dumps(bb_http.calls)


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node to run the page script")
def test_the_static_param_hook_reads_the_sha1_input_and_leaves_the_hash_alone():
    # A pre-runtime chunk carrying js-sha1 (module 89668), then webpack running its factory.
    script = bb.STATIC_PARAM_HOOK + r"""
    const sha1 = (s) => "h(" + s + ")";
    sha1.hex = sha1;
    const chunk = [[1], {89668: (module) => { module.exports = sha1; }}];
    self.webpackChunkof_vue.push(chunk);
    const module = {exports: {}};
    self.webpackChunkof_vue[0][1][89668](module, module.exports, null);
    const before = window.__static_param__ || null;
    const out = module.exports("SP-1\n1700000000000\n/api2/v2/users/me\n42");
    module.exports("not\na\nsign");
    console.log(JSON.stringify({before, sp: window.__static_param__, out,
                                hex: module.exports.hex === sha1, len: self.webpackChunkof_vue.length}));
    """
    r = subprocess.run(["node", "-e", "globalThis.window = globalThis.self = globalThis;" + script],
                       capture_output=True, text=True, timeout=30, check=True)
    assert json.loads(r.stdout) == {"before": None, "sp": "SP-1", "hex": True, "len": 1,
                                    "out": "h(SP-1\n1700000000000\n/api2/v2/users/me\n42)"}


def test_close_releases_the_session(bb_http):
    async def scenario():
        d = bb.BrowserbaseDriver()
        d.session_id = "sess-1"
        await d.close()

    asyncio.run(scenario())
    assert ("POST", "/sessions/sess-1", {"projectId": "proj-1", "status": "REQUEST_RELEASE"}) in bb_http.calls


# ─── waiting for, filling and verifying the OnlyFans form ──────────

class _Field:
    """A login input / button. `swallow` fills are dropped by the page (the value stays empty)."""

    def __init__(self, *, visible=True, swallow=0, fail_click=False):
        self.visible, self.swallow, self.fail_click = visible, swallow, fail_click
        self.value, self.actions = "", []

    @property
    def first(self):
        return self

    async def wait_for(self, state, timeout):
        if not self.visible:
            raise TimeoutError(f"waiting for locator timed out ({timeout}ms)")

    async def is_visible(self):
        return self.visible

    async def fill(self, value, timeout=None):
        self.actions.append("fill")
        if value and self.swallow:
            self.swallow -= 1
            return
        self.value = value

    async def press_sequentially(self, value, delay=0, timeout=None):
        self.actions.append("type")
        if self.swallow:
            self.swallow -= 1
            raise RuntimeError(f"typing {value!r} timed out")
        self.value = value

    async def input_value(self, timeout=None):
        return self.value

    async def click(self, timeout=None):
        self.actions.append("click")
        if self.fail_click:
            raise RuntimeError("LOG IN is disabled")

    async def press(self, key, timeout=None):
        self.actions.append(f"press:{key}")


class _FormPage:
    def __init__(self, email, password, *, cookies=None, submit=None, goto_error=None):
        self.email, self.password, self.goto_error = email, password, goto_error
        self.cookies, self.submit = cookies or _Field(visible=False), submit or _Field()

    async def goto(self, url, wait_until=None, timeout=None):
        if self.goto_error:
            raise RuntimeError(self.goto_error)

    def locator(self, sel):
        if "cookies" in sel:
            return self.cookies
        if "submit" in sel:
            return self.submit
        return self.email if "email" in sel else self.password


def _driver(page, challenge=None):
    d = PlaywrightDriver()
    d._page = page

    async def detect():
        return challenge

    d._detect_challenge = detect
    return d


def test_the_form_is_filled_verified_and_submitted_after_declining_cookies():
    email, password = _Field(), _Field(swallow=1)  # the page swallows the first password fill
    page = _FormPage(email, password, cookies=_Field())
    asyncio.run(_driver(page).submit_credentials("e@x.test", "hunter2"))
    assert (email.value, password.value) == ("e@x.test", "hunter2")
    assert password.actions == ["fill", "click", "fill", "type"]  # retyped key by key
    assert page.cookies.actions == ["click"] and page.submit.actions == ["click"]


def test_a_disabled_log_in_button_falls_back_to_enter():
    password = _Field()
    page = _FormPage(_Field(), password, submit=_Field(fail_click=True))
    asyncio.run(_driver(page).submit_credentials("e@x.test", "hunter2"))
    assert password.actions[-1] == "press:Enter"


def test_a_form_that_never_shows_fails_fast_and_names_the_challenge():
    page = _FormPage(_Field(visible=False), _Field())
    with pytest.raises(LoginFormError, match="did not appear within 0s .a human-verification check"):
        asyncio.run(_driver(page, challenge="turnstile").fill_login_form("e@x.test", "hunter2", wait_s=0))


def test_a_field_that_never_takes_its_value_fails_without_logging_the_password(caplog):
    password = _Field(swallow=99)
    with caplog.at_level(logging.DEBUG), pytest.raises(LoginFormError) as e:
        asyncio.run(_driver(_FormPage(_Field(), password)).submit_credentials("e@x.test", "hunter2"))
    assert "password field" in str(e.value) and password.actions.count("click") == 2  # 3 attempts
    assert "hunter2" not in caplog.text and "hunter2" not in str(e.value)


def test_a_page_that_wont_load_fails_before_anything_is_typed():
    email = _Field()
    page = _FormPage(email, _Field(), goto_error="net::ERR_TIMED_OUT at https://onlyfans.com/\nCall log: …")
    with pytest.raises(RuntimeError, match="couldn't open OnlyFans in the browser: net::ERR_TIMED_OUT"):
        asyncio.run(_driver(page).submit_credentials("e@x.test", "hunter2"))
    assert email.actions == []


# ─── HTTP route: backend=browserbase, a proxy label, success persist + bind ─

class BBFakeDriver(FakeDriver):
    def __init__(self, script, *, fail_with=None):
        super().__init__(script)
        self.live_view_url = "https://live.example.invalid/sess-1"
        self.fail_with = fail_with

    async def submit_credentials(self, email, password):
        await super().submit_credentials(email, password)
        if self.fail_with:
            raise RuntimeError(self.fail_with.format(password=password))


@pytest.fixture
def bb_client(login_fakes, monkeypatch):  # noqa: F811
    holder = {}
    monkeypatch.setattr(upstream, "_browserbase_driver", lambda: holder["driver"])
    with TestClient(upstream.app) as c:
        c.holder = holder
        yield c


def _start(client, **body):
    return client.post("/login/browser/start", headers={**AUTH, **PRINCIPAL},
                       json={"email": "e@x.test", "password": "hunter2", "backend": "browserbase", **body})


def test_success_persists_and_binds_the_chosen_proxy(bb_client):
    proxies.upsert({"label": "res-1", "scheme": "http", "host": "198.51.100.20", "port": 3128,
                    "username": "puser", "password": "proxy-secret"})
    driver = BBFakeDriver([Observation("working"), Observation("ready")])
    bb_client.holder["driver"] = driver
    r = _start(bb_client, proxy_label="res-1")
    assert r.status_code == 200, r.text
    assert "hunter2" not in r.text and "proxy-secret" not in r.text
    snap = _poll_until(bb_client, r.json()["jobId"], "done")
    assert snap["liveViewUrl"] == "https://live.example.invalid/sess-1"
    assert "proxyFallback" not in snap
    assert proxies.get_for_account("100001")["label"] == "res-1"
    assert proxies.get_by_label("acct-100001") is None
    assert driver.closed is True


def test_start_without_a_proxy_is_allowed_when_not_required(bb_client, monkeypatch):
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    bb_client.holder["driver"] = BBFakeDriver([Observation("working"), Observation("ready")])
    r = _start(bb_client)
    assert r.status_code == 200, r.text
    _poll_until(bb_client, r.json()["jobId"], "done")
    assert proxies.get_for_account("100001") is None


def test_a_re_login_without_a_proxy_keeps_the_accounts_proxy(bb_client, monkeypatch):
    # Like a pasted cURL with no proxy: the account stays on (and is validated through) its proxy.
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    proxies.upsert({"label": "res-1", "scheme": "http", "host": "198.51.100.20", "port": 3128})
    proxies.assign_account("res-1", "100001")
    bb_client.holder["driver"] = BBFakeDriver([Observation("working"), Observation("ready")])
    r = _start(bb_client)
    _poll_until(bb_client, r.json()["jobId"], "done")
    assert proxies.get_for_account("100001")["label"] == "res-1"
    assert proxies.get_by_label("acct-100001") is None


def test_a_failure_never_surfaces_the_password(bb_client, caplog):
    proxies.upsert({"label": "res-1", "scheme": "http", "host": "198.51.100.20", "port": 3128})
    bb_client.holder["driver"] = BBFakeDriver([Observation("working")], fail_with="typing {password} failed")
    with caplog.at_level(logging.DEBUG):
        r = _start(bb_client, proxy_label="res-1")
        snap = _poll_until(bb_client, r.json()["jobId"], "error")
    assert snap["error"] == "typing *** failed"
    assert "hunter2" not in caplog.text and "hunter2" not in str(snap)


def test_start_validates_the_proxy_label_and_the_browserbase_env(bb_client, monkeypatch):
    bb_client.holder["driver"] = BBFakeDriver([Observation("working")])
    r = _start(bb_client, proxy_label="nope")
    assert (r.status_code, r.json()["error"]["code"]) == (404, "proxy_not_found")
    r = _start(bb_client, proxy_label="x", proxy=PROXY_URL)
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_proxy")
    monkeypatch.delenv("BROWSERBASE_API_KEY")
    r = _start(bb_client, proxy=PROXY_URL)
    assert (r.status_code, r.json()["error"]["code"]) == (503, "browserbase_not_configured")


# ─── the 2FA code ──────────────────────────────────────────────────

CODE = "739218"
WRONG = "104857"


def _otp_job(driver):
    mgr = LoginManager(lambda: driver, _ok_finalize)
    return mgr.start(principal="t", email="e", password="pw", proxy_url=None)


async def _until(pred, tries=5000):
    for _ in range(tries):
        if pred():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never held")


def test_a_code_is_typed_then_sent_and_the_status_says_checking_never_the_code(caplog):
    async def scenario():
        driver = PromptDriver(CODE)
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        snap = job.snapshot()
        assert (snap["needsOtp"], snap["otpChecking"], snap["otpError"]) == (True, False, None)
        job.submit_otp("739 218")  # spaces (and dashes) are dropped
        snap = job.snapshot()
        assert (snap["state"], snap["otpChecking"], snap["message"]) == ("otp", True, browser_login.OTP_CHECKING)
        assert CODE not in json.dumps(snap)
        await job._task
        assert driver.otps == [CODE, "<send>"]
        assert job.state is State.DONE and job.snapshot()["otpChecking"] is False

    with caplog.at_level(logging.DEBUG):
        asyncio.run(scenario())
    assert CODE not in caplog.text


@pytest.mark.parametrize("raw", ["12345", "123456789", "12a456", "", "１２３４５６", "123_456"])
def test_a_malformed_code_is_refused_without_echoing_it(raw):
    async def scenario():
        job = _otp_job(PromptDriver(CODE))
        await _wait_state(job, State.OTP)
        with pytest.raises(ValueError) as e:
            job.submit_otp(raw)
        assert str(e.value) == "the 2FA code is 6 to 8 digits"
        assert job.snapshot()["otpChecking"] is False
        await job.cancel()

    asyncio.run(scenario())


def test_dashes_are_dropped_and_eight_digits_are_fine():
    async def scenario():
        driver = PromptDriver("12345678")
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        job.submit_otp("1234-5678")
        await job._task
        assert driver.otps[0] == "12345678" and job.state is State.DONE

    asyncio.run(scenario())


def test_one_code_at_a_time_and_only_on_the_prompt():
    async def scenario():
        driver = FakeDriver([Observation("working")])
        job = _otp_job(driver)
        await _wait_state(job, State.TYPING)
        with pytest.raises(OtpConflict, match=r"not waiting for a 2FA code \(state: typing\)"):
            job.submit_otp(CODE)
        await job.cancel()

        driver = PromptDriver(CODE)
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        job.submit_otp(WRONG)
        with pytest.raises(OtpConflict, match="already being checked") as e:
            job.submit_otp(CODE)
        assert CODE not in str(e.value) and WRONG not in str(e.value)
        await job.cancel()

    asyncio.run(scenario())


def test_a_code_still_on_the_prompt_after_the_verify_timeout_is_asked_again(monkeypatch):
    monkeypatch.setattr(browser_login, "OTP_VERIFY_S", 0)

    async def scenario():
        driver = PromptDriver(CODE)
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        job.submit_otp(WRONG)
        await _until(lambda: job.snapshot()["otpError"] is not None)
        snap = job.snapshot()
        assert (snap["state"], snap["otpChecking"], snap["message"], snap["otpError"]) == (
            "otp", False, browser_login.OTP_REJECTED, browser_login.OTP_REJECTED)
        assert snap["otpError"] == "OnlyFans didn't accept that code (or hasn't answered yet) — try again"
        job.submit_otp(CODE)  # the slot is free again
        assert job.snapshot()["otpError"] is None
        await job._task
        assert driver.otps == [WRONG, "<send>", CODE, "<send>"] and job.state is State.DONE

    asyncio.run(scenario())


def test_a_code_that_cant_be_typed_says_so_and_frees_the_slot(caplog):
    async def scenario():
        driver = PromptDriver(CODE, type_error="locator.fill: Timeout 2000ms exceeded — fill('{code}')")
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        job.submit_otp(CODE)
        await _until(lambda: job.snapshot()["otpError"] is not None)
        snap = job.snapshot()
        assert (snap["state"], snap["otpChecking"], snap["otpError"]) == ("otp", False, browser_login.OTP_NOT_TYPED)
        driver.type_error = None
        job.submit_otp(CODE)
        await job._task
        assert job.state is State.DONE

    with caplog.at_level(logging.DEBUG):
        asyncio.run(scenario())
    assert CODE not in caplog.text and "RuntimeError" in caplog.text


def test_leaving_the_prompt_empties_the_slot_and_a_prompt_that_comes_back_asks_at_once():
    async def scenario():
        driver = FakeDriver([Observation("otp")])
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        # A code waits in the slot, but the page moves on before the worker takes it.
        driver.script = [Observation("working")]
        job.submit_otp(CODE)
        await _wait_state(job, State.TYPING)
        snap = job.snapshot()
        assert (snap["needsOtp"], snap["otpChecking"]) == (False, False)
        assert job._take_otp() is None and driver.otps == []
        # The prompt is back: otp right away, asking for a code.
        driver.script = [Observation("otp")]
        await _wait_state(job, State.OTP)
        assert job.message == browser_login.OTP_ASK and job.snapshot()["needsOtp"] is True
        job.submit_otp(CODE)  # accepted: the slot was emptied
        await job.cancel()

    asyncio.run(scenario())


def test_a_prompt_back_soon_after_a_code_was_sent_says_it_was_refused():
    async def scenario():
        driver = FakeDriver([Observation("otp")])
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        job.submit_otp(WRONG)
        await _until(lambda: driver.otps == [WRONG, "<send>"])
        driver.script = [Observation("working")]  # OnlyFans' spinner
        await _wait_state(job, State.TYPING)
        driver.script = [Observation("otp")]  # and the prompt again
        await _wait_state(job, State.OTP)
        snap = job.snapshot()
        assert (snap["otpError"], snap["message"], snap["otpChecking"]) == (
            browser_login.OTP_REJECTED, browser_login.OTP_REJECTED, False)
        await job.cancel()

    asyncio.run(scenario())


def test_no_code_is_taken_once_the_page_has_left_the_prompt():
    async def scenario():
        driver = FakeDriver([Observation("otp")])
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        observe, gate = driver.observe, asyncio.Event()

        async def observe_then_slow_frame():
            obs = await observe()
            if obs.kind == "working":
                gate.set()
            return obs

        driver.observe = observe_then_slow_frame
        refresh = job._refresh_frame

        async def slow_refresh(d):
            if gate.is_set():
                await asyncio.sleep(0.2)  # a Browserbase screenshot takes a while
            await refresh(d)

        job._refresh_frame = slow_refresh
        driver.script = [Observation("working")]
        await gate.wait()
        await asyncio.sleep(0)
        with pytest.raises(browser_login.OtpConflict):  # the worker saw the page move on: no 200 for a lost code
            job.submit_otp(CODE)
        await job.cancel()

    asyncio.run(scenario())


def test_a_text_input_queued_while_the_code_is_typed_is_not_applied_before_the_submit():
    async def scenario():
        driver = PromptDriver(CODE)
        job = _otp_job(driver)
        typed = driver.type_otp

        async def type_then_queue(code):
            await typed(code)
            job.submit_input({"type": "text", "text": "x"})

        async def type_text(text):
            driver.otps.append(f"<text {text}>")

        driver.type_otp, driver.type_text = type_then_queue, type_text
        await _wait_state(job, State.OTP)
        job.submit_otp(CODE)
        await job._task
        assert driver.otps == [CODE, "<send>", "<text x>"]  # the submit came first; the text waited its turn

    asyncio.run(scenario())


def test_a_cancel_between_typing_and_sending_stops_before_the_submit():
    async def scenario():
        driver = PromptDriver(CODE)
        job = _otp_job(driver)
        typed = driver.type_otp

        async def type_then_cancel(code):
            await typed(code)
            job.submit_input({"type": "cancel"})

        driver.type_otp = type_then_cancel
        await _wait_state(job, State.OTP)
        job.submit_otp(CODE)
        await job._task
        assert job.state is State.CANCELLED
        assert driver.otps == [CODE] and driver.closed is True  # never sent

    asyncio.run(scenario())


def test_every_code_is_scrubbed_from_a_job_error(caplog, monkeypatch):
    monkeypatch.setattr(browser_login, "OTP_VERIFY_S", 0)

    async def scenario():
        driver = PromptDriver(CODE)

        async def harvest():
            raise RuntimeError(f"capture failed: field held {WRONG}, then {CODE}")

        driver.harvest = harvest
        job = _otp_job(driver)
        await _wait_state(job, State.OTP)
        job.submit_otp(WRONG)
        await _until(lambda: job.snapshot()["otpError"] is not None)
        job.submit_otp(CODE)
        await job._task
        return job

    with caplog.at_level(logging.DEBUG):
        job = asyncio.run(scenario())
    assert job.state is State.ERROR and job.error == "capture failed: field held ***, then ***"
    for code in (CODE, WRONG):
        assert code not in caplog.text and code not in json.dumps(job.snapshot())


def test_an_expired_job_takes_no_code(bb_client, monkeypatch):
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    bb_client.holder["driver"] = BBPromptDriver(CODE)
    job_id = _start(bb_client).json()["jobId"]
    _poll_until(bb_client, job_id, "otp")
    job = upstream.login_manager.get(job_id, PRINCIPAL["x-login-principal"])
    job.deadline = 0  # past its time; the worker has not marked it yet
    r = _otp(bb_client, job_id, {"code": CODE})
    assert (r.status_code, r.json()["error"]["code"]) == (404, "job_not_found")
    assert job._otp_code is None and CODE not in r.text


# ─── the driver: only a visible field counts, and its own form is submitted ─

class _OtpPage:
    def __init__(self, field):
        self.field, self.selectors = field, []

    def locator(self, sel):
        self.selectors.append(sel)
        return self.field


class _FormField(_Field):
    """The 2FA field; `buttons` is how many visible submit buttons its own form has."""

    def __init__(self, buttons=1, **kw):
        super().__init__(**kw)
        self.buttons, self.form_selectors = buttons, []

    def locator(self, sel):
        self.form_selectors.append(sel)
        return self

    async def count(self):
        return self.buttons


def test_the_otp_selectors_are_visible_only():
    assert OTP_FIELD == ("input[name='code']:visible, input[autocomplete='one-time-code']:visible, "
                         "input[name='otp']:visible")


def test_typing_reads_the_code_back_and_never_puts_it_in_the_error():
    page = _OtpPage(_Field(swallow=1))
    with pytest.raises(RuntimeError) as e:
        asyncio.run(_driver(page).type_otp(CODE))
    assert CODE not in str(e.value) and page.selectors == [OTP_FIELD]
    page = _OtpPage(_Field())
    asyncio.run(_driver(page).type_otp(CODE))
    assert page.field.value == CODE


def test_send_clicks_the_2fa_forms_own_visible_submit_else_presses_enter():
    field = _FormField()
    asyncio.run(_driver(_OtpPage(field)).send_otp())
    assert field.form_selectors == ["xpath=ancestor::form", "button[type='submit']:visible"]
    assert field.actions == ["click"]
    field = _FormField(buttons=0)
    asyncio.run(_driver(_OtpPage(field)).send_otp())
    assert field.actions == ["press:Enter"]
    field = _FormField(visible=False)  # it submitted itself on the last digit
    asyncio.run(_driver(_OtpPage(field)).send_otp())
    assert field.actions == []


def test_a_field_that_submits_itself_on_the_last_digit_counts_as_typed():
    class Gone(_Field):
        async def input_value(self, timeout=None):
            self.visible = False
            raise TimeoutError("waiting for locator")

    asyncio.run(_driver(_OtpPage(Gone())).type_otp(CODE))  # no error: the code went in
    class Stuck(Gone):
        async def input_value(self, timeout=None):
            raise TimeoutError(f"waiting for locator to have value {CODE}")

    with pytest.raises(RuntimeError) as e:
        asyncio.run(_driver(_OtpPage(Stuck())).type_otp(CODE))
    assert CODE not in str(e.value)


def _chromium_or_skip():
    try:
        from playwright.async_api import async_playwright  # noqa: F401
    except ImportError:
        pytest.skip("needs playwright")


TWO_FORMS = """
<form id="login" onsubmit="event.preventDefault(); window.submitted.push('login')">
  <input name="email"><button type="submit">LOG IN</button></form>
<form id="otp" onsubmit="event.preventDefault(); window.submitted.push('otp:' + this.querySelector('#real').value)">
  <input name="code" id="stale" style="display:none" value="">
  <input name="code" id="real" autocomplete="one-time-code"><button type="submit">Verify</button></form>
<script>window.submitted = []</script>
"""


def test_on_a_real_page_a_hidden_stale_input_is_neither_the_prompt_nor_the_fill_target():
    _chromium_or_skip()
    from playwright.async_api import async_playwright

    async def scenario():
        async with async_playwright() as pw:
            try:
                browser = await pw.chromium.launch(headless=True)
            except Exception as e:  # noqa: BLE001
                pytest.skip(f"no Chromium: {type(e).__name__}")
            page = await browser.new_page()
            d = PlaywrightDriver()
            d._page = page
            await page.set_content('<input name="code" style="display:none">')
            assert await d._otp_visible() is False
            await page.set_content(TWO_FORMS)
            assert await d._otp_visible() is True
            await d.type_otp(CODE)
            await d.send_otp()
            out = await page.evaluate(
                "() => [document.querySelector('#stale').value, document.querySelector('#real').value, window.submitted]")
            await browser.close()
            return out

    stale, real, submitted = asyncio.run(scenario())
    assert (stale, real) == ("", CODE)
    assert submitted == [f"otp:{CODE}"]  # the 2FA form, not the page's first (login) form


RECAPTCHA = "https://www.google.com/recaptcha/api2/bframe"
RECAPTCHA_ANCHOR = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=site-key"
HCAPTCHA = "https://newassets.hcaptcha.com/captcha/v1/frame"
TURNSTILE = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile"
OUTER = "https://frames.example.invalid/outer"  # serves a visible Turnstile frame: a captcha one frame down
OTP_PROMPT = '<form><input name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form>'


def _shadow_frame(style):
    """A Turnstile frame behind a closed shadow root: no selector reaches it, only `page.frames`."""
    return ('<div id="host"></div><script>document.getElementById("host").attachShadow({mode: "closed"})'
            f'.innerHTML = \'<iframe src="{TURNSTILE}" style="{style}"></iframe>\'</script>')


# The same captchas, left over hidden in the ways a page hides one, then on screen.
HIDDEN_CAPTCHAS = (
    f'<iframe src="{RECAPTCHA}" style="display:none"></iframe>',
    f'<div style="visibility:hidden;position:absolute;top:-10000px"><iframe src="{RECAPTCHA}"></iframe></div>',
    f'<iframe src="{HCAPTCHA}" width="0" height="0" style="border:0"></iframe>',
    '<div class="cf-turnstile" hidden>widget</div>',
    '<div id="challenge-stage" style="display:none">check</div>',
    _shadow_frame("display:none"),
    '<p style="display:none">Verify you are human</p>',
    f'<iframe src="{OUTER}" style="visibility:hidden" width="400" height="200"></iframe>',
    f'<iframe src="{OUTER}" width="0" height="0" style="border:0"></iframe>',
    # reCAPTCHA's invisible badge, styled as Google styles it: on screen to Playwright, but never a challenge (a real
    # one opens the bframe).
    ('<div class="grecaptcha-badge" style="width:256px;height:60px;position:fixed;bottom:14px;right:-186px;'
     f'box-shadow:gray 0 0 5px"><iframe src="{RECAPTCHA_ANCHOR}&size=invisible" width="256" height="60"></iframe></div>'),
)
VISIBLE_CAPTCHAS = (
    (f'<iframe src="{RECAPTCHA}"></iframe>', "recaptcha"),
    (f'<iframe src="{HCAPTCHA}" width="300" height="150"></iframe>', "hcaptcha"),
    ('<div class="cf-turnstile">widget</div>', "turnstile"),
    ('<div id="challenge-stage">check</div>', "cloudflare"),
    (_shadow_frame("width:300px;height:65px"), "turnstile"),
    (f'<iframe src="{RECAPTCHA_ANCHOR}&size=normal" width="304" height="78"></iframe>', "recaptcha"),
    ('<p>Verify you are human</p><div class="cf-turnstile" hidden>widget</div>', "cloudflare"),
    (f'<iframe src="{OUTER}" width="400" height="200"></iframe>', "turnstile"),
)


def test_on_a_real_page_a_hidden_leftover_captcha_does_not_mask_the_2fa_prompt():
    _chromium_or_skip()
    from playwright.async_api import async_playwright

    async def scenario():
        async with async_playwright() as pw:
            try:
                browser = await pw.chromium.launch(headless=True)
            except Exception as e:  # noqa: BLE001
                pytest.skip(f"no Chromium: {type(e).__name__}")
            page = await browser.new_page()
            await page.route("**/*", lambda route: route.fulfill(
                body=f'<iframe src="{TURNSTILE}" width="300" height="65"></iframe>' if route.request.url == OUTER
                else "<p>captcha</p>", content_type="text/html"))
            d = PlaywrightDriver()
            d._page = page
            seen = {}
            for html in HIDDEN_CAPTCHAS + tuple(h for h, _ in VISIBLE_CAPTCHAS):
                await page.set_content(html + OTP_PROMPT)
                obs = await d.observe()
                # The captcha is really there (a frame, a container, or the text), hidden or not.
                in_dom = len(page.frames) > 1 or bool(await page.query_selector(".cf-turnstile, [id^='challenge-']")) \
                    or "verify you are human" in (await page.content()).lower()
                seen[html] = (obs.kind, obs.challenge.kind if obs.challenge else None, in_dom)
            await browser.close()
            return seen

    seen = asyncio.run(scenario())
    assert {html: seen[html] for html in HIDDEN_CAPTCHAS} == {html: ("otp", None, True) for html in HIDDEN_CAPTCHAS}
    # A captcha on screen is still the challenge (live view), even with the code field next to it.
    assert {html: seen[html] for html, _ in VISIBLE_CAPTCHAS} == \
        {html: ("challenge", kind, True) for html, kind in VISIBLE_CAPTCHAS}


# ─── HTTP: POST /login/browser/{id}/otp ────────────────────────────

class BBPromptDriver(PromptDriver):
    def __init__(self, right):
        super().__init__(right)
        self.live_view_url = "https://live.example.invalid/sess-1"


def _otp(client, job_id, body, principal=PRINCIPAL, raw=None):
    kw = {"content": raw, "headers": {**AUTH, **principal, "content-type": "application/json"}} if raw is not None \
        else {"json": body, "headers": {**AUTH, **principal}}
    return client.post(f"/login/browser/{job_id}/otp", **kw)


def test_the_otp_route_checks_the_owner_the_job_and_the_code_and_never_echoes_it(bb_client, monkeypatch, caplog):
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    bb_client.holder["driver"] = BBPromptDriver(CODE)
    job_id = _start(bb_client).json()["jobId"]
    _poll_until(bb_client, job_id, "otp")
    seen = []
    with caplog.at_level(logging.DEBUG):
        r = _otp(bb_client, "no-such-job", {"code": CODE})
        seen.append(r.text)
        assert (r.status_code, r.json()["error"]["code"]) == (404, "job_not_found")
        r = _otp(bb_client, job_id, {"code": CODE}, principal={"x-login-principal": "team-2"})
        seen.append(r.text)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "job_forbidden")
        for body, raw in (({"code": "73921"}, None), ({"code": "73a218"}, None), ({"code": 739218}, None),
                          ({"otp": CODE}, None), ([CODE], None), (None, CODE), (None, "{not json " + CODE),
                          (None, "[" * 100_000 + CODE)):
            r = _otp(bb_client, job_id, body, raw=raw)
            seen.append(r.text)
            assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_otp"), (body, raw, r.text)
        # Hold the worker off the slot so a second code meets the one in flight.
        with pytest.MonkeyPatch.context() as hold:
            hold.setattr(browser_login.LoginJob, "_take_otp", lambda self: None)
            r = _otp(bb_client, job_id, {"code": "739-218"})
            seen.append(r.text)
            assert r.status_code == 200 and r.json()["otpChecking"] is True and r.json()["state"] == "otp"
            r = _otp(bb_client, job_id, {"code": WRONG})
            seen.append(r.text)
            assert (r.status_code, r.json()["error"]["code"]) == (409, "otp_not_expected")
            seen.append(bb_client.get(f"/login/browser/{job_id}", headers={**AUTH, **PRINCIPAL}).text)
        snap = _poll_until(bb_client, job_id, "done")
        seen.append(json.dumps(snap))
        r = _otp(bb_client, job_id, {"code": CODE})
        seen.append(r.text)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "otp_not_expected")
    for text in seen:
        assert CODE not in text and WRONG not in text, text
    assert CODE not in caplog.text and WRONG not in caplog.text


def test_input_no_longer_takes_a_code(bb_client, monkeypatch):
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    bb_client.holder["driver"] = BBPromptDriver(CODE)
    job_id = _start(bb_client).json()["jobId"]
    _poll_until(bb_client, job_id, "otp")
    r = bb_client.post(f"/login/browser/{job_id}/input", headers={**AUTH, **PRINCIPAL},
                       json={"type": "otp", "code": CODE})
    assert r.status_code == 422

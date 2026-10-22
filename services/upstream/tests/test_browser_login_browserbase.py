"""Browserbase login: the session-create body (managed proxies, captcha solver off, 1280x800), a refused
create failing loudly, waiting for and verifying the OnlyFans form, password scrubbing, the live view
on the job, release, and that a success persists through the shared capture pipeline and binds the
proxy the way a pasted cURL does. Browserbase HTTP is faked."""
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
    _fast,
    _poll_until,
    login_fakes,
)

import app as upstream
import browser_login_browserbase as bb
import proxies
from browser_login import Observation
from browser_login_playwright import LoginFormError, PlaywrightDriver

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

"""Browserbase login: the session-create body (external proxy, captcha solver off), the 402 → no-proxy
fallback, password scrubbing, live view + fallback on the job, release, and that a success persists
through the shared capture pipeline and binds the chosen (labelled) proxy. Browserbase HTTP is faked."""
import asyncio
import io
import logging
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

PROXY_URL = "http://puser:proxy-secret@198.51.100.20:3128"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("BROWSERBASE_API_KEY", "bb_test_key")
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", "proj-1")


@pytest.fixture
def bb_http(monkeypatch):
    """Records Browserbase calls; `refuse_proxy` makes a proxied session-create answer 402."""
    calls = []
    state = {"refuse_proxy": False}

    def fake(path, method="GET", body=None, secrets=()):
        calls.append((method, path, body))
        if path == "/sessions" and method == "POST":
            if body.get("proxies") and state["refuse_proxy"]:
                raise bb.BrowserbaseError("Browserbase POST /sessions failed (HTTP 402): upgrade", 402)
            return {"id": "sess-1", "connectUrl": "wss://connect.example.invalid/sess-1"}
        if path.endswith("/debug"):
            return {"debuggerFullscreenUrl": "https://live.example.invalid/sess-1"}
        return {}

    monkeypatch.setattr(bb, "_request", fake)
    return SimpleNamespace(calls=calls, state=state)


# ─── session create / fallback / release ───────────────────────────

def test_a_proxy_goes_to_browserbase_as_an_external_proxy_with_the_solver_off(bb_http):
    session, status, fell_back = asyncio.run(bb.create_session(PROXY_URL))
    assert (session["id"], status, fell_back) == ("sess-1", None, False)
    [(method, path, body)] = bb_http.calls
    assert (method, path) == ("POST", "/sessions")
    assert body["projectId"] == "proj-1"
    assert body["browserSettings"] == {"solveCaptchas": False}
    assert body["proxies"] == [{"type": "external", "server": "http://198.51.100.20:3128",
                                "username": "puser", "password": "proxy-secret"}]
    assert body["timeout"] > 600  # outlives the 10-minute job


def test_a_refused_proxy_falls_back_to_a_session_without_proxies(bb_http):
    bb_http.state["refuse_proxy"] = True
    session, status, fell_back = asyncio.run(bb.create_session(PROXY_URL))
    assert (session["id"], status, fell_back) == ("sess-1", 402, True)
    first, second = bb_http.calls
    assert first[2]["proxies"] and "proxies" not in second[2]
    assert second[2]["browserSettings"] == {"solveCaptchas": False}


def test_no_proxy_creates_a_session_without_proxies(bb_http):
    _, _, fell_back = asyncio.run(bb.create_session(None))
    assert fell_back is False and "proxies" not in bb_http.calls[0][2]


def test_an_http_error_never_carries_the_proxy_password(monkeypatch):
    def urlopen(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 402, "Payment Required", {},
                                     io.BytesIO(b'{"error":"proxy http://puser:proxy-secret@x refused"}'))

    monkeypatch.setattr(bb.urllib.request, "urlopen", urlopen)
    with pytest.raises(bb.BrowserbaseError) as e:
        bb._request("/sessions", "POST", {"proxies": []}, ("proxy-secret",))
    assert e.value.status == 402
    assert "proxy-secret" not in str(e.value)


def test_close_releases_the_session(bb_http):
    async def scenario():
        d = bb.BrowserbaseDriver()
        d.session_id = "sess-1"
        await d.close()

    asyncio.run(scenario())
    assert ("POST", "/sessions/sess-1", {"projectId": "proj-1", "status": "REQUEST_RELEASE"}) in bb_http.calls


# ─── form filling never leaks the password ─────────────────────────

class _Field:
    def __init__(self, fail=False):
        self.fail, self.value = fail, None

    async def fill(self, value):
        if self.fail:
            raise RuntimeError(f"fill({value!r}) timed out")
        self.value = value

    async def click(self):
        pass

    async def press(self, key):
        pass


class _Page:
    def __init__(self, fields):
        self.fields = fields

    async def query_selector(self, sel):
        return self.fields.get(sel)


def test_the_form_is_filled_once_it_renders_and_a_failure_never_logs_the_password(caplog):
    async def scenario():
        d = bb.BrowserbaseDriver()
        d._pending = ("e@x.test", "hunter2")
        d._page = _Page({})  # a challenge is up: no form yet
        await d._try_fill()
        assert d._pending is not None
        d._page = _Page({"input[name='email']": _Field(), "input[name='password']": _Field(fail=True)})
        with caplog.at_level(logging.DEBUG):
            await d._try_fill()
        assert d._page.fields["input[name='email']"].value == "e@x.test"
        assert d._pending is not None  # the password fill failed: try again on the next observe
        good_pw = _Field()
        d._page = _Page({"input[name='email']": _Field(), "input[name='password']": good_pw})
        await d._try_fill()
        assert good_pw.value == "hunter2" and d._pending is None

    asyncio.run(scenario())
    assert "hunter2" not in caplog.text


# ─── HTTP route: backend=browserbase, a proxy label, success persist + bind ─

class BBFakeDriver(FakeDriver):
    def __init__(self, script, *, fallback=False, fail_with=None):
        super().__init__(script)
        self.live_view_url = "https://live.example.invalid/sess-1"
        self.proxy_fallback = fallback
        self.proxy_fallback_status = 402 if fallback else None
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


@pytest.mark.parametrize("fallback", [False, True])
def test_success_persists_and_binds_the_chosen_proxy_even_after_a_fallback(bb_client, fallback):
    proxies.upsert({"label": "res-1", "scheme": "http", "host": "198.51.100.20", "port": 3128,
                    "username": "puser", "password": "proxy-secret"})
    driver = BBFakeDriver([Observation("working"), Observation("ready")], fallback=fallback)
    bb_client.holder["driver"] = driver
    r = _start(bb_client, proxy_label="res-1")
    assert r.status_code == 200, r.text
    assert "hunter2" not in r.text and "proxy-secret" not in r.text
    snap = _poll_until(bb_client, r.json()["jobId"], "done")
    assert snap["liveViewUrl"] == "https://live.example.invalid/sess-1"
    assert (snap["proxyFallback"], snap["proxyFallbackStatus"]) == (fallback, 402 if fallback else None)
    # The browser was asked to use the chosen proxy; the account is bound to that label.
    assert driver.launched[0] == PROXY_URL
    assert proxies.get_for_account("100001")["label"] == "res-1"
    assert proxies.get_by_label("acct-100001") is None
    assert driver.closed is True


def test_start_without_a_proxy_is_allowed_when_not_required(bb_client, monkeypatch):
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    bb_client.holder["driver"] = BBFakeDriver([Observation("working"), Observation("ready")])
    r = _start(bb_client)
    assert r.status_code == 200, r.text
    _poll_until(bb_client, r.json()["jobId"], "done")


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

"""Remote-browser login (plan direct-login §C): the job state machine, ownership, expiry, the
input channel, the SSE stream, and that a captured login flows through the SAME capture pipeline a
pasted cURL uses (`session_commit.commit_captured_session`)."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from conftest import AUTH, make_account
from fastapi.testclient import TestClient

import accounts
import app as upstream
import browser_login
import client_pool
import proxies
import session_bootstrap
from browser_login import CapturedLogin, Challenge, LoginManager, Observation, State
from of_client import OFClient


class FakeDriver:
    """A scripted stand-in for the real Chromium driver. `script` is the observations it returns in
    order (staying on the last). Never touches a network or a browser."""

    def __init__(self, script):
        self.script = list(script)
        self.launched = None
        self.credentials = None
        self.clicks = []
        self.texts = []
        self.otps = []
        self.closed = False
        self.captured = CapturedLogin(
            url="https://onlyfans.com/api2/v2/users/me",
            headers={"user-id": "100001", "x-bc": "bc", "x-of-rev": "rev", "sign": "s:a:b:e",
                     "time": "1700000000000", "user-agent": "UA", "accept-language": "en"},
            cookie="sess=secret-cookie", static_param="sp")

    async def launch(self, *, proxy_url, profile_dir):
        self.launched = (proxy_url, profile_dir)

    async def submit_credentials(self, email, password):
        self.credentials = (email, password)

    async def observe(self):
        return self.script.pop(0) if len(self.script) > 1 else self.script[0]

    async def screenshot(self):
        return (b"PNGBYTES", 320, 240)

    async def click(self, x, y):
        self.clicks.append((x, y))

    async def type_text(self, text):
        self.texts.append(text)

    async def submit_otp(self, code):
        self.otps.append(code)

    async def harvest(self):
        return self.captured

    async def close(self):
        self.closed = True


async def _wait_state(job, state, tries=5000):
    for _ in range(tries):
        if job.state is state or job.terminal:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"job never reached {state}; stuck at {job.state}")


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(browser_login, "POLL_INTERVAL_S", 0)


async def _ok_finalize(captured, proxy_url):
    return {"accountId": 100001, "username": "main"}


# ─── state machine (no browser, no HTTP) ───────────────────────────

def test_happy_path_reaches_done_through_the_pipeline():
    async def scenario():
        driver = FakeDriver([Observation("working"), Observation("ready")])
        captures = []

        async def finalize(cap, proxy_url):
            captures.append((cap, proxy_url))
            return {"accountId": 100001, "username": "main"}

        mgr = LoginManager(lambda: driver, finalize)
        job = mgr.start(principal="team-1", email="e@x.test", password="pw", proxy_url="http://p:1")
        await job._task
        assert job.state is State.DONE
        assert (job.account_id, job.username) == (100001, "main")
        assert driver.launched == ("http://p:1", f"login-{job.id}")
        assert driver.credentials == ("e@x.test", "pw")
        assert driver.closed is True
        assert captures and captures[0][0].cookie == "sess=secret-cookie"

    asyncio.run(scenario())


def test_challenge_is_surfaced_but_never_solved():
    async def scenario():
        driver = FakeDriver([Observation("challenge", Challenge("turnstile", 320, 240))])
        mgr = LoginManager(lambda: driver, _ok_finalize)
        job = mgr.start(principal="t", email="e", password="pw", proxy_url=None)
        await _wait_state(job, State.CHALLENGE)
        snap = job.snapshot()
        assert snap["state"] == "challenge"
        assert snap["challenge"] == {"kind": "turnstile", "w": 320, "h": 240}
        assert driver.clicks == []  # we never touched the challenge ourselves
        await job.cancel()

    asyncio.run(scenario())


def test_a_human_click_is_forwarded_to_the_browser():
    async def scenario():
        driver = FakeDriver([Observation("challenge", Challenge("cloudflare", 300, 200))])
        mgr = LoginManager(lambda: driver, _ok_finalize)
        job = mgr.start(principal="t", email="e", password="pw", proxy_url=None)
        await _wait_state(job, State.CHALLENGE)
        job.submit_input({"type": "click", "x": 42, "y": 99})
        for _ in range(5000):
            if driver.clicks:
                break
            await asyncio.sleep(0)
        assert driver.clicks == [(42, 99)]
        await job.cancel()

    asyncio.run(scenario())


def test_two_factor_pauses_for_the_human_code_then_continues():
    async def scenario():
        driver = FakeDriver([Observation("otp"), Observation("ready")])
        mgr = LoginManager(lambda: driver, _ok_finalize)
        job = mgr.start(principal="t", email="e", password="pw", proxy_url=None)
        await _wait_state(job, State.OTP)
        assert job.snapshot()["needsOtp"] is True
        job.submit_input({"type": "otp", "code": "123456"})
        await job._task
        assert driver.otps == ["123456"]
        assert job.state is State.DONE

    asyncio.run(scenario())


def test_cancel_stops_the_job_and_closes_the_browser():
    async def scenario():
        driver = FakeDriver([Observation("challenge", Challenge("recaptcha"))])
        mgr = LoginManager(lambda: driver, _ok_finalize)
        job = mgr.start(principal="t", email="e", password="pw", proxy_url=None)
        await _wait_state(job, State.CHALLENGE)
        job.submit_input({"type": "cancel"})
        await job._task
        assert job.state is State.CANCELLED
        assert driver.closed is True
        with pytest.raises(ValueError, match="no longer live"):
            job.submit_input({"type": "click", "x": 1, "y": 1})

    asyncio.run(scenario())


def test_expiry_ends_the_job_in_error_without_leaking_the_password(monkeypatch):
    async def scenario():
        monkeypatch.setattr(browser_login, "JOB_TTL_S", -1)  # already past the deadline
        driver = FakeDriver([Observation("working")])
        mgr = LoginManager(lambda: driver, _ok_finalize)
        job = mgr.start(principal="t", email="e", password="hunter2", proxy_url=None)
        await job._task
        assert job.state is State.ERROR
        assert "timed out" in (job.error or "")
        assert "hunter2" not in (job.error or "")

    asyncio.run(scenario())


def test_one_live_job_per_principal_and_started_principal_check():
    async def scenario():
        d1 = FakeDriver([Observation("challenge", Challenge("turnstile"))])
        d2 = FakeDriver([Observation("challenge", Challenge("turnstile"))])
        drivers = iter([d1, d2])
        mgr = LoginManager(lambda: next(drivers), _ok_finalize)
        job1 = mgr.start(principal="team-1", email="e", password="pw", proxy_url=None)
        await _wait_state(job1, State.CHALLENGE)
        job2 = mgr.start(principal="team-1", email="e2", password="pw2", proxy_url=None)
        # job1 is replaced; only job2 is live for team-1.
        with pytest.raises(KeyError):
            mgr.get(job1.id, "team-1")
        assert mgr.get(job2.id, "team-1") is job2
        # Another principal cannot reach team-1's job (started-principal check).
        with pytest.raises(KeyError):
            mgr.get(job2.id, "team-2")
        await job2.cancel()

    asyncio.run(scenario())


def test_stream_token_gates_the_sse_subscriber():
    async def scenario():
        driver = FakeDriver([Observation("challenge", Challenge("turnstile"))])
        mgr = LoginManager(lambda: driver, _ok_finalize)
        job = mgr.start(principal="t", email="e", password="pw", proxy_url=None)
        await _wait_state(job, State.CHALLENGE)
        assert mgr.get_for_stream(job.id, job.stream_token) is job
        with pytest.raises(KeyError):
            mgr.get_for_stream(job.id, "wrong-token")
        await job.cancel()

    asyncio.run(scenario())


# ─── HTTP routes (bearer-authed, fake driver, real capture pipeline) ─

@pytest.fixture
def login_fakes(monkeypatch):
    """Swap the live manager's driver for a fake and stub the capture pipeline's network so the real
    `_finalize_browser_login` runs end to end (from_curl → commit_captured_session)."""
    fake = FakeDriver([Observation("working"), Observation("ready")])
    monkeypatch.setattr(upstream.login_manager, "_driver_factory", lambda: fake)

    def from_curl(curl, **kw):
        make_account("100001", proxy=False, nickname="Account 100001")
        path = accounts.latest_session_path("100001")
        return path

    me = {"username": "main_acct", "name": "Main", "avatar": "https://cdn.example.invalid/a.jpg"}
    probe = SimpleNamespace(me=lambda: me)
    monkeypatch.setattr(session_bootstrap, "from_curl", from_curl)
    monkeypatch.setattr(OFClient, "from_session_file", staticmethod(lambda path, **kw: probe))
    monkeypatch.setattr(client_pool, "get", lambda aid: probe)

    async def idle(_client):
        import asyncio
        await asyncio.Event().wait()
        yield {}

    monkeypatch.setattr(upstream.supervisor, "source", idle)
    return fake


@pytest.fixture
def client(login_fakes):
    with TestClient(upstream.app) as c:
        c.fake = login_fakes
        yield c


PRINCIPAL = {"x-login-principal": "team-1"}
PROXY = "http://u:p@203.0.113.10:8080"


def _poll_until(client, job_id, state, tries=200):
    for _ in range(tries):
        snap = client.get(f"/login/browser/{job_id}", headers={**AUTH, **PRINCIPAL}).json()
        if snap["state"] == state:
            return snap
    raise AssertionError(f"job stuck at {snap['state']}, wanted {state}")


def test_start_requires_a_principal(client):
    r = client.post("/login/browser/start", headers=AUTH, json={"email": "e", "password": "pw", "proxy": PROXY})
    assert (r.status_code, r.json()["error"]["code"]) == (400, "missing_principal")


def test_start_requires_a_proxy_when_of_require_proxy_is_on(client):
    r = client.post("/login/browser/start", headers={**AUTH, **PRINCIPAL}, json={"email": "e", "password": "pw"})
    assert (r.status_code, r.json()["error"]["code"]) == (409, "proxy_required")


def test_browser_login_captures_a_session_like_a_pasted_curl(client, monkeypatch):
    frames = []
    monkeypatch.setattr(upstream.supervisor, "hub", SimpleNamespace(publish=frames.append))
    r = client.post("/login/browser/start", headers={**AUTH, **PRINCIPAL},
                    json={"email": "e@x.test", "password": "pw", "proxy": PROXY})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "starting" and body["streamToken"] and "pw" not in r.text
    job_id = body["jobId"]
    snap = _poll_until(client, job_id, "done")
    assert (snap["accountId"], snap["username"]) == (100001, "main_acct")
    # Captured exactly like a pasted-cURL connect: the account exists, its proxy is bound, a frame fired.
    assert accounts.is_account("100001")
    assert proxies.get_for_account("100001")["host"] == "203.0.113.10"
    assert [f["type"] for f in frames] == ["accounts.connected"]
    # The response never carried the password or the live cookie.
    assert "secret-cookie" not in r.text


def test_status_is_404_for_the_wrong_principal(client):
    body = client.post("/login/browser/start", headers={**AUTH, **PRINCIPAL},
                       json={"email": "e", "password": "pw", "proxy": PROXY}).json()
    r = client.get(f"/login/browser/{body['jobId']}", headers={**AUTH, "x-login-principal": "team-2"})
    assert (r.status_code, r.json()["error"]["code"]) == (404, "job_not_found")


def test_stream_needs_the_token_and_streams_sse(client):
    body = client.post("/login/browser/start", headers={**AUTH, **PRINCIPAL},
                       json={"email": "e", "password": "pw", "proxy": PROXY}).json()
    job_id, token = body["jobId"], body["streamToken"]
    _poll_until(client, job_id, "done")  # drive to terminal so the stream closes
    bad = client.get(f"/login/browser/{job_id}/stream?token=wrong", headers=AUTH)
    assert bad.status_code == 404
    r = client.get(f"/login/browser/{job_id}/stream?token={token}", headers=AUTH)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    datas = [json.loads(line[len("data: "):]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert datas and datas[-1]["state"] == "done"
    assert datas[-1]["frame"]["w"] == 320  # a screencast frame rode along

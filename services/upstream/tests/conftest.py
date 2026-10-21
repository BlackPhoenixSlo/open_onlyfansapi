"""Test env: a throwaway state dir and a known token, set before `app` is imported."""
import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

os.environ["UPSTREAM_STATE_DIR"] = tempfile.mkdtemp(prefix="upstream-test-")
os.environ["UPSTREAM_TOKEN"] = TOKEN = "test-token-0123456789"
os.environ["OF_REQUIRE_PROXY"] = "true"
os.environ["SENT_POLL_INTERVAL_S"] = "0"  # app's pumps poll no chat list (OFFake would see the calls)
os.environ["MASS_POLL_INTERVAL_S"] = "0"  # nor the mass-message history

from curl_cffi.requests import Response
from curl_cffi.requests.headers import Headers

import accounts
import client_pool
import config
import proxies
from of_client import OFClient

FIXTURES = HERE / "fixtures" / "of_frames"
PAYLOADS = HERE / "fixtures" / "payloads"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
def clean_state():
    """Every test starts with no accounts, no proxies and an empty client pool."""
    # Never touch a real state dir: every path must come from UPSTREAM_STATE_DIR.
    assert accounts.account_dir("1").is_relative_to(config.STATE_DIR)
    assert "upstream-test-" in str(config.STATE_DIR)
    shutil.rmtree(config.SESSIONS_DIR, ignore_errors=True)
    config.PROXIES_PATH.unlink(missing_ok=True)
    client_pool.evict()
    yield
    client_pool.evict()


@pytest.fixture(autouse=True)
def no_background_reconcile(monkeypatch):
    """The app's lifespan loop does not reconcile. Its first pass would race the test's own setup:
    one that sees an account made after `TestClient` started runs a pump on the patched client, and
    that pump spends the test's queued OF replies. Tests call `supervisor.reconcile()` (or a route that
    does) when they want pumps."""
    import pump

    async def idle(self, interval=None):
        return

    monkeypatch.setattr(pump.Supervisor, "run", idle)


def make_account(aid: str, *, session: bool = True, proxy: bool = True, **meta) -> None:
    """An account dir as `from_curl` leaves it; `session=False` is a dir with meta only."""
    accounts.upsert_account(aid, nickname=meta.pop("nickname", f"Account {aid}"))
    if meta:
        m = accounts.load_meta(aid)
        m.update(meta)
        accounts.save_meta(aid, m)
    if session:
        new_session(aid)
    if proxy:
        proxies.upsert({"label": f"acct-{aid}", "scheme": "http", "host": "203.0.113.10", "port": 8080})
        proxies.assign_account(f"acct-{aid}", aid)


def new_session(aid: str, *, bump: float = 0) -> None:
    """Write a new session file and point `latest.json` at it (mtime moved by `bump`)."""
    adir = accounts.account_dir(aid)
    adir.mkdir(parents=True, exist_ok=True)
    n = len(list(adir.glob("session_*.json")))
    path = adir / f"session_2026100{n}T120000Z.json"
    path.write_text(json.dumps({"headers": {"user_id": aid}}))
    accounts.record_session(aid, path)
    if bump:
        latest = adir / "latest.json"
        t = latest.stat().st_mtime + bump
        os.utime(latest, (t, t))


def frame(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def payload_fixture(event: str) -> dict:
    """`fixtures/payloads/<event>.json`: a delivery `{event, account_id, payload}` with generic values whose
    key structure and JSON types mirror the reference product's example for that event (plan-v5 §7)."""
    return json.loads((PAYLOADS / f"{event}.json").read_text())


def key_paths(value, path: str = "$") -> set[str]:
    """Every key path in `value`; list items share `<path>[]`."""
    out = {path}
    if isinstance(value, dict):
        for k, v in value.items():
            out |= key_paths(v, f"{path}.{k}")
    elif isinstance(value, list):
        for v in value:
            out |= key_paths(v, f"{path}[]")
    return out


def mass_entry(qid, date, sent, /, **extra) -> dict:
    """A mass-message history entry with the 19 keys of a real one (the 2026-10-09 live read)."""
    return {
        "id": qid, "date": date, "text": "<p>text</p>", "rawText": "<p>text</p>", "giphyId": None, "media": [],
        "mediaCount": 0, "previews": [], "sentCount": sent, "viewedCount": 0, "isCanceled": False, "isFree": True,
        "isMediaReady": True, "isReportedByMe": False, "isTip": False, "canUnsend": True, "unsendSeconds": 1000000,
        "responseType": "message", "template": "group", **extra,
    }


# ─── poller tests (test_sent_poller, test_mass_poller) ───────────

@pytest.fixture
def of():
    return OFFake()


@pytest.fixture
def frames():
    return []


def poll(p):
    asyncio.run(p.poll())


def ids(frames):
    return [f["id"] for f in frames]


# ─── of_fake: OF at the wire ───────────────────────────────────────

FAKE_SESSION = {
    "headers": {"user_id": "1001", "x_bc": "test-x-bc", "x_of_rev": "test-rev", "user_agent": "test-agent"},
    "signing": {"rules": {"static_param": "test-static", "start": "0", "end": "0",
                          "checksum_indexes": [0], "checksum_constant": 0}},
}


class _NoRawHttp:
    def __getattr__(self, name):
        raise AssertionError("raw self.http call bypasses _http_call")


class OFFake(OFClient):
    """A real OFClient cut at `_http_call`: each call is recorded as `(method, url, json_body)`
    and answered from the queue; an empty queue fails the test, and so does any use of `self.http`."""

    def __init__(self):
        super().__init__(FAKE_SESSION, proxies={"https": "http://203.0.113.10:8080"})
        self.http = _NoRawHttp()
        self.calls = []
        self._queue = []

    def respond(self, body=None, status=200, headers=None):
        """Queue one OF response. `body`: bytes as-is, anything else JSON-encoded."""
        r = Response()
        r.status_code, r.ok = status, status < 400
        r.content = body if isinstance(body, bytes) else json.dumps(body).encode()
        r.headers = Headers({"content-type": "application/json"} if headers is None else headers)
        self._queue.append(r)

    def fail(self, error):
        """Queue a transport failure (a curl_cffi exception)."""
        self._queue.append(error)

    def _http_call(self, method, url, *, json_body=None):
        self.calls.append((method, url, json_body))
        assert self._queue, f"unexpected OF call: {method} {url}"
        item = self._queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        item.url = url
        return item


@pytest.fixture
def of_fake():
    """An `OFFake` served for every account through the `account_client` override."""
    import app as upstream

    fake = OFFake()
    upstream.app.dependency_overrides[upstream.account_client] = lambda: fake
    yield fake
    upstream.app.dependency_overrides.pop(upstream.account_client, None)

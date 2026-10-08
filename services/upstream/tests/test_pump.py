import asyncio
from types import SimpleNamespace

import pytest
from conftest import frame, key_paths, make_account, new_session, payload_fixture

import client_pool
import proxies
import pump
from of_client import OFAPIError
from of_ws import SessionExpired
from pump import Supervisor


class FakeHub:
    def __init__(self):
        self.frames = []

    def publish(self, f):
        self.frames.append(f)


class FakeClient:
    def __init__(self, aid, proxy_url="http://203.0.113.10:8080"):
        self.aid, self.proxy_url = aid, proxy_url


class FakeSource:
    """One feed per pump start: the test pushes OF frames, or an exception to raise."""

    def __init__(self):
        self.starts = []
        self.feeds = []
        self.closed = 0

    async def __call__(self, client):
        feed = asyncio.Queue()
        self.starts.append(client.aid)
        self.feeds.append(feed)
        try:
            while True:
                item = await feed.get()
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            self.closed += 1


def supervisor(hub=None, **kw):
    src = FakeSource()
    kw.setdefault("client_factory", FakeClient)
    return Supervisor(hub or FakeHub(), source=src, **kw), src


def expired_by(status, content_type="application/json"):
    """SessionExpired as of_ws raises it: from the OFAPIError of /users/me."""
    resp = SimpleNamespace(status_code=status, headers={"content-type": content_type})
    try:
        raise SessionExpired(f"/users/me answered {status}") from OFAPIError(str(status), response=resp)
    except SessionExpired as e:
        return e


@pytest.fixture
def evicted(monkeypatch):
    calls = []
    monkeypatch.setattr(client_pool, "evict", lambda aid=None: calls.append(aid))
    return calls


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


def test_pump_classifies_frames_into_the_hub(evicted):
    async def main():
        hub = FakeHub()
        sup, src = supervisor(hub)
        make_account("100001")
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001"] and evicted == ["100001"]
        assert sup.status("100001") == "connecting"
        src.feeds[0].put_nowait(frame("connected"))
        src.feeds[0].put_nowait(frame("counters"))
        src.feeds[0].put_nowait(frame("api2_chat_message.received"))
        await settle()
        assert sup.status("100001") == "active"
        assert [f["type"] for f in hub.frames] == ["messages.received"]
        assert hub.frames[0]["account_id"] == 100001
        await sup.reconcile()  # nothing changed: same pump keeps running
        assert src.starts == ["100001"]
        await sup.stop()
        assert src.closed == 1

    asyncio.run(main())


def test_restart_on_session_change(evicted):
    async def main():
        sup, src = supervisor()
        make_account("100001")
        await sup.reconcile()
        await settle()
        new_session("100001", bump=5)
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001", "100001"]
        assert src.closed == 1  # the old pump was stopped
        assert evicted == ["100001", "100001"]
        await sup.stop()

    asyncio.run(main())


def test_restart_on_proxy_change(evicted):
    async def main():
        sup, src = supervisor()
        make_account("100001")
        await sup.reconcile()
        await settle()
        proxies.upsert({"label": "acct-100001", "scheme": "http", "host": "203.0.113.11", "port": 8080})
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001", "100001"] and src.closed == 1
        assert evicted == ["100001", "100001"]
        await sup.stop()

    asyncio.run(main())


def test_session_expiry_stops_the_pump_until_a_new_session(evicted):
    async def main():
        hub = FakeHub()
        sup, src = supervisor(hub)
        make_account("100001")
        await sup.reconcile()
        await settle()
        src.feeds[0].put_nowait(expired_by(401))
        await settle()
        assert sup.status("100001") == sup.blocker("100001") == "session_expired"
        [ev] = hub.frames
        assert ev["type"] == "accounts.session_expired" and ev["account_id"] == 100001
        mtime = sup.key("100001")[0]
        assert ev["id"] == f"account.session_expired:100001:{int(mtime)}"  # v4's id: same dedup key
        assert ev["payload"]["latestAuthAttempt"]["completed_at"] == ev["ts"]
        assert ev["amount_cents"] is None and ev["payload"]["state"] == "session_expired"
        assert key_paths(ev["payload"]) == key_paths(payload_fixture("accounts.session_expired")["payload"])
        for _ in range(2):  # later reconciles neither restart nor re-announce
            await sup.reconcile()
            await settle()
        assert src.starts == ["100001"] and len(hub.frames) == 1
        new_session("100001", bump=5)
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001", "100001"]
        assert sup.status("100001") == "connecting"
        await sup.stop()

    asyncio.run(main())


def test_a_stale_pump_does_not_announce_expiry(evicted):
    async def main():
        hub = FakeHub()
        sup, src = supervisor(hub)
        make_account("100001")
        await sup.reconcile()
        await settle()
        new_session("100001", bump=5)  # a new session lands before the old pump's 401 arrives
        src.feeds[0].put_nowait(expired_by(401))
        await settle()
        assert hub.frames == []
        await sup.reconcile()
        await settle()
        assert sup.status("100001") == "connecting" and src.starts == ["100001", "100001"]
        await sup.stop()

    asyncio.run(main())


def test_json_403_expires_the_session(evicted):
    async def main():
        hub = FakeHub()
        sup, src = supervisor(hub)
        make_account("100001")
        await sup.reconcile()
        await settle()
        src.feeds[0].put_nowait(expired_by(403, "application/json; charset=utf-8"))
        await settle()
        assert sup.status("100001") == "session_expired"
        assert [f["type"] for f in hub.frames] == ["accounts.session_expired"]
        await sup.stop()

    asyncio.run(main())


def test_html_403_is_not_an_expiry(evicted):
    async def main():
        hub = FakeHub()
        sup, src = supervisor(hub)
        make_account("100001")
        await sup.reconcile()
        await settle()
        src.feeds[0].put_nowait(expired_by(403, "text/html"))  # Cloudflare / flagged proxy IP
        await settle()
        assert hub.frames == []
        assert sup.status("100001") == "connecting"
        await sup.reconcile()  # the next reconcile restarts it
        await settle()
        assert src.starts == ["100001", "100001"]
        await sup.stop()

    asyncio.run(main())


def test_a_crashed_pump_is_restarted(evicted):
    async def main():
        sup, src = supervisor()
        make_account("100001")
        await sup.reconcile()
        await settle()
        src.feeds[0].put_nowait(RuntimeError("boom"))
        await settle()
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001", "100001"]
        await sup.stop()

    asyncio.run(main())


def test_no_pump_without_session_or_proxy(evicted):
    async def main():
        sup, src = supervisor()
        make_account("100001", session=False)
        make_account("100002", proxy=False)
        await sup.reconcile()
        await settle()
        assert src.starts == []
        assert (sup.status("100001"), sup.status("100002")) == ("no_session", "no_proxy")
        sup.require_proxy = False
        await sup.reconcile()
        await settle()
        assert src.starts == ["100002"]
        await sup.stop()

    asyncio.run(main())


def test_a_client_built_without_a_proxy_never_connects(evicted):
    async def main():
        sup, src = supervisor(client_factory=lambda aid: FakeClient(aid, proxy_url=None))
        make_account("100001")
        await sup.reconcile()
        await settle()
        assert src.starts == []
        await sup.reconcile()  # fails closed again; each reconcile retries
        await settle()
        assert src.starts == []
        sup.client_factory = FakeClient
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001"]
        await sup.stop()

    asyncio.run(main())


def test_removed_account_stops_its_pump(evicted, monkeypatch):
    async def main():
        sup, src = supervisor()
        make_account("100001")
        await sup.reconcile()
        await settle()
        monkeypatch.setattr(pump.accounts, "account_ids", lambda: frozenset())
        await sup.reconcile()
        await settle()
        assert src.closed == 1 and sup._pumps == {}

    asyncio.run(main())


def wrong_user():
    """SessionExpired from /users/me's 400 `{"error":{"code":301,"message":"Wrong user."}}`."""
    body = {"error": {"code": 301, "message": "Wrong user."}}
    resp = SimpleNamespace(status_code=400, headers={"content-type": "application/json"}, json=lambda: body)
    try:
        raise SessionExpired("/users/me answered 400") from OFAPIError("400", response=resp)
    except SessionExpired as e:
        return e


def test_wrong_user_expires_the_session_once(evicted):
    async def main():
        hub = FakeHub()
        sup, src = supervisor(hub)
        make_account("100001")
        await sup.reconcile()
        await settle()
        src.feeds[0].put_nowait(wrong_user())
        await settle()
        assert sup.status("100001") == "session_expired"
        assert [f["type"] for f in hub.frames] == ["accounts.session_expired"]
        sup.mark_expired("100001")  # a later REST 401 on the same session announces nothing
        await sup.reconcile()
        await settle()
        assert src.starts == ["100001"] and len(hub.frames) == 1
        await sup.stop()

    asyncio.run(main())


def test_a_plain_400_is_not_an_expiry():
    resp = SimpleNamespace(status_code=400, json=lambda: {"error": {"code": 0, "message": "Bad request"}})
    try:
        raise SessionExpired("x") from OFAPIError("400", response=resp)
    except SessionExpired as e:
        assert not pump._expired(e)

import asyncio

import pytest
from conftest import frame, make_account, new_session

import client_pool
import pump
from of_ws import SessionExpired
from pump import Supervisor


class FakeHub:
    def __init__(self):
        self.frames = []

    def publish(self, f):
        self.frames.append(f)


class FakeSource:
    """One feed per pump start: the test pushes OF frames, or an exception to raise."""

    def __init__(self):
        self.starts = []
        self.feeds = []
        self.closed = 0

    async def __call__(self, aid):
        feed = asyncio.Queue()
        self.starts.append(aid)
        self.feeds.append(feed)
        try:
            while True:
                item = await feed.get()
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            self.closed += 1


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
        hub, src = FakeHub(), FakeSource()
        sup = Supervisor(hub, source=src)
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
        assert [f["type"] for f in hub.frames] == ["message.received"]
        assert hub.frames[0]["account_id"] == 100001
        await sup.reconcile()  # nothing changed: same pump keeps running
        assert src.starts == ["100001"]
        await sup.stop()
        assert src.closed == 1

    asyncio.run(main())


def test_restart_on_session_change(evicted):
    async def main():
        src = FakeSource()
        sup = Supervisor(FakeHub(), source=src)
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


def test_session_expiry_stops_the_pump_until_a_new_session(evicted):
    async def main():
        hub, src = FakeHub(), FakeSource()
        sup = Supervisor(hub, source=src)
        make_account("100001")
        await sup.reconcile()
        await settle()
        src.feeds[0].put_nowait(SessionExpired("401"))
        await settle()
        assert sup.status("100001") == "session_expired"
        [ev] = hub.frames
        assert ev["type"] == "account.session_expired" and ev["account_id"] == 100001
        assert ev["payload"] == {} and ev["id"].startswith("account.session_expired:100001:")
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


def test_a_crashed_pump_is_restarted(evicted):
    async def main():
        src = FakeSource()
        sup = Supervisor(FakeHub(), source=src)
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
        src = FakeSource()
        sup = Supervisor(FakeHub(), source=src)
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


def test_removed_account_stops_its_pump(evicted, monkeypatch):
    async def main():
        src = FakeSource()
        sup = Supervisor(FakeHub(), source=src)
        make_account("100001")
        await sup.reconcile()
        await settle()
        monkeypatch.setattr(pump.accounts, "account_ids", lambda: frozenset())
        await sup.reconcile()
        await settle()
        assert src.closed == 1 and sup._pumps == {}

    asyncio.run(main())

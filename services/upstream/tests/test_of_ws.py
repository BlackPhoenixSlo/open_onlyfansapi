import asyncio
import json
from types import SimpleNamespace

import pytest

import of_ws
from of_ws import RECONNECT_MIN_S, OFWebSocket

HELLO = json.dumps({"connected": True})  # OF's handshake reply


class FakeSocket:
    """OF's socket: hands out `frames`, then blocks (`block=True`) or drops the link."""

    def __init__(self, frames=(), *, block=False):
        self.frames = list(frames)
        self.block = block
        self.recv_cancelled = False

    async def send(self, data):
        pass

    async def recv(self):
        if self.frames:
            return self.frames.pop(0)
        if not self.block:
            raise ConnectionError("link dropped")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.recv_cancelled = True
            raise


class FakeConnect:
    """Stands in for `websockets.connect`: one entry per attempt, a socket or an exception."""

    def __init__(self, attempts):
        self.attempts = list(attempts)

    def __call__(self, url, **kw):
        return self

    async def __aenter__(self):
        attempt = self.attempts.pop(0)
        if isinstance(attempt, BaseException):
            raise attempt
        return attempt

    async def __aexit__(self, *exc):
        return False


def fake_client():
    return SimpleNamespace(
        me=lambda: {"wsUrl": "wss://ws2.example.invalid/ws3/1", "wsAuthToken": "jwt"},
        user_agent="ua", accept_language=None, proxy_url="http://203.0.113.10:8080", proxy_label="p")


@pytest.fixture
def no_pinger(monkeypatch):
    async def idle(ws, stop):
        await stop.wait()
    monkeypatch.setattr(of_ws, "_pinger", idle)


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


def test_backoff_resets_after_a_reconnect_that_delivers_a_frame(monkeypatch, no_pinger):
    refused = OSError("connection refused")
    monkeypatch.setattr(of_ws.websockets, "connect", FakeConnect([
        refused, refused, FakeSocket([HELLO]), refused, FakeSocket()]))
    waits = []
    ws = OFWebSocket(fake_client())

    async def no_sleep(aw, timeout):  # the backoff wait: record it, skip it
        aw.close()
        waits.append(timeout)
        if len(waits) == 5:
            ws.stop()
        raise asyncio.TimeoutError

    monkeypatch.setattr(of_ws.asyncio, "wait_for", no_sleep)

    async def main():
        return [f async for f in ws.events()]

    assert asyncio.run(main()) == [{"connected": True}]
    # Two refusals grow it; the reconnect that worked starts it over.
    assert waits == [RECONNECT_MIN_S, 2, RECONNECT_MIN_S, 2, 4]


def test_cancelling_events_cancels_the_pending_recv(monkeypatch, no_pinger):
    sock = FakeSocket([HELLO], block=True)
    monkeypatch.setattr(of_ws.websockets, "connect", FakeConnect([sock]))

    async def main():
        gen = OFWebSocket(fake_client()).events()
        assert await anext(gen) == {"connected": True}
        nxt = asyncio.create_task(anext(gen))
        await settle()  # parked on recv
        nxt.cancel()  # what the pump restart does
        with pytest.raises(asyncio.CancelledError):
            await nxt
        await settle()
        assert sock.recv_cancelled
        assert asyncio.all_tasks() == {asyncio.current_task()}

    asyncio.run(main())

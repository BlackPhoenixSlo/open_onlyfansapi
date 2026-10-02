import asyncio
import json

from pump import CLOSE_TRY_AGAIN_LATER, Hub


class FakeSocket:
    """An accepted socket whose client never reads (`stall`) or reads everything."""

    def __init__(self, stall=False):
        self.sent = []
        self.closed = None
        self.stall = stall
        self.disconnect = asyncio.Event()

    async def send_text(self, text):
        if self.stall:
            await asyncio.Event().wait()  # a consumer that never reads again
        self.sent.append(json.loads(text))

    async def close(self, code):
        self.closed = code

    async def receive(self):
        await self.disconnect.wait()
        return {"type": "websocket.disconnect", "code": 1000}


async def _joined(hub, n):
    while hub.sockets < n:
        await asyncio.sleep(0)


def test_fan_out_and_disconnect():
    async def main():
        hub = Hub()
        a, b = FakeSocket(), FakeSocket()
        tasks = [asyncio.create_task(hub.serve(a)), asyncio.create_task(hub.serve(b))]
        await _joined(hub, 2)
        hub.publish({"type": "message.received", "n": 1})
        await asyncio.sleep(0.01)
        assert a.sent == b.sent == [{"type": "message.received", "n": 1}]
        a.disconnect.set()
        await asyncio.wait_for(tasks[0], 1)
        assert hub.sockets == 1
        b.disconnect.set()
        await asyncio.wait_for(tasks[1], 1)
        assert hub.sockets == 0

    asyncio.run(main())


def test_slow_consumer_is_closed_with_1013():
    async def main():
        hub = Hub(queue_size=10, send_timeout=0.05)
        slow, fast = FakeSocket(stall=True), FakeSocket()
        slow_task = asyncio.create_task(hub.serve(slow))
        fast_task = asyncio.create_task(hub.serve(fast))
        await _joined(hub, 2)
        hub.publish({"n": 0})
        await asyncio.sleep(0.01)  # slow is now stuck sending frame 0, and never reads again
        for n in range(1, 12):
            hub.publish({"n": n})
            await asyncio.sleep(0)
        assert hub.sockets == 1  # slow was dropped on overflow, fast kept up
        await asyncio.wait_for(slow_task, 1)  # closes although the send never completes
        assert slow.closed == CLOSE_TRY_AGAIN_LATER
        assert slow.sent == []
        await asyncio.sleep(0.01)
        assert [f["n"] for f in fast.sent] == list(range(12))
        fast.disconnect.set()
        await asyncio.wait_for(fast_task, 1)

    asyncio.run(main())


def test_stalled_send_is_closed_with_1013_without_overflow():
    async def main():
        hub = Hub(send_timeout=0.05)
        stuck = FakeSocket(stall=True)
        task = asyncio.create_task(hub.serve(stuck))
        await _joined(hub, 1)
        hub.publish({"n": 0})
        await asyncio.wait_for(task, 1)
        assert stuck.closed == CLOSE_TRY_AGAIN_LATER and hub.sockets == 0

    asyncio.run(main())


def test_loss_is_logged(caplog):
    async def main():
        hub = Hub(queue_size=1, send_timeout=0.05)
        hub.publish({"type": "message.received"})  # nobody connected
        hub.publish({"type": "message.received"})  # rate-limited: no second warning
        slow = FakeSocket(stall=True)
        task = asyncio.create_task(hub.serve(slow))
        await _joined(hub, 1)
        hub.publish({"n": 0})
        await asyncio.sleep(0.01)
        hub.publish({"n": 1})
        hub.publish({"n": 2})  # overflow
        await asyncio.wait_for(task, 1)

    with caplog.at_level("WARNING", logger="upstream.pump"):
        asyncio.run(main())
    msgs = [r.getMessage() for r in caplog.records]
    assert sum("no /ws consumer" in m for m in msgs) == 1
    assert any("overflowed: dropped 2 frame(s)" in m for m in msgs)


def test_heartbeat():
    async def main():
        hub = Hub()
        sock = FakeSocket()
        task = asyncio.create_task(hub.serve(sock))
        await _joined(hub, 1)
        beat = asyncio.create_task(hub.heartbeat(interval=0.01))
        await asyncio.sleep(0.035)
        beat.cancel()
        sock.disconnect.set()
        await task
        assert len(sock.sent) >= 2
        assert all(set(f) == {"type", "ts"} and f["type"] == "heartbeat" for f in sock.sent)

    asyncio.run(main())

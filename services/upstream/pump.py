"""Per-account OF socket pumps (Supervisor) and the `/ws` fan-out (Hub).

One process, one event loop: the Supervisor runs one task per account that has a
session (and a proxy while proxies are required), classifies each OF frame and
publishes the result to the Hub, which copies it into a bounded queue per
connected `/ws` socket. Delivery is at-most-once; a socket that falls 1000 frames
behind is closed with 1013 and the gateway reconnects.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import accounts
import client_pool
import events
import proxies
from of_ws import OFWebSocket, SessionExpired

log = logging.getLogger("upstream.pump")

QUEUE_SIZE = 1000
HEARTBEAT_S = 30
RECONCILE_S = 30
CLOSE_TRY_AGAIN_LATER = 1013

FrameSource = Callable[[str], AsyncIterator[dict]]


async def of_frames(account_id: str) -> AsyncIterator[dict]:
    """The real frame source: the account's pooled OFClient over OF's socket."""
    client = await asyncio.to_thread(client_pool.get, account_id)
    ws = OFWebSocket(client)
    try:
        async for frame in ws.events():
            yield frame
    finally:
        ws.stop()


# ─── Hub ──────────────────────────────────────────────────────────

_CLOSE = object()  # queued in place of the backlog when a socket overflows


class Hub:
    def __init__(self, queue_size: int = QUEUE_SIZE) -> None:
        self.queue_size = queue_size
        self._queues: set[asyncio.Queue] = set()

    def publish(self, frame: dict) -> None:
        for q in list(self._queues):
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                # Slow consumer: drop its backlog, close it with 1013.
                self._queues.discard(q)
                while not q.empty():
                    q.get_nowait()
                q.put_nowait(_CLOSE)

    async def heartbeat(self, interval: float = HEARTBEAT_S) -> None:
        while True:
            await asyncio.sleep(interval)
            self.publish({"type": "heartbeat", "ts": events.iso(datetime.now(UTC))})

    async def serve(self, ws: Any) -> None:
        """Pump this hub into an accepted socket until either side goes away."""
        q: asyncio.Queue = asyncio.Queue(self.queue_size)
        self._queues.add(q)
        reader = asyncio.create_task(_until_disconnect(ws))
        try:
            while True:
                getter = asyncio.create_task(q.get())
                done, _ = await asyncio.wait({getter, reader}, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done:
                    getter.cancel()
                    return
                item = getter.result()
                if item is _CLOSE:
                    await ws.close(code=CLOSE_TRY_AGAIN_LATER)
                    return
                await ws.send_text(json.dumps(item, separators=(",", ":")))
        except Exception:  # the peer went away mid-send
            log.debug("ws send failed", exc_info=True)
        finally:
            self._queues.discard(q)
            reader.cancel()
            if reader.done() and not reader.cancelled():
                reader.exception()  # retrieved: a failed read just means the peer is gone

    @property
    def sockets(self) -> int:
        return len(self._queues)


async def _until_disconnect(ws: Any) -> None:
    """Read and ignore client messages; return once the client disconnects."""
    while True:
        msg = await ws.receive()
        if msg.get("type") == "websocket.disconnect":
            return


# ─── Supervisor ──────────────────────────────────────────────────


@dataclass
class _Pump:
    task: asyncio.Task
    mtime: float


class Supervisor:
    def __init__(self, hub: Hub, *, require_proxy: bool = True,
                 source: FrameSource = of_frames) -> None:
        self.hub = hub
        self.require_proxy = require_proxy
        self.source = source
        self._pumps: dict[str, _Pump] = {}
        self._live: set[str] = set()          # pumps that have seen a frame
        self._expired: dict[str, float] = {}  # account -> latest.json mtime that expired
        self._lock = asyncio.Lock()

    # Status is derived from disk + pump state, so `/of-accounts` is right even
    # between reconciles.
    def status(self, account_id: str) -> str:
        mtime = _session_mtime(account_id)
        if mtime is None:
            return "no_session"
        if self.require_proxy and proxies.get_for_account(account_id) is None:
            return "no_proxy"
        if self._expired.get(account_id) == mtime:
            return "session_expired"
        pump = self._pumps.get(account_id)
        if pump is not None and pump.mtime == mtime and account_id in self._live:
            return "active"
        return "connecting"

    async def run(self, interval: float = RECONCILE_S) -> None:
        while True:
            try:
                await self.reconcile()
            except Exception:  # keep reconciling
                log.exception("reconcile failed")
            await asyncio.sleep(interval)

    async def reconcile(self) -> None:
        async with self._lock:
            ids = await asyncio.to_thread(accounts.account_ids)
            for aid in set(self._pumps) - ids:
                await self._stop(aid)
            for aid in sorted(ids):
                if aid.isdigit():
                    await self._reconcile_one(aid)

    async def _reconcile_one(self, aid: str) -> None:
        mtime = _session_mtime(aid)
        runnable = mtime is not None and not (
            self.require_proxy and proxies.get_for_account(aid) is None)
        if not runnable or self._expired.get(aid) == mtime:
            await self._stop(aid)
            return
        pump = self._pumps.get(aid)
        if pump is not None and pump.mtime == mtime and not pump.task.done():
            return
        # New session (or a pump that died): rebuild the client from disk.
        await self._stop(aid)
        self._expired.pop(aid, None)
        client_pool.evict(aid)
        self._pumps[aid] = _Pump(asyncio.create_task(self._pump(aid, mtime)), mtime)

    async def _pump(self, aid: str, mtime: float) -> None:
        account_id = int(aid)
        try:
            async for frame in self.source(aid):
                self._live.add(aid)
                try:
                    out = events.classify(account_id, frame)
                except Exception:  # one bad frame must not stop the pump
                    log.exception("classify failed account=%s", aid)
                    continue
                for ev in out:
                    self.hub.publish(ev)
            log.warning("frame source ended account=%s", aid)
        except SessionExpired:
            log.warning("session expired account=%s", aid)
            self._expired[aid] = mtime
            self.hub.publish(events.event(
                "account.session_expired", account_id, int(mtime),
                events.iso(datetime.now(UTC)), {}))
        except asyncio.CancelledError:
            raise
        except Exception:  # restarted by the next reconcile
            log.exception("pump failed account=%s", aid)
        finally:
            self._live.discard(aid)

    async def _stop(self, aid: str) -> None:
        pump = self._pumps.pop(aid, None)
        if pump is None:
            return
        pump.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump.task

    async def stop(self) -> None:
        for aid in list(self._pumps):
            await self._stop(aid)


def _session_mtime(account_id: str) -> float | None:
    """mtime of the account's `latest.json`: changes exactly when a session lands."""
    if accounts.latest_session_path(account_id) is None:
        return None
    try:
        return (accounts.account_dir(account_id) / "latest.json").stat().st_mtime
    except (FileNotFoundError, accounts.NotAnAccountId):
        return None

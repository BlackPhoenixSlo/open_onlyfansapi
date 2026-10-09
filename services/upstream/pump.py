"""Per-account OF socket pumps (Supervisor) and the `/ws` fan-out (Hub).

One process, one event loop: the Supervisor runs one task per account that has a
session (and a proxy while proxies are required), classifies each OF frame and
publishes the result to the Hub, which copies it into a bounded queue per
connected `/ws` socket. Delivery is at-most-once; a socket that falls 1000 frames
behind, or stalls a send for 10 s, is closed with 1013 and the gateway reconnects.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
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
SEND_TIMEOUT_S = 10
NO_SOCKET_WARN_S = 60
CLOSE_TRY_AGAIN_LATER = 1013

FrameSource = Callable[[Any], AsyncIterator[dict]]
ClientFactory = Callable[[str], Any]
# The `messages.sent` poller per pump (sent_poller.run, interval bound): account id, client, publish, on_expired.
Poller = Callable[[int, Any, Callable[[dict], None], Callable[[], None]], Awaitable[None]]


async def of_frames(client: Any) -> AsyncIterator[dict]:
    """The real frame source: OF's socket for an already-built OFClient."""
    ws = OFWebSocket(client)
    try:
        async for frame in ws.events():
            yield frame
    finally:
        ws.stop()


# ─── Hub ──────────────────────────────────────────────────────────

_CLOSE = object()  # queued in place of the backlog when a socket overflows


class Hub:
    def __init__(self, queue_size: int = QUEUE_SIZE, send_timeout: float = SEND_TIMEOUT_S) -> None:
        self.queue_size = queue_size
        self.send_timeout = send_timeout
        self._queues: set[asyncio.Queue] = set()
        self._unsent = 0             # events published while no socket was connected
        self._unsent_logged_at = 0.0

    def publish(self, frame: dict) -> None:
        if not self._queues and frame.get("type") != "heartbeat":
            self._unsent += 1
            now = time.monotonic()
            if now - self._unsent_logged_at >= NO_SOCKET_WARN_S:
                log.warning("no /ws consumer: %d event(s) dropped since the last warning", self._unsent)
                self._unsent, self._unsent_logged_at = 0, now
        for q in list(self._queues):
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                # Slow consumer: drop its backlog, close it with 1013.
                self._queues.discard(q)
                dropped = q.qsize() + 1
                while not q.empty():
                    q.get_nowait()
                q.put_nowait(_CLOSE)
                log.warning("/ws consumer overflowed: dropped %d frame(s), closing 1013", dropped)

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
                    await self._close_slow(ws)
                    return
                try:
                    await asyncio.wait_for(
                        ws.send_text(json.dumps(item, separators=(",", ":"))), self.send_timeout)
                except TimeoutError:
                    log.warning("/ws send stalled %.0fs: closing 1013", self.send_timeout)
                    await self._close_slow(ws)
                    return
        except Exception:  # the peer went away mid-send
            log.debug("ws send failed", exc_info=True)
        finally:
            self._queues.discard(q)
            reader.cancel()
            if reader.done() and not reader.cancelled():
                reader.exception()  # retrieved: a failed read just means the peer is gone

    async def _close_slow(self, ws: Any) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(ws.close(code=CLOSE_TRY_AGAIN_LATER), self.send_timeout)

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

# What a pump runs against: the session on disk and the proxy the registry assigns.
# Either changing restarts the pump.
Key = tuple[float, str | None]


@dataclass
class _Pump:
    task: asyncio.Task
    key: Key


class Supervisor:
    def __init__(self, hub: Hub, *, require_proxy: bool = True,
                 source: FrameSource = of_frames,
                 client_factory: ClientFactory | None = None,
                 poller: Poller | None = None) -> None:
        self.hub = hub
        self.require_proxy = require_proxy
        self.source = source
        self.poller = poller  # None: no `messages.sent`
        # Looked up per call, so the pool stays the one place clients are built.
        self.client_factory = client_factory or (lambda aid: client_pool.get(aid))
        self._pumps: dict[str, _Pump] = {}
        self._live: set[str] = set()          # pumps that have seen a frame
        self._expired: dict[str, float] = {}  # account -> latest.json mtime that expired
        self._lock = asyncio.Lock()

    def key(self, account_id: str) -> Key | None:
        mtime = _session_mtime(account_id)
        if mtime is None:
            return None
        p = proxies.get_for_account(account_id)
        return (mtime, proxies.proxy_url(p) if p else None)

    def blocker(self, account_id: str, key: Key | None = None) -> str | None:
        """Why this account cannot run, or None: the one session/proxy gate for
        `/of/*`, `/of-accounts`, bootstrap and the pumps."""
        key = key or self.key(account_id)
        if key is None:
            return "no_session"
        if self.require_proxy and key[1] is None:
            return "no_proxy"
        if self._expired.get(account_id) == key[0]:
            return "session_expired"
        return None

    def status(self, account_id: str) -> str:
        """`active` means a frame has arrived since the pump started, not live connectivity."""
        key = self.key(account_id)
        blocked = self.blocker(account_id, key)
        if blocked:
            return blocked
        pump = self._pumps.get(account_id)
        if pump is not None and pump.key == key and account_id in self._live:
            return "active"
        return "connecting"

    def mark_expired(self, aid: str, key: Key | None = None) -> None:
        """Mark this session expired and announce `account.session_expired` once per session.
        `key` is the pump's; None means the current session (a REST call OF refused). The next
        reconcile stops the pump; a new session (re-connect) clears the mark."""
        current = self.key(aid)
        key = key or current
        if key is None or self._expired.get(aid) == key[0]:
            return
        log.warning("session expired account=%s", aid)
        self._expired[aid] = key[0]
        if current == key:  # a pump outlived by a new session or proxy announces nothing
            self.hub.publish(events.account_event(
                "account.session_expired", int(aid), key[0], "session_expired",
                events.iso(datetime.now(UTC))))

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
        key = self.key(aid)
        if key is None or self.blocker(aid, key):
            await self._stop(aid)
            return
        pump = self._pumps.get(aid)
        if pump is not None and pump.key == key and not pump.task.done():
            return
        # New session or proxy (or a pump that died): rebuild the client from disk.
        await self._stop(aid)
        self._expired.pop(aid, None)
        client_pool.evict(aid)
        self._pumps[aid] = _Pump(asyncio.create_task(self._pump(aid, key)), key)

    async def _pump(self, aid: str, key: Key) -> None:
        account_id = int(aid)
        poll: asyncio.Task | None = None
        try:
            client = await asyncio.to_thread(self.client_factory, aid)
            if self.require_proxy and not getattr(client, "proxy_url", None):
                # Fail closed; the next reconcile retries.
                log.warning("client for account=%s has no proxy: not connecting", aid)
                return
            if self.poller is not None:
                poll = asyncio.create_task(self.poller(
                    account_id, client, self.hub.publish, lambda: self.mark_expired(aid, key)))
                poll.add_done_callback(lambda t: _poller_ended(aid, t))
            async for frame in self.source(client):
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
            self.mark_expired(aid, key)
        except Exception:  # restarted by the next reconcile
            log.exception("pump failed account=%s", aid)
        finally:
            if poll is not None:
                poll.cancel()
                await asyncio.wait([poll])  # an exception it ended with is logged by `_poller_ended`
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


def _poller_ended(aid: str, task: asyncio.Task) -> None:
    if not task.cancelled() and (exc := task.exception()) is not None:
        log.error("sent poller failed account=%s: no messages.sent until the pump restarts", aid, exc_info=exc)


def _session_mtime(account_id: str) -> float | None:
    """mtime of the account's `latest.json`: changes exactly when a session lands."""
    if accounts.latest_session_path(account_id) is None:
        return None
    try:
        return (accounts.account_dir(account_id) / "latest.json").stat().st_mtime
    except (FileNotFoundError, accounts.NotAnAccountId):
        return None

"""`chat_queue.finished` from the mass-message history: OF's socket says nothing about broadcasts.

One task per account, started and cancelled with its socket pump. Every `interval` seconds it reads the account's
mass-message history for the last 24 hours (one request, one page of PAGE_LIMIT) and publishes each broadcast the
first time a poll lists it with `sentCount` above 0. OF writes a history entry after the broadcast's last copy, with
its final count, so a listed broadcast has finished. The payload is the entry as OF returned it (`id` is the queue
id); `ts` is its `date`. Later changes (views, a cancel, an unsend) publish nothing.

Limits, each a documented loss: a broadcast that reached nobody; one dated more than two intervals before the
poller started (the floor); one OF could not be read for in the 24 hours after it; past PAGE_LIMIT broadcasts in
24 hours, the ones OF leaves off its page (it ignores `offset`).

State is in memory; a restart reads back to the floor and the gateway ledger's dedup key drops repeats.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import events
from poll_loop import Publish

log = logging.getLogger("upstream.mass_poller")

LOOKBACK = timedelta(hours=24)
PAGE_LIMIT = 50

def _of_date(dt: datetime) -> str:
    """OF's date bound for this call, `YYYY-MM-DD HH:MM:SS`, read as UTC."""
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")


def _items(resp: Any) -> list[dict]:
    """The dict entries of OF's mass history (`{hasMore, items}`). Anything else (for example a JSON `null` body,
    which arrives as None) raises, so the poll loop backs off and nothing is recorded as published."""
    if not isinstance(resp, dict) or not isinstance(resp.get("items"), list):
        raise TypeError("unexpected OF mass history shape")
    return [i for i in resp["items"] if isinstance(i, dict)]


class MassPoller:
    def __init__(self, account_id: int, client: Any, publish: Publish, *, interval: float,
                 now: Callable[[], datetime] | None = None) -> None:
        self.account_id = account_id
        self.client = client
        self.publish = publish
        self.interval = interval
        self.now = now or (lambda: datetime.now(UTC))
        self.emitted: set[int] = set()   # queue ids already published
        # An entry dated before this is never published, so a start does not replay the day.
        self.floor = self.now() - timedelta(seconds=2 * interval)
        self._warned = False

    async def poll(self) -> None:
        now = self.now()
        resp = await asyncio.to_thread(
            self.client.mass_message_history, start_date=_of_date(now - LOOKBACK), end_date=_of_date(now),
            limit=PAGE_LIMIT)
        items = _items(resp)
        if len(items) >= PAGE_LIMIT and not self._warned:
            self._warned = True
            log.warning("mass poller: OF listed %d broadcasts in 24 hours account=%s; some may arrive late or not "
                        "at all", len(items), self.account_id)
        listed = [(qid, e) for e in items if (qid := events.int_or_none(e.get("id"))) is not None]
        for queue_id, entry in sorted(listed, key=lambda pair: pair[0]):  # stable: a repeated id's first stays first
            sent, date = events.int_or_none(entry.get("sentCount")), events.parse_time(entry.get("date"))
            if queue_id in self.emitted or (sent or 0) <= 0 or (date is not None and date < self.floor):
                continue
            self.emitted.add(queue_id)
            log.info("mass poller: chat_queue.finished account=%s queue=%s sentCount=%s",
                     self.account_id, queue_id, sent)
            self.publish(events.chat_queue_finished(self.account_id, queue_id, entry, now))

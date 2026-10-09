"""`messages.sent` from the chat list: OF's socket never delivers an account's own messages.

One task per account, started and cancelled with its socket pump. Every `interval` seconds it reads the top of
`/chats?order=recent` and queues each chat whose `lastMessage` is not the one its messages were last read up to;
then it reads the queued chats' new messages, first queued first, and publishes the account's own DMs as
`messages.sent` with the chat's `withUser` as `toUser`. Queued sends (`isFromQueue`, which include broadcast copies;
a mass message does not move a chat in OF's list) are skipped: DMs only.

Limits, each a documented loss: OF's list puts unread chats first and returns 10-20 chats a page whatever
`limit` asks, so with more than about 50 unread chats the read chats below them are not reached; a chat is read back
at most CHAT_PAGES pages (about 30 messages) a poll; past PENDING_MAX queued chats the first queued (within
one scan, the most recently active) are dropped.

State is in memory; a restart reads chats changed since `now - 2 * interval` and the gateway ledger's dedup key drops
repeats.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import events
import poll_loop

log = logging.getLogger("upstream.sent_poller")

PAGE_LIMIT = 50
MAX_PAGES = 5         # chat-list pages per poll
MAX_FETCHES = 8       # message pages per poll, over all chats
MESSAGES_LIMIT = 10
CHAT_PAGES = 3        # message pages per chat per poll
PENDING_MAX = 200     # changed chats waiting for a fetch

Publish = Callable[[dict], None]
Changed = dict[int, tuple[int, Any]]   # chat id -> (lastMessage.id, withUser)


def _page(resp: Any) -> tuple[list[dict], bool]:
    """A list page of OF's (`{list, hasMore}`): its dict items and whether more follow. Anything else (for example a JSON
    `null` body, which arrives as None) raises, so `run()` backs off and nothing is recorded as read."""
    if not isinstance(resp, dict) or not isinstance(resp.get("list"), list):
        raise TypeError("unexpected OF page shape")
    return [i for i in resp["list"] if isinstance(i, dict)], bool(resp.get("hasMore"))


class SentPoller:
    name = "sent"
    log = log

    def __init__(self, account_id: int, client: Any, publish: Publish, *, interval: float,
                 now: Callable[[], datetime] | None = None) -> None:
        self.account_id = account_id
        self.client = client
        self.publish = publish
        self.interval = interval
        self.last_seen: dict[int, int] = {}   # chat id -> the newest message id its messages were read up to
        self.pending: Changed = {}            # changed chats not yet read, first queued first
        # A chat not read before is read back to here, so the first poll covers two intervals.
        self.floor = (now or (lambda: datetime.now(UTC)))() - timedelta(seconds=2 * interval)
        self._warned: set[str] = set()

    async def poll(self) -> None:
        for chat_id, value in (await self._scan()).items():
            self.pending[chat_id] = value   # a chat already pending keeps its place
        while len(self.pending) > PENDING_MAX:
            del self.pending[next(iter(self.pending))]
            self._warn_once("pending", "sent poller: more than %d chats waiting account=%s; the first queued are dropped",
                            PENDING_MAX, self.account_id)
        await self._fetch()

    async def _scan(self) -> Changed:
        """The top of the chat list: the chats whose last message is not `last_seen`. A chat not seen before whose
        last message is older than the floor is recorded as read. Stops after a page with a read, unchanged
        chat: read chats come newest first, so the ones below it are unchanged too."""
        changed: Changed = {}
        offset = 0
        for _ in range(MAX_PAGES):
            page = await asyncio.to_thread(
                self.client.list_chats, limit=PAGE_LIMIT, order="recent", offset=offset)
            chats, more = _page(page)
            if not chats:
                break
            stop = False
            for chat in chats:
                lm = chat.get("lastMessage")
                chat_id = events.user_id(chat.get("withUser"))
                if not isinstance(lm, dict) or chat_id is None:
                    continue
                lm_id, created = events.int_or_none(lm.get("id")), events.parse_time(lm.get("createdAt"))
                if lm_id is None or created is None:
                    continue
                if chat_id not in self.last_seen and created < self.floor:
                    self.last_seen[chat_id] = lm_id
                if lm_id != self.last_seen.get(chat_id):
                    changed.setdefault(chat_id, (lm_id, chat.get("withUser")))
                elif not events.int_or_none(chat.get("unreadMessagesCount")):
                    stop = True
            if stop or not more:
                break
            next_offset = events.int_or_none(page.get("nextOffset"))
            offset = next_offset if next_offset is not None and next_offset > offset else offset + len(chats)
        return changed

    async def _fetch(self) -> None:
        """Read the pending chats first queued first and publish their new own DMs, at most MAX_FETCHES message pages a
        poll. A chat the cap cuts stays pending with nothing published; it is read again from the start."""
        fetches = 0
        for chat_id, (lm_id, with_user) in list(self.pending.items()):
            seen = self.last_seen.get(chat_id)
            found: list[dict] = []   # newest first
            newest = lm_id           # the newest message read; the scanned one when the chat lists none
            before_id = None
            for _ in range(CHAT_PAGES):
                if fetches >= MAX_FETCHES:
                    return
                fetches += 1
                page = await asyncio.to_thread(
                    self.client.get_messages, chat_id, limit=MESSAGES_LIMIT, before_id=before_id)
                msgs, more = _page(page)
                if before_id is None and msgs:   # the first page: a message sent since the scan is on it
                    newest = events.int_or_none(msgs[0].get("id")) or lm_id
                new = list(itertools.takewhile(lambda m, seen=seen: self._new(m, seen), msgs))
                found += new
                before_id = events.int_or_none(msgs[-1].get("id")) if msgs else None
                if len(new) < len(msgs) or not more or before_id is None:
                    break
            else:
                self._warn_once("chat_pages", "sent poller: more than %d message pages in one chat since the last "
                                "poll account=%s chat=%s; its older sends are skipped",
                                CHAT_PAGES, self.account_id, chat_id)
            for msg in reversed(found):  # oldest first
                self._emit(msg, with_user)
            self.last_seen[chat_id] = newest
            del self.pending[chat_id]

    def _new(self, msg: dict, seen: int | None) -> bool:
        """Newer than `seen`, the chat's last read message id (OF's ids grow with time); in a chat not read
        before, sent since the floor."""
        if seen is not None:
            message_id = events.int_or_none(msg.get("id"))
            return message_id is None or message_id > seen
        created = events.parse_time(msg.get("createdAt"))
        return created is None or created >= self.floor

    def _emit(self, msg: dict, with_user: Any) -> None:
        ev = events.sent_message(self.account_id, msg, with_user)
        if ev is not None:
            self.publish(ev)

    def _warn_once(self, key: str, msg: str, *args: Any) -> None:
        if key not in self._warned:
            self._warned.add(key)
            log.warning(msg, *args)


async def run(account_id: int, client: Any, publish: Publish, on_expired: Callable[[], None], *,
              interval: float) -> None:
    """The Supervisor's poller (app.py binds `interval`): one `SentPoller` per pump start."""
    await poll_loop.run(SentPoller(account_id, client, publish, interval=interval), on_expired)

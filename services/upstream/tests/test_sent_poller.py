"""sent_poller against OFFake: chat-list shapes as OF answers them (`order=recent`, `skip_users=all`)."""
import asyncio
import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from conftest import OFFake

from sent_poller import SentPoller

ACCT = 1001  # OFFake's user_id
T0 = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
INTERVAL = 120


def at(seconds: float) -> str:
    """OF's createdAt for T0 + seconds."""
    return (T0 + timedelta(seconds=seconds)).isoformat()


def message(mid, t, from_id, *, queue=False):
    return {
        "responseType": "message", "text": "<p>text</p>", "giphyId": None, "lockedText": False, "isFree": True,
        "price": 0, "isMediaReady": True, "mediaCount": 0, "media": [], "previews": [], "isTip": False,
        "isReportedByMe": False, "isCouplePeopleMedia": False, "queueId": 48300000000 + mid,
        "isMarkdownDisabled": False, "releaseForms": [], "fromUser": {"id": from_id, "_view": "s"},
        "isFromQueue": queue, "id": mid, "isOpened": False, "isNew": False, "createdAt": at(t),
        "changedAt": at(t), "cancelSeconds": 0, "isLiked": False, "canPurchase": False,
        "canPurchaseReason": "free", "canReport": True, "canBePinned": True, "isPinned": False,
        "isAddedToBookmarks": False,
    }


def chat(fan, lm_id, t, *, own=True, unread=0, queue=None, null=False, **extra):
    lm = None if null else {
        "id": lm_id, "isOpened": False, "createdAt": at(t), "text": "<p>text</p>", "giphyId": None,
        "lockedText": False, "isFree": True, "mediaCount": 0, "isTip": False,
        "fromUser": {"id": ACCT if own else fan, "_view": "i"},
    }
    if lm is not None and queue is not None:
        lm["isFromQueue"] = queue
    return {
        "withUser": {"id": fan, "_view": "s"}, "canNotSendReason": None, "canSendMessage": True,
        "canGoToProfile": True, "unreadMessagesCount": unread, "hasUnreadTips": False,
        "isMutedNotifications": False, "lastMessage": lm, "lastReadMessageId": lm_id,
        "hasPurchasedFeed": False, "countPinnedMessages": 0, "isCallReady": False, **extra,
    }


def chats(*items, more=False, next_offset=None):
    page = {"list": list(items), "hasMore": more}
    if next_offset is not None:
        page["nextOffset"] = next_offset
    return page


def messages(*items, more=False):
    """A page of a chat's messages, newest first."""
    return {"list": list(items), "hasMore": more}


@pytest.fixture
def of():
    return OFFake()


@pytest.fixture
def frames():
    return []


@pytest.fixture
def poller(of, frames):
    return SentPoller(ACCT, of, frames.append, interval=INTERVAL, now=lambda: T0)


def poll(p):
    asyncio.run(p.poll())


def paths(of):
    return [urlsplit(url).path.removeprefix("/api2/v2") for _, url, _ in of.calls]


def query(of, i):
    return {k: v[0] for k, v in parse_qs(urlsplit(of.calls[i][1]).query).items()}


def ids(frames):
    return [f["id"] for f in frames]


def test_start_reads_from_two_intervals_back_and_emits_a_dm_once(poller, of, frames):
    page = chats(chat(2001, 11, -60), chat(2002, 12, -2 * INTERVAL - 1))
    of.respond(page)
    of.respond(messages(message(11, -60, ACCT), message(10, -500, 2001)))
    poll(poller)
    assert paths(of) == ["/chats", "/chats/2001/messages"]  # 2002 is older than now - 2 * interval
    assert query(of, 0) == {"limit": "50", "order": "recent", "offset": "0", "skip_users": "all"}
    assert query(of, 1)["limit"] == "10"
    [ev] = frames
    assert ev["id"] == f"message.sent:{ACCT}:11" and ev["type"] == "messages.sent"
    assert ev["account_id"] == ACCT and ev["ts"] == "2026-10-09T11:59:00.000Z"
    assert ev["payload"]["toUser"] == {"id": 2001, "_view": "s"}
    assert ev["payload"]["fromUser"]["id"] == ACCT and ev["payload"]["queueId"] == 48300000011
    of.respond(page)
    poll(poller)
    assert len(of.calls) == 3 and len(frames) == 1


def test_a_fan_reply_is_fetched_once_and_emits_nothing(poller, of, frames):
    page = chats(chat(2001, 21, -30, own=False))
    of.respond(page)
    of.respond(messages(message(21, -30, 2001), message(20, -900, ACCT)))
    poll(poller)
    of.respond(page)
    poll(poller)
    assert paths(of) == ["/chats", "/chats/2001/messages", "/chats"] and frames == []


def test_a_dm_followed_by_a_fan_reply_is_emitted(poller, of, frames):
    of.respond(chats(chat(2001, 31, -10, own=False)))
    of.respond(messages(message(31, -10, 2001), message(30, -40, ACCT)))
    poll(poller)
    assert ids(frames) == [f"message.sent:{ACCT}:30"]


def test_two_dms_in_a_row_are_both_emitted_oldest_first(poller, of, frames):
    of.respond(chats(chat(2001, 41, -10)))
    of.respond(messages(message(41, -10, ACCT), message(40, -20, ACCT), message(39, -30, 2001)))
    poll(poller)
    assert ids(frames) == [f"message.sent:{ACCT}:40", f"message.sent:{ACCT}:41"]


def test_a_dm_before_a_broadcast_copy_is_emitted_and_the_copy_is_not(poller, of, frames):
    page = chats(chat(2001, 51, -10, queue=True))
    of.respond(page)
    of.respond(messages(message(51, -10, ACCT, queue=True), message(50, -20, ACCT)))
    poll(poller)
    assert paths(of) == ["/chats", "/chats/2001/messages"]
    assert ids(frames) == [f"message.sent:{ACCT}:50"]
    of.respond(page)
    poll(poller)
    assert paths(of)[2:] == ["/chats"] and len(frames) == 1


def test_queued_messages_in_a_fetched_chat_are_skipped(poller, of, frames):
    of.respond(chats(chat(2001, 53, -10)))
    of.respond(messages(message(53, -10, ACCT), message(52, -20, ACCT, queue=True)))
    poll(poller)
    assert ids(frames) == [f"message.sent:{ACCT}:53"]


def test_a_null_last_message_is_skipped(poller, of, frames):
    of.respond(chats(chat(2001, 0, 0, null=True), chat(2002, 61, -10)))
    of.respond(messages(message(61, -10, ACCT)))
    poll(poller)
    assert paths(of) == ["/chats", "/chats/2002/messages"]
    assert ids(frames) == [f"message.sent:{ACCT}:61"]


def test_paging_stops_after_a_page_ending_with_a_read_old_chat(poller, of, frames):
    of.respond(chats(chat(2001, 71, -9000, unread=2), chat(2002, 72, -9000), more=True, next_offset=20))
    poll(poller)
    assert paths(of) == ["/chats"] and frames == []


def test_paging_continues_past_unread_and_pinned_chats(poller, of, frames):
    of.respond(chats(chat(2001, 71, -9000, unread=2), chat(2002, 72, -9000, isPinned=True),
                     more=True, next_offset=20))
    of.respond(chats(more=False))
    poll(poller)
    assert paths(of) == ["/chats", "/chats"] and query(of, 1)["offset"] == "20"
    assert frames == []


def test_a_dm_in_a_read_chat_below_two_pages_of_unread_chats_is_emitted(poller, of, frames):
    of.respond(chats(*(chat(f, f, -9000, unread=1, own=False) for f in range(4001, 4011)), more=True))
    of.respond(chats(*(chat(f, f, -9000, unread=1, own=False) for f in range(4011, 4021)), more=True))
    of.respond(chats(chat(2001, 91, -10), chat(2002, 92, -9000), more=True))
    of.respond(messages(message(91, -10, ACCT)))
    poll(poller)
    assert paths(of) == ["/chats"] * 3 + ["/chats/2001/messages"]
    assert [query(of, i)["offset"] for i in range(3)] == ["0", "10", "20"]
    assert ids(frames) == [f"message.sent:{ACCT}:91"]


def test_a_new_chat_is_paged_back_to_the_floor(poller, of, frames):
    # 12 messages in one chat on 2 pages; the second page reaches past the floor, so no third.
    newest = [message(m, -m, ACCT if m % 2 else 2001) for m in range(1, 7)]
    older = [message(m, -m * 20, ACCT if m % 2 else 2001) for m in range(7, 12)] + [message(12, -300, 2001)]
    of.respond(chats(chat(2001, 1, -1)))
    of.respond(messages(*newest, more=True))
    of.respond(messages(*older, more=True))
    poll(poller)
    assert paths(of) == ["/chats", "/chats/2001/messages", "/chats/2001/messages"]
    assert "id" not in query(of, 1) and query(of, 2)["id"] == "6"
    # Every own send (odd ids, down to 11 at -220 s) is after the floor, now - 2 * interval = -240 s.
    assert ids(frames) == [f"message.sent:{ACCT}:{m}" for m in (11, 9, 7, 5, 3, 1)]


def test_page_and_fetch_caps_leave_the_rest_for_the_next_poll(poller, of, frames):
    # 5 pages of 2 unread chats each; a 6th page is never read. 8 message fetches a poll, so 2 chats
    # wait for the next poll.
    fans = list(range(3001, 3011))
    times = [-10 - 2 * i for i in range(8)] + [-200, -202]
    pages = [chats(*(chat(f, f, t, unread=1) for f, t in zip(fans[i:i + 2], times[i:i + 2], strict=True)),
                   more=True, next_offset=i + 2) for i in range(0, 10, 2)]
    for p in pages:
        of.respond(p)
    for f, t in zip(fans[:8], times[:8], strict=True):
        of.respond(messages(message(f, t, ACCT)))
    poll(poller)
    assert paths(of).count("/chats") == 5 and len(of.calls) == 5 + 8
    assert len(frames) == 8
    for p in pages:
        of.respond(p)
    for f, t in zip(fans[8:], times[8:], strict=True):
        of.respond(messages(message(f, t, ACCT)))
    poll(poller)
    assert paths(of)[13:] == ["/chats"] * 5 + [f"/chats/{f}/messages" for f in fans[8:]]
    assert sorted(ids(frames)) == sorted(f"message.sent:{ACCT}:{f}" for f in fans)


def test_a_repeat_poll_of_identical_pages_emits_and_fetches_nothing(poller, of, frames):
    page = chats(chat(2001, 81, -10), chat(2002, 82, -20, own=False), chat(2003, 83, -30, queue=True))
    of.respond(page)
    of.respond(messages(message(81, -10, ACCT)))
    of.respond(messages(message(82, -20, 2002)))
    of.respond(messages(message(83, -30, ACCT, queue=True)))
    poll(poller)
    assert len(frames) == 1 and len(of.calls) == 4
    of.respond(page)
    poll(poller)
    assert len(frames) == 1 and len(of.calls) == 5



class Inbox:
    """A client serving an account's chats as OF orders read ones (newest first, 10 a page) and each chat's
    messages 10 a page; `fetched` lists the chat id of each message page requested."""

    def __init__(self):
        self.chats = {}   # fan -> [(id, t, from id)], newest first
        self.fetched = []
        self.last_id = 1000

    def say(self, fan, t, *, mine):
        self.last_id += 1
        self.chats.setdefault(fan, []).insert(0, (self.last_id, t, ACCT if mine else fan))
        return self.last_id

    def list_chats(self, *, limit, order, offset):
        rows = sorted(self.chats.items(), key=lambda row: row[1][0][1], reverse=True)
        return chats(*(chat(fan, ms[0][0], ms[0][1], own=ms[0][2] == ACCT) for fan, ms in rows[offset:offset + 10]),
                     more=offset + 10 < len(rows), next_offset=offset + 10)

    def get_messages(self, chat_id, *, limit, before_id):
        self.fetched.append(chat_id)
        older = [m for m in self.chats[chat_id] if before_id is None or m[0] < before_id]
        return messages(*(message(*m) for m in older[:10]), more=len(older) > 10)


@pytest.fixture
def inbox(frames):
    box = Inbox()
    box.poller = SentPoller(ACCT, box, frames.append, interval=INTERVAL, now=lambda: T0)
    box.say(4999, -9000, mine=False)   # an old read chat: no scan reads past it
    return box


def fetched_by_poll(box):
    start = len(box.fetched)
    poll(box.poller)
    return box.fetched[start:]


def test_under_load_every_dm_is_emitted_once_and_waiting_chats_go_first(inbox, frames):
    own = []

    def activity(fans, t):
        """An own DM in each chat, then a fan reply in the even ones, one second apart."""
        for i, fan in enumerate(fans):
            own.append(inbox.say(fan, t + i, mine=True))
            if fan % 2 == 0:
                inbox.say(fan, t + i, mine=False)

    activity(range(5001, 5011), -100)   # 10 changed chats
    assert fetched_by_poll(inbox) == list(range(5010, 5002, -1))
    activity(range(5011, 5019), 0)     # 8 new chats, 5009 again, 12 messages in 5010: 10 changed + 2 waiting
    activity([5009], 8)
    for i in range(12):   # own and fan's in turn
        mid = inbox.say(5010, 10 + i, mine=i % 2 == 0)
        if i % 2 == 0:
            own.append(mid)
    # The 2 waiting chats first; 5010 needs the 2 pages that hold its 12 new messages, 5009 one.
    assert fetched_by_poll(inbox) == [5002, 5001, 5010, 5010, 5009, 5018, 5017, 5016]
    activity([5001, 5009, 5016, 5017, 5018, *range(5019, 5024)], 100)   # 10 changed + 5 waiting
    assert fetched_by_poll(inbox) == [5015, 5014, 5013, 5012, 5011, 5023, 5022, 5021]
    assert fetched_by_poll(inbox) == [5020, 5019, 5018, 5017, 5016, 5009, 5001]
    assert fetched_by_poll(inbox) == []
    emitted = [int(i.rsplit(":", 1)[1]) for i in ids(frames)]
    assert sorted(emitted) == sorted(own)


def test_a_chat_past_three_pages_is_read_up_to_them_and_then_counts_as_read(inbox, frames, caplog):
    first = inbox.say(5001, -50, mine=True)
    poll(inbox.poller)
    sent = [inbox.say(5001, i, mine=True) for i in range(35)]
    with caplog.at_level(logging.WARNING, logger="upstream.sent_poller"):
        assert fetched_by_poll(inbox) == [5001] * 3
    assert [int(i.rsplit(":", 1)[1]) for i in ids(frames)] == [first, *sent[5:]]
    assert "more than 3 message pages in one chat" in caplog.text
    assert fetched_by_poll(inbox) == []


def test_past_the_cap_the_oldest_waiting_chats_are_dropped(inbox, monkeypatch, caplog):
    monkeypatch.setattr("sent_poller.PENDING_MAX", 3)
    monkeypatch.setattr("sent_poller.MAX_FETCHES", 1)
    for fan in range(5001, 5006):
        inbox.say(fan, fan - 5000, mine=True)
    with caplog.at_level(logging.WARNING, logger="upstream.sent_poller"):
        assert fetched_by_poll(inbox) == [5003]   # 5005 and 5004, scanned first, were dropped
    assert "more than 3 chats waiting" in caplog.text


def test_a_re_fetch_stops_at_the_last_read_message(inbox, frames):
    # 12 read messages, all after the floor: only the last read id, not the floor, ends the re-fetch.
    for i in range(12):
        inbox.say(5001, -100 + i, mine=True)
    assert fetched_by_poll(inbox) == [5001, 5001]
    inbox.poller.emitted.clear()
    sent = inbox.say(5001, 0, mine=True)
    assert fetched_by_poll(inbox) == [5001]
    assert ids(frames)[12:] == [f"message.sent:{ACCT}:{sent}"]


def test_a_message_sent_between_scan_and_fetch_is_published_once(inbox, frames):
    first = inbox.say(5001, -10, mine=True)
    read = inbox.get_messages
    late = []

    def get_messages(chat_id, **kw):
        if not late:
            late.append(inbox.say(5001, -5, mine=True))
        return read(chat_id, **kw)

    inbox.get_messages = get_messages
    poll(inbox.poller)
    assert fetched_by_poll(inbox) == [5001]   # its last message is not the scanned one
    assert ids(frames) == [f"message.sent:{ACCT}:{m}" for m in (first, *late)]


def test_a_waiting_chat_that_changes_again_is_fetched_once(inbox, frames, monkeypatch):
    monkeypatch.setattr("sent_poller.MAX_FETCHES", 1)
    inbox.say(5001, -20, mine=True)
    inbox.say(5002, -10, mine=True)
    assert fetched_by_poll(inbox) == [5002]
    inbox.say(5001, -5, mine=True)
    assert fetched_by_poll(inbox) == [5001]
    assert fetched_by_poll(inbox) == []   # its newest message, not the first scanned, was recorded
    assert len(frames) == 3


class Done(Exception):
    pass


def run(poller, sleeps, n, on_expired=lambda: None):
    """Run the loop until its `n`th sleep; the slept seconds land in `sleeps`."""
    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == n:
            raise Done

    async def main():
        await poller.run(on_expired, sleep=sleep)

    asyncio.run(main())


def test_429_sleeps_retry_after_or_doubles_and_resets_after_a_clean_poll(poller, of):
    def retry_after(seconds):
        return {"content-type": "application/json", "retry-after": seconds}

    of.respond({"error": {"code": 0}}, status=429, headers=retry_after("7"))  # never below the interval
    of.respond({"error": {"code": 0}}, status=429, headers=retry_after("300"))
    of.respond({"error": {"code": 0}}, status=429)
    of.respond(chats())
    of.respond({"error": {"code": 0}}, status=429)
    sleeps = []
    with pytest.raises(Done):
        run(poller, sleeps, 5)
    assert sleeps == [INTERVAL, 300, 2 * INTERVAL, INTERVAL, 2 * INTERVAL]


def test_any_other_failure_is_logged_once_and_backed_off(poller, of, caplog):
    of.fail(RuntimeError("boom"))
    of.respond({"error": {"code": 0}}, status=500)
    of.respond(chats())
    sleeps = []
    with caplog.at_level(logging.WARNING, logger="upstream.sent_poller"), pytest.raises(Done):
        run(poller, sleeps, 3)
    assert sleeps == [2 * INTERVAL, 4 * INTERVAL, INTERVAL]
    assert [r.getMessage() for r in caplog.records if "failed" in r.getMessage()] == [
        f"sent poller failed account={ACCT} status=None: retrying in {2 * INTERVAL}s"]


def test_a_null_message_page_backs_off_and_the_chat_is_read_on_the_next_poll(poller, of, frames):
    page = chats(chat(2001, 11, -60))
    of.respond(page)
    of.respond(None)   # a `null` body: the page is None
    of.respond(page)
    of.respond(messages(message(11, -60, ACCT)))
    sleeps = []
    with pytest.raises(Done):
        run(poller, sleeps, 2)
    assert sleeps == [2 * INTERVAL, INTERVAL]
    assert paths(of) == ["/chats", "/chats/2001/messages"] * 2
    assert ids(frames) == [f"message.sent:{ACCT}:11"]


@pytest.mark.parametrize(("status", "body"), [(401, {"error": {"code": 0}}), (400, {"error": {"code": 301}})])
def test_a_refused_session_calls_on_expired_and_ends(poller, of, status, body):
    of.respond(body, status=status)
    expired, sleeps = [], []
    run(poller, sleeps, 99, on_expired=lambda: expired.append(1))
    assert expired == [1] and sleeps == []

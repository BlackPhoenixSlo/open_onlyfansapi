"""mass_poller against OFFake: mass-message history entries as OF answers them (`date` with a `+00:00` offset)."""
import asyncio
import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from conftest import Done, OFFake, mass_entry, run_loop

from mass_poller import MassPoller
from of_client import OFAPIError

ACCT = 1001  # OFFake's user_id
T0 = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
INTERVAL = 120


def at(seconds: float) -> str:
    """OF's `date` for T0 + seconds."""
    return (T0 + timedelta(seconds=seconds)).isoformat()


def entry(qid, t, sent, **extra):
    return mass_entry(qid, at(t), sent, **extra)


def history(*entries):
    return {"hasMore": True, "items": list(entries)}


@pytest.fixture
def of():
    return OFFake()


@pytest.fixture
def frames():
    return []


@pytest.fixture
def clock():
    return [T0]


@pytest.fixture
def poller(of, frames, clock):
    return MassPoller(ACCT, of, frames.append, interval=INTERVAL, now=lambda: clock[0])


def poll(p):
    asyncio.run(p.poll())


def ids(frames):
    return [f["id"] for f in frames]


def test_each_poll_is_one_request_for_the_last_24_hours_in_utc(poller, of):
    of.respond(history())
    poll(poller)
    [(method, url, _)] = of.calls
    assert method == "GET" and urlsplit(url).path == "/api2/v2/users/me/stats/messages/group"
    assert {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()} == {
        "startDate": "2026-10-08 12:00:00", "endDate": "2026-10-09 12:00:00", "limit": "50", "offset": "0"}


def test_a_listed_broadcast_is_published_once(poller, of, frames):
    served = entry(900, -30, 1290)
    of.respond(history(served))
    poll(poller)
    assert frames == [{
        "id": f"chat_queue.finished:{ACCT}:900", "type": "chat_queue.finished", "account_id": ACCT,
        "ts": "2026-10-09T11:59:30.000Z", "amount_cents": None, "payload": served,
    }]
    of.respond(history(served))
    poll(poller)
    assert len(frames) == 1


def test_sent_count_zero_is_not_published(poller, of, frames):
    of.respond(history(entry(900, -30, 0)))
    poll(poller)
    assert frames == []
    of.respond(history(entry(900, -30, 5)))
    poll(poller)
    assert ids(frames) == [f"chat_queue.finished:{ACCT}:900"]


def test_entries_before_the_floor_are_not_published(poller, of, frames):
    # The floor is now - 2 * interval = -240 s.
    page = history(entry(901, -241, 5), entry(902, -240, 5))
    for _ in range(2):
        of.respond(page)
        poll(poller)
    assert ids(frames) == [f"chat_queue.finished:{ACCT}:902"]


def test_a_failed_poll_publishes_nothing_and_the_next_one_catches_up(poller, of, frames):
    of.respond({"error": {"code": 0}}, status=500)
    with pytest.raises(OFAPIError, match="500"):
        poll(poller)
    assert frames == []
    of.respond(history(entry(900, -30, 1290)))
    poll(poller)
    assert ids(frames) == [f"chat_queue.finished:{ACCT}:900"]


def test_a_published_broadcast_that_changes_is_not_published_again(poller, of, frames):
    of.respond(history(entry(900, -30, 1290)))
    poll(poller)
    for _ in range(2):
        of.respond(history(entry(900, -30, 1293, viewedCount=55, isCanceled=True)))
        poll(poller)
    assert len(frames) == 1 and frames[0]["payload"]["sentCount"] == 1290


def test_ts_is_the_date_in_utc_or_the_poll_time_when_unreadable(poller, of, frames, clock):
    clock[0] = T0 + timedelta(seconds=60)
    of.respond(history(entry(900, 0, 5, date="2026-10-09T13:59:30+02:00"), entry(901, 0, 5, date=None)))
    poll(poller)
    assert [f["ts"] for f in frames] == ["2026-10-09T11:59:30.000Z", "2026-10-09T12:01:00.000Z"]


def test_malformed_entries_are_skipped(poller, of, frames):
    of.respond(history({}, entry("abc", -30, 5), entry(901, -30, "x"), entry(902, -30, 5, date="yesterday"),
                       entry(903, -30, 5)))
    poll(poller)
    assert [(f["id"], f["ts"]) for f in frames] == [
        (f"chat_queue.finished:{ACCT}:902", "2026-10-09T12:00:00.000Z"),
        (f"chat_queue.finished:{ACCT}:903", "2026-10-09T11:59:30.000Z")]


def test_ids_publish_in_ascending_order(poller, of, frames):
    of.respond(history(entry(902, -10, 5), entry(900, -30, 5), entry(901, -20, 5)))
    poll(poller)
    assert ids(frames) == [f"chat_queue.finished:{ACCT}:{q}" for q in (900, 901, 902)]


def test_a_full_page_warns_once(poller, of, frames, caplog):
    page = history(*(entry(q, -q, 5) for q in range(1, 51)))
    with caplog.at_level(logging.WARNING, logger="upstream.mass_poller"):
        for _ in range(2):
            of.respond(page)
            poll(poller)
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING] == [
        f"mass poller: OF listed 50 broadcasts in 24 hours account={ACCT}; some may arrive late or not at all"]
    assert len(frames) == 50


@pytest.mark.parametrize("body", [None, {"list": []}])
def test_an_unexpected_body_raises(poller, of, frames, body):
    of.respond(body)
    with pytest.raises(TypeError, match="unexpected OF mass history shape"):
        poll(poller)
    assert frames == [] and poller.emitted == set()


def test_a_failure_is_logged_with_the_backoff(poller, of, caplog):
    of.fail(RuntimeError("boom"))
    of.respond(history())
    sleeps = []
    with caplog.at_level(logging.WARNING, logger="upstream.mass_poller"), pytest.raises(Done):
        run_loop(poller, sleeps, 2)
    assert sleeps == [2 * INTERVAL, INTERVAL]
    assert [r.getMessage() for r in caplog.records if "failed" in r.getMessage()] == [
        f"mass poller failed account={ACCT} status=None: retrying in {2 * INTERVAL}s"]

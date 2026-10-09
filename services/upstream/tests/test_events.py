from datetime import UTC, datetime

import pytest
from conftest import frame, key_paths, mass_entry, payload_fixture

from events import chat_queue_finished, classify

ACCOUNT = 100001
NOW = datetime(2026, 10, 2, 12, 30, 0, 123000, tzinfo=UTC)
KEYS = {"id", "type", "account_id", "ts", "amount_cents", "payload"}
NO_FAN_DATA = {"available": False, "last_updated_at": "2026-10-02T12:00:00.000Z",
               "spending": {"total": 0, "messages": 0, "subscribes": 0, "posts": 0, "tips": 0, "streams": 0}}


def test_fan_message_is_messages_received():
    raw = frame("api2_chat_message.received")
    [ev] = classify(ACCOUNT, raw, now=NOW)
    assert set(ev) == KEYS
    assert ev == {
        "id": "message.received:100001:5551234",  # the v4 name: the ledger's dedup key is unchanged
        "type": "messages.received",
        "account_id": ACCOUNT,
        "ts": "2026-10-02T12:00:00.000Z",
        "amount_cents": None,
        "payload": {**raw["api2_chat_message"], "fanData": NO_FAN_DATA},  # OF's message, as the reference
    }


def test_own_message_is_messages_sent():
    raw = frame("api2_chat_message.sent")
    [ev] = classify(ACCOUNT, raw, now=NOW)
    assert ev["type"] == "messages.sent"
    assert ev["id"] == "message.sent:100001:5551235"
    assert ev["ts"] == "2026-10-02T12:00:05.250Z"
    assert ev["amount_cents"] is None
    assert ev["payload"] == raw["api2_chat_message"]  # no fanData on sent messages, as the reference


def test_post_expire():
    [ev] = classify(ACCOUNT, frame("post_expire"), now=NOW)
    assert ev == {"id": "post.expired:100001:4440001", "type": "posts.expired", "account_id": ACCOUNT,
                  "ts": "2026-10-02T12:30:00.123Z", "amount_cents": None, "payload": {"postId": 4440001}}


def test_post_expire_with_a_numeric_id_is_not_a_counter():
    [ev] = classify(ACCOUNT, {"post_expire": 4440001}, now=NOW)
    assert ev["type"] == "posts.expired" and ev["payload"] == {"postId": 4440001}


def test_chat_message_delete_is_messages_deleted():
    [ev] = classify(ACCOUNT, frame("chat_message_delete"), now=NOW)
    assert ev == {"id": "message.deleted:100001:5551234", "type": "messages.deleted", "account_id": ACCOUNT,
                  "ts": "2026-10-02T12:30:00.123Z", "amount_cents": None, "payload": {"id": "5551234"}}


# ─── payload contracts (fixtures/payloads) ─────────────────────────

def _parent(path):
    return path[:-2] if path.endswith("[]") else path.rsplit(".", 1)[0]


def _gaps(fixture_payload, payload):
    """Key paths of the fixture that `payload` lacks, each reported at its topmost missing node."""
    missing = key_paths(fixture_payload) - key_paths(payload)
    return {p for p in missing if _parent(p) not in missing}


# What our OF frames (`fixtures/of_frames/`, reconstructions, not captures) lack against the reference
# product's example: the payload is OF's message as it arrives, so these keys reach a client only when
# OF's frame carries them. A real capture (plan-v4 §9 Q1) replaces the frames and shrinks these sets.
# Our frame's fromUser is {id, _view}: every other key of the reference's 42-key fromUser is a gap. A 2026-10-05
# capture on a subscriber-side account (docs/spec/plan-v6-ws-events.md) saw all 42; creator-side is unverified.
_FROM_USER = [k for k in payload_fixture("messages.received")["payload"]["fromUser"] if k != "id"]
KNOWN_GAPS = {
    "messages.received": {"$.canPurchaseReason", "$.isMarkdownDisabled", "$.replyToMessage",
                          *(f"$.fromUser.{k}" for k in _FROM_USER)},
    "messages.sent": {"$.canPurchaseReason", "$.isMarkdownDisabled", "$.releaseForms", "$.toUser", "$.media[]"},
    # The payload is OF's mass-message history entry, which per the 2026-10-09 live read has no queue state
    # (`pending`, `total`, `isDone`) and no `hasError`, `isReady` or `isCouplePeopleMedia`.
    "chat_queue.finished": {"$.pending", "$.total", "$.isDone", "$.hasError", "$.isReady", "$.isCouplePeopleMedia"},
}


@pytest.mark.parametrize(("event", "of_frame", "frame_id"), [
    ("messages.received", "api2_chat_message.received", "message.received:100001:5551234"),
    ("messages.sent", "api2_chat_message.sent", "message.sent:100001:5551235"),
])
def test_message_payloads_against_the_fixture(event, of_frame, frame_id):
    [ev] = classify(ACCOUNT, frame(of_frame), now=NOW)
    assert (ev["type"], ev["id"]) == (event, frame_id)
    assert _gaps(payload_fixture(event)["payload"], ev["payload"]) == KNOWN_GAPS[event]


def test_chat_queue_finished_against_the_fixture():
    fx = payload_fixture("chat_queue.finished")
    ev = chat_queue_finished(1001, mass_entry(1013, "2026-10-02T12:29:00+00:00", 2), NOW)
    assert (ev["type"], ev["id"]) == (fx["event"], "chat_queue.finished:1001:1013")
    assert _gaps(fx["payload"], ev["payload"]) == KNOWN_GAPS["chat_queue.finished"]


def test_messages_deleted_matches_the_fixture():
    fx = payload_fixture("messages.deleted")
    [ev] = classify(1001, {"chat_message_delete": "1012"}, now=NOW)
    assert (ev["type"], ev["id"], ev["payload"]) == (fx["event"], "message.deleted:1001:1012", fx["payload"])


def test_frame_id_keeps_the_v4_name():
    msg = {**frame("api2_chat_message.received")["api2_chat_message"], "id": 1002}
    [ev] = classify(1001, {"api2_chat_message": msg}, now=NOW)
    assert (ev["type"], ev["id"]) == ("messages.received", "message.received:1001:1002")


def test_posts_expired_matches_the_fixture():
    fx = payload_fixture("posts.expired")
    [ev] = classify(1001, {"post_expire": "1008"}, now=NOW)
    assert (ev["type"], ev["id"], ev["payload"]) == (fx["event"], "post.expired:1001:1008", fx["payload"])


def test_noise_is_dropped():
    assert classify(ACCOUNT, frame("counters"), now=NOW) == []
    assert classify(ACCOUNT, frame("connected"), now=NOW) == []
    assert classify(ACCOUNT, {"online_status": {"200002": True}}, now=NOW) == []
    assert classify(ACCOUNT, {"unread_tips": 1}, now=NOW) == []
    assert classify(ACCOUNT, {"some_new_counter": 4}, now=NOW) == []
    assert classify(ACCOUNT, frame("system_notifications"), now=NOW) == []
    assert classify(ACCOUNT, {"hasSystemNotifications": False}, now=NOW) == []


def test_a_non_numeric_counter_key_passes_through():
    [ev] = classify(ACCOUNT, {"messages": {"anything": 1}}, now=NOW)
    assert (ev["type"], ev["payload"]) == ("upstream.messages", {"anything": 1})


def test_unknown_key_passes_through_raw():
    raw = {"anything": [1, 2]}
    [ev] = classify(ACCOUNT, {"new_message": raw}, now=NOW)
    assert ev == {"id": None, "type": "upstream.new_message", "account_id": ACCOUNT,
                  "ts": "2026-10-02T12:30:00.123Z", "amount_cents": None, "payload": raw}


def test_unmapped_types_are_never_invented():
    # Tips, PPV unlocks and subscriptions stay unemitted until a real frame is captured.
    for key in ("tip", "new_subscriber", "purchase", "story_tips"):
        [ev] = classify(ACCOUNT, {key: {"amount": 5}}, now=NOW)
        assert ev["type"] == f"upstream.{key}"


def test_malformed_frames_yield_nothing():
    assert classify(ACCOUNT, {}, now=NOW) == []
    assert classify(ACCOUNT, {"api2_chat_message": {"text": "no id"}}, now=NOW) == []
    assert classify(ACCOUNT, {"post_expire": None}, now=NOW) == []


def test_unparsable_chat_message_delete_passes_through():
    [ev] = classify(ACCOUNT, {"chat_message_delete": "not-an-id"}, now=NOW)
    assert (ev["type"], ev["id"], ev["payload"]) == ("upstream.chat_message_delete", None, "not-an-id")


def test_dropped_keys_are_logged_once(caplog, monkeypatch):
    import events
    monkeypatch.setattr(events, "_dropped_keys", set())
    with caplog.at_level("WARNING", logger="upstream.events"):
        for _ in range(3):
            classify(ACCOUNT, {"brand_new_counter": 1}, now=NOW)
            classify(ACCOUNT, {"online_status": {}}, now=NOW)
    msgs = [r.getMessage() for r in caplog.records]
    assert len(msgs) == 2
    assert any("'brand_new_counter' as a counter" in m for m in msgs)
    assert any("'online_status' as noise" in m for m in msgs)

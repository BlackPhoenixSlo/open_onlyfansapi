from datetime import UTC, datetime

from conftest import frame

from events import classify

ACCOUNT = 100001
NOW = datetime(2026, 10, 2, 12, 30, 0, 123000, tzinfo=UTC)
KEYS = {"id", "type", "account_id", "ts", "payload"}


def test_fan_message_is_message_received():
    [ev] = classify(ACCOUNT, frame("api2_chat_message.received"), now=NOW)
    assert set(ev) == KEYS
    assert ev == {
        "id": "message.received:100001:5551234",
        "type": "message.received",
        "account_id": ACCOUNT,
        "ts": "2026-10-02T12:00:00.000Z",
        "payload": {"messageId": 5551234, "fanId": 200002, "text": "<p>hey, are you there?</p>",
                    "price": 0, "mediaCount": 1},
    }


def test_own_message_is_message_sent():
    [ev] = classify(ACCOUNT, frame("api2_chat_message.sent"), now=NOW)
    assert ev["type"] == "message.sent"
    assert ev["id"] == "message.sent:100001:5551235"
    assert ev["ts"] == "2026-10-02T12:00:05.250Z"
    assert ev["payload"] == {"messageId": 5551235, "fanId": None, "text": "<p>hi! here now</p>",
                             "price": 5, "mediaCount": 0}


def test_post_expire():
    [ev] = classify(ACCOUNT, frame("post_expire"), now=NOW)
    assert ev == {"id": "post.expired:100001:4440001", "type": "post.expired", "account_id": ACCOUNT,
                  "ts": "2026-10-02T12:30:00.123Z", "payload": {"postId": 4440001}}


def test_post_expire_with_a_numeric_id_is_not_a_counter():
    [ev] = classify(ACCOUNT, {"post_expire": 4440001}, now=NOW)
    assert ev["type"] == "post.expired" and ev["payload"] == {"postId": 4440001}


def test_noise_is_dropped():
    assert classify(ACCOUNT, frame("counters"), now=NOW) == []
    assert classify(ACCOUNT, frame("connected"), now=NOW) == []
    assert classify(ACCOUNT, {"online_status": {"200002": True}}, now=NOW) == []
    assert classify(ACCOUNT, {"unread_tips": 1}, now=NOW) == []
    assert classify(ACCOUNT, {"some_new_counter": 4}, now=NOW) == []


def test_unknown_key_passes_through_raw():
    raw = {"anything": [1, 2]}
    [ev] = classify(ACCOUNT, {"new_message": raw}, now=NOW)
    assert ev == {"id": None, "type": "upstream.new_message", "account_id": ACCOUNT,
                  "ts": "2026-10-02T12:30:00.123Z", "payload": raw}


def test_unmapped_types_are_never_invented():
    # Tips, PPV unlocks and subscriptions stay unemitted until a real frame is captured.
    for key in ("tip", "new_subscriber", "purchase"):
        [ev] = classify(ACCOUNT, {key: {"amount": 5}}, now=NOW)
        assert ev["type"] == f"upstream.{key}"


def test_malformed_frames_yield_nothing():
    assert classify(ACCOUNT, {}, now=NOW) == []
    assert classify(ACCOUNT, {"api2_chat_message": {"text": "no id"}}, now=NOW) == []
    assert classify(ACCOUNT, {"post_expire": None}, now=NOW) == []

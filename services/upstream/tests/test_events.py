from datetime import UTC, datetime

from conftest import frame, key_paths, payload_fixture

from events import classify

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


# ─── payload contracts (fixtures/payloads) ─────────────────────────

def test_messages_received_has_the_fixture_key_paths():
    fx = payload_fixture("messages.received")
    msg = {k: v for k, v in fx["payload"].items() if k != "fanData"}  # OF's frame; fanData is ours
    [ev] = classify(1001, {"api2_chat_message": msg}, now=NOW)
    assert (ev["type"], ev["id"]) == (fx["event"], "message.received:1001:1002")
    assert key_paths(fx["payload"]) <= key_paths(ev["payload"])


def test_messages_sent_has_the_fixture_key_paths():
    fx = payload_fixture("messages.sent")
    msg = {**fx["payload"], "fromUser": {"id": 1001, "_view": "s"}}  # OF names the sender; the reference omits it
    [ev] = classify(1001, {"api2_chat_message": msg}, now=NOW)
    assert (ev["type"], ev["id"]) == (fx["event"], "message.sent:1001:1007")
    assert key_paths(fx["payload"]) <= key_paths(ev["payload"])


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


def test_unknown_key_passes_through_raw():
    raw = {"anything": [1, 2]}
    [ev] = classify(ACCOUNT, {"new_message": raw}, now=NOW)
    assert ev == {"id": None, "type": "upstream.new_message", "account_id": ACCOUNT,
                  "ts": "2026-10-02T12:30:00.123Z", "amount_cents": None, "payload": raw}


def test_unmapped_types_are_never_invented():
    # Tips, PPV unlocks and subscriptions stay unemitted until a real frame is captured.
    for key in ("tip", "new_subscriber", "purchase"):
        [ev] = classify(ACCOUNT, {key: {"amount": 5}}, now=NOW)
        assert ev["type"] == f"upstream.{key}"


def test_malformed_frames_yield_nothing():
    assert classify(ACCOUNT, {}, now=NOW) == []
    assert classify(ACCOUNT, {"api2_chat_message": {"text": "no id"}}, now=NOW) == []
    assert classify(ACCOUNT, {"post_expire": None}, now=NOW) == []


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

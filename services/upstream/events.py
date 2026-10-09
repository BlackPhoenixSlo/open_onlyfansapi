"""OF socket frame -> catalogue events (plan-v4 §2.2, plan-v5 §1.9, §2.4).

The only code that knows OF's WebSocket shapes. `classify` is pure apart from
reading the clock when a frame carries no time of its own (`now` overrides it).
Dropping noise is logged once per key, so losses stay visible.
Mappings exist only for frames a capture has shown (`api2_chat_message`, `post_expire`,
`chat_message_delete`; docs/spec/plan-v6-ws-events.md); every other key, minus the noise below,
is passed through as `upstream.<key>` with its raw value.

Event names are internal (v4) here; `event()` builds the frame id from the internal name and
publishes the public (v5) name in `type`. Payloads follow the reference product's example for
each type; `tests/fixtures/payloads/` holds their key structure.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

log = logging.getLogger("upstream.events")
_dropped_keys: set[str] = set()

# Presence, handshake and counter frames: never forwarded.
NOISE_KEYS = frozenset({
    "connected", "v", "online_status",
    "chat_messages", "count_priority_chat", "unread_tips",
})


def iso(dt: datetime) -> str:
    """ISO-8601 UTC with milliseconds and a `Z`, the §2.2 `ts` format."""
    dt = dt.astimezone(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_time(value: Any) -> datetime | None:
    """OF's ISO time; a naive one is UTC. None when absent or not ISO."""
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _ts(value: Any, now: datetime) -> str:
    return iso(parse_time(value) or now)


def int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def user_id(user: Any) -> int | None:
    return int_or_none(user.get("id")) if isinstance(user, dict) else None


# Internal (v4) name -> public (v5) name (plan-v5 §2.4). Names missing here are public as they are.
PUBLIC = {
    "message.received": "messages.received",
    "message.sent": "messages.sent",
    "ppv.unlocked": "messages.ppv.unlocked",
    "tip.received": "tips.received",
    "subscription.new": "subscriptions.new",
    "subscription.renewed": "subscriptions.renewed",
    "subscription.expired": "subscriptions.expired",
    "account.session_expired": "accounts.session_expired",
    "post.expired": "posts.expired",
    "message.deleted": "messages.deleted",
}


def event(type_: str, account_id: int, object_id: Any, ts: str, payload: Any,
          amount_cents: int | None = None) -> dict:
    """A §2.2 frame. The id keeps the internal name, so the ledger's dedup key survives the rename."""
    return {
        "id": f"{type_}:{account_id}:{object_id}" if object_id is not None else None,
        "type": PUBLIC.get(type_, type_),
        "account_id": account_id,
        "ts": ts,
        "amount_cents": amount_cents,
        "payload": payload,
    }


def account_event(type_: str, account_id: int, mtime: float, state: str, ts: str) -> dict:
    """An `accounts.*` frame for the session whose `latest.json` has `mtime`. The latest authentication
    is the `POST /session/bootstrap` that wrote that session (it never asks for an OTP).

    The id's object part is the mtime in ms; `account.session_expired` keeps v4's whole seconds, so its
    ledger dedup key is unchanged (plan-v5 §2.4)."""
    object_id = int(mtime) if type_ == "account.session_expired" else int(mtime * 1000)
    return event(type_, account_id, object_id, ts, {
        "state": state,
        "progress": "completed",
        "latestAuthAttempt": {
            "started_at": iso(datetime.fromtimestamp(mtime, UTC)),
            "completed_at": ts,
            "success": True,
            "error_message": None,
            "needs_otp": False,
            "needs_face_otp": False,
            "otp_phone_ending": None,
        },
    })


def _fan_data(ts: str) -> dict:
    """The reference product's per-fan spending block. This gateway keeps no spending history, so it
    says so: `available` is false and every amount is 0."""
    return {
        "available": False,
        "last_updated_at": ts,
        "spending": {"total": 0, "messages": 0, "subscribes": 0, "posts": 0, "tips": 0, "streams": 0},
    }


def _chat_message(account_id: int, msg: Any, now: datetime) -> dict | None:
    """OF's message object is the payload, as in the reference product; a received one gains `fanData`."""
    if not isinstance(msg, dict):
        return None
    message_id = int_or_none(msg.get("id"))
    from_id = user_id(msg.get("fromUser"))
    if message_id is None or from_id is None:
        return None
    ts = _ts(msg.get("createdAt"), now)
    if from_id == account_id:
        return event("message.sent", account_id, message_id, ts, msg)
    return event("message.received", account_id, message_id, ts, {**msg, "fanData": _fan_data(ts)})


def sent_message(account_id: int, msg: Any, with_user: Any, now: datetime) -> dict | None:
    """`messages.sent` for one of the account's own DMs read from a chat (sent_poller): the socket's
    frame, with the chat's `withUser` (`{id, _view}`) as `toUser`. None for a fan's message and for a
    queued send (`isFromQueue`: a broadcast copy)."""
    if (not isinstance(msg, dict) or msg.get("isFromQueue") or user_id(msg.get("fromUser")) != account_id
            or (message_id := int_or_none(msg.get("id"))) is None):
        return None
    return event("message.sent", account_id, message_id, _ts(msg.get("createdAt"), now),
                 {**msg, "toUser": with_user})


def chat_queue_finished(account_id: int, queue_id: int, entry: dict, now: datetime) -> dict:
    """`chat_queue.finished` for one of the account's mass-message history entries (mass_poller): the
    entry as OF returned it, `id` the queue id, `ts` its `date` (or `now` when unreadable)."""
    return event("chat_queue.finished", account_id, queue_id, _ts(entry.get("date"), now), entry)


MAPPED_KEYS = frozenset({"api2_chat_message", "post_expire", "chat_message_delete"})


def _drop(keys: Any, why: str) -> None:
    for key in keys:
        if key not in _dropped_keys:
            _dropped_keys.add(key)
            log.warning("dropping OF frame key %r as %s (logged once per key)", key, why)


def _counter_only(frame: dict) -> bool:
    """Unread/priority counters arrive as frames of bare numbers and flags (`hasSystemNotifications`): noise."""
    return not MAPPED_KEYS & frame.keys() and all(isinstance(v, (int, float)) for v in frame.values())


def classify(account_id: int, frame: dict, *, now: datetime | None = None) -> list[dict]:
    """The §2.2 frames one OF socket frame yields (often none)."""
    if not isinstance(frame, dict) or not frame:
        return []
    if _counter_only(frame):
        _drop(frame, "a counter")
        return []
    now = now or datetime.now(UTC)
    out: list[dict] = []
    for key, value in frame.items():
        if key in NOISE_KEYS:
            _drop([key], "noise")
            continue
        if key == "api2_chat_message":
            ev = _chat_message(account_id, value, now)
        elif key == "post_expire":
            post_id = int_or_none(value)
            ev = (event("post.expired", account_id, post_id, iso(now), {"postId": post_id})
                  if post_id is not None else None)
        elif key == "chat_message_delete" and (message_id := int_or_none(value)) is not None:
            ev = event("message.deleted", account_id, message_id, iso(now), {"id": str(message_id)})
        else:
            ev = event(f"upstream.{key}", account_id, None, iso(now), value)
        if ev is not None:
            out.append(ev)
    return out

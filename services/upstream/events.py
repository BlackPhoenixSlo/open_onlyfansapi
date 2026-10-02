"""OF socket frame -> catalogue events (plan-v4 §2.2, §2.3).

The only code that knows OF's WebSocket shapes. `classify` is pure apart from
reading the clock when a frame carries no time of its own (`now` overrides it).
Mappings exist only for frames the lifted code has seen (`api2_chat_message`,
`post_expire`); every other key, minus the noise below, is passed through as
`upstream.<key>` with its raw value.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

# Presence, handshake and counter frames: never forwarded.
NOISE_KEYS = frozenset({
    "connected", "v", "online_status",
    "chat_messages", "count_priority_chat", "unread_tips",
})


def iso(dt: datetime) -> str:
    """ISO-8601 UTC with milliseconds and a `Z`, the §2.2 `ts` format."""
    dt = dt.astimezone(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _ts(value: Any, now: datetime) -> str:
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            return iso(now)
        return iso(dt if dt.tzinfo else dt.replace(tzinfo=UTC))
    return iso(now)


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _user_id(user: Any) -> int | None:
    return _int(user.get("id")) if isinstance(user, dict) else None


def event(type_: str, account_id: int, object_id: Any, ts: str, payload: Any) -> dict:
    return {
        "id": f"{type_}:{account_id}:{object_id}" if object_id is not None else None,
        "type": type_,
        "account_id": account_id,
        "ts": ts,
        "payload": payload,
    }


def _chat_message(account_id: int, msg: Any, now: datetime) -> dict | None:
    if not isinstance(msg, dict):
        return None
    message_id = _int(msg.get("id"))
    from_id = _user_id(msg.get("fromUser"))
    if message_id is None or from_id is None:
        return None
    sent = from_id == account_id
    media = msg.get("media")
    media_count = msg.get("mediaCount")
    if not isinstance(media_count, int):
        media_count = len(media) if isinstance(media, list) else 0
    type_ = "message.sent" if sent else "message.received"
    return event(type_, account_id, message_id, _ts(msg.get("createdAt"), now), {
        "messageId": message_id,
        "fanId": _user_id(msg.get("toUser")) if sent else from_id,
        "text": msg.get("text"),
        "price": msg.get("price"),
        "mediaCount": media_count,
    })


MAPPED_KEYS = frozenset({"api2_chat_message", "post_expire"})


def _counter_only(frame: dict) -> bool:
    """Unread/priority counters arrive as frames of bare numbers: noise."""
    return not MAPPED_KEYS & frame.keys() and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in frame.values())


def classify(account_id: int, frame: dict, *, now: datetime | None = None) -> list[dict]:
    """The §2.2 frames one OF socket frame yields (often none)."""
    if not isinstance(frame, dict) or not frame or _counter_only(frame):
        return []
    now = now or datetime.now(UTC)
    out: list[dict] = []
    for key, value in frame.items():
        if key in NOISE_KEYS:
            continue
        if key == "api2_chat_message":
            ev = _chat_message(account_id, value, now)
        elif key == "post_expire":
            post_id = _int(value)
            ev = (event("post.expired", account_id, post_id, iso(now), {"postId": post_id})
                  if post_id is not None else None)
        else:
            ev = event(f"upstream.{key}", account_id, None, iso(now), value)
        if ev is not None:
            out.append(ev)
    return out

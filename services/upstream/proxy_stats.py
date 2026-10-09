"""Per-proxy traffic counters, keyed by proxy label: how many OF calls went through
each proxy, how many failed in transport (each failed attempt, retries included),
how many OF answered 403/429 (`blocked`), and the last error, success and use.

In-process only: nothing is persisted, so every counter resets when upstream
restarts. `SINCE` is that start, and the dashboard shows "since <SINCE>" next to them.
"""
from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any

SINCE = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
BLOCKED_STATUSES = frozenset({403, 429})

_lock = threading.Lock()
_stats: dict[str, dict[str, Any]] = {}


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _zero() -> dict[str, Any]:
    return {"ok": 0, "failed": 0, "blocked": 0, "last_status": None, "last_ok_at": None,
            "last_error": None, "last_error_at": None, "last_used_at": None}


def _entry(label: str) -> dict[str, Any]:
    return _stats.setdefault(label, _zero())


def record_ok(label: str, status: int | None = None) -> None:
    """A response came back through the proxy (any status); 403/429 also count as `blocked`."""
    with _lock:
        e = _entry(label)
        e["ok"] += 1
        e["last_used_at"] = e["last_ok_at"] = _now()
        if status in BLOCKED_STATUSES:
            e["blocked"] += 1
            e["last_status"] = status


def record_failed(label: str, error: str) -> None:
    """`error`: a short kind and message, e.g. "proxy_error: CONNECT 403"."""
    with _lock:
        e = _entry(label)
        e["failed"] += 1
        e["last_used_at"] = e["last_error_at"] = _now()
        e["last_error"] = error[:200]


def get(label: str) -> dict[str, Any]:
    """A copy of `label`'s counters; zeros when it has carried no traffic since SINCE."""
    with _lock:
        return dict(_stats.get(label) or _zero())


def clear(label: str) -> None:
    """Forget `label`'s counters (its endpoint changed: they described another proxy)."""
    with _lock:
        _stats.pop(label, None)


def reset() -> None:
    """Tests only."""
    with _lock:
        _stats.clear()

"""Per-proxy traffic counters, keyed by proxy label: how many OF calls went through
each proxy, how many failed at the proxy (CONNECT error or timeout), and the last
error and use.

In-process only: nothing is persisted, so every counter resets when upstream
restarts. `SINCE` is that start, and the dashboard shows "since <SINCE>" next to them.
"""
from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any

SINCE = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

_lock = threading.Lock()
_stats: dict[str, dict[str, Any]] = {}


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _zero() -> dict[str, Any]:
    return {"ok": 0, "failed": 0, "last_error": None, "last_error_at": None, "last_used_at": None}


def _entry(label: str) -> dict[str, Any]:
    return _stats.setdefault(label, _zero())


def record_ok(label: str) -> None:
    with _lock:
        e = _entry(label)
        e["ok"] += 1
        e["last_used_at"] = _now()


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


def reset() -> None:
    """Tests only."""
    with _lock:
        _stats.clear()

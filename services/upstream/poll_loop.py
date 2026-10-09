"""The backoff loop of a per-account poller.

`run()` polls every `interval` seconds until cancelled. A dead session calls `on_expired` and ends the task; any other
failure is logged once per failure run and backs off, doubling up to BACKOFF_MAX_S, or, on a 429, sleeps its
`Retry-After` (never below the interval). A failure with no response (transport: status None or 0) retries after the plain
interval when it is the first of a run, and only starts doubling from the second consecutive failure.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from of_client import session_refused

log = logging.getLogger("upstream.poll_loop")

BACKOFF_MAX_S = 30 * 60

Publish = Callable[[dict], None]


class PollerLike(Protocol):
    """What `run()` reads from a poller."""
    account_id: int
    interval: float

    async def poll(self) -> None: ...


def _retry_after(resp: Any) -> float | None:
    """`Retry-After` in seconds, or None when absent or not a number (an HTTP date counts as absent)."""
    headers = getattr(resp, "headers", None) or {}
    try:
        seconds = float(headers.get("retry-after"))
    except (TypeError, ValueError):
        return None
    return min(max(seconds, 0.0), BACKOFF_MAX_S)


async def run(name: str, poller: PollerLike, on_expired: Callable[[], None],
              sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
    """Poll until cancelled; a dead session calls `on_expired` and ends the task. `name` labels the log lines."""
    account_id, interval = poller.account_id, poller.interval
    backoff = interval
    failing = False
    while True:
        delay = interval
        try:
            await poller.poll()
        except Exception as e:  # never let the task die
            resp = getattr(e, "response", None)
            if session_refused(resp):
                log.warning("%s poller: session refused account=%s", name, account_id)
                on_expired()
                return
            status = getattr(resp, "status_code", None)
            retry = _retry_after(resp) if status == 429 else None
            no_response = not status  # curl_cffi reports transport errors as status 0
            if retry is None:
                # A first failure with no response keeps the interval.
                if not no_response or failing:
                    backoff = min(backoff * 2, BACKOFF_MAX_S)
                delay = backoff
            else:
                delay = max(retry, interval)
            if not failing:
                log.warning("%s poller failed account=%s status=%s: retrying in %.0fs",
                            name, account_id, status, delay, exc_info=no_response)
            failing = True
        else:
            if failing:
                log.info("%s poller recovered account=%s", name, account_id)
            backoff, failing = interval, False
        await sleep(delay)

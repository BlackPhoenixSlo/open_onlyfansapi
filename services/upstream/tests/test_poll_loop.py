"""poll_loop against a stub poller: each poll succeeds or raises the next queued failure."""
import asyncio
import logging
from types import SimpleNamespace

import pytest

import poll_loop
from of_client import OFAPIError

ACCT = 1001
INTERVAL = 120


class Done(Exception):
    pass


class StubPoller:
    account_id = ACCT
    interval = INTERVAL

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)   # None: a clean poll; an exception: raised

    async def poll(self):
        if self.outcomes and (outcome := self.outcomes.pop(0)) is not None:
            raise outcome


def of_error(status, *, retry_after=None, code=0):
    """OF's error answer as `OFClient` raises it."""
    headers = {"content-type": "application/json"}
    if retry_after is not None:
        headers["retry-after"] = retry_after
    resp = SimpleNamespace(status_code=status, headers=headers, json=lambda: {"error": {"code": code}})
    return OFAPIError(f"OF answered {status}", response=resp)


def run_loop(poller, n, on_expired=lambda: None):
    """Run the loop as the `sent` poller until its `n`th sleep; returns the slept seconds."""
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == n:
            raise Done

    try:
        asyncio.run(poll_loop.run("sent", poller, on_expired, sleep=sleep))
    except Done:
        pass
    return sleeps


def test_429_sleeps_retry_after_or_doubles_and_resets_after_a_clean_poll():
    poller = StubPoller(of_error(429, retry_after="7"),   # never below the interval
                        of_error(429, retry_after="300"), of_error(429), None, of_error(429))
    assert run_loop(poller, 5) == [INTERVAL, 300, 2 * INTERVAL, INTERVAL, 2 * INTERVAL]


def test_any_other_failure_is_logged_once_and_backed_off(caplog):
    poller = StubPoller(RuntimeError("boom"), of_error(500), None)
    with caplog.at_level(logging.INFO, logger="upstream.poll_loop"):
        assert run_loop(poller, 3) == [2 * INTERVAL, 4 * INTERVAL, INTERVAL]
    assert [r.getMessage() for r in caplog.records] == [
        f"sent poller failed account={ACCT} status=None: retrying in {2 * INTERVAL}s",
        f"sent poller recovered account={ACCT}"]


@pytest.mark.parametrize(("status", "code"), [(401, 0), (400, 301)])
def test_a_refused_session_calls_on_expired_and_ends(status, code):
    expired = []
    assert run_loop(StubPoller(of_error(status, code=code)), 99, on_expired=lambda: expired.append(1)) == []
    assert expired == [1]

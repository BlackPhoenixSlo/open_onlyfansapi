import asyncio
import json
from types import SimpleNamespace

import pytest
from conftest import of_error_body

import of_ws
from of_client import OFAPIError, session_refused
from of_ws import RECONNECT_MIN_S, OFWebSocket

HELLO = json.dumps({"connected": True})  # OF's handshake reply


class FakeSocket:
    """OF's socket: hands out `frames`, then blocks (`block=True`) or drops the link."""

    def __init__(self, frames=(), *, block=False):
        self.frames = list(frames)
        self.block = block
        self.recv_cancelled = False

    async def send(self, data):
        pass

    async def recv(self):
        if self.frames:
            return self.frames.pop(0)
        if not self.block:
            raise ConnectionError("link dropped")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.recv_cancelled = True
            raise


class FakeConnect:
    """Stands in for `websockets.connect`: one entry per attempt, a socket or an exception."""

    def __init__(self, attempts):
        self.attempts = list(attempts)

    def __call__(self, url, **kw):
        return self

    async def __aenter__(self):
        attempt = self.attempts.pop(0)
        if isinstance(attempt, BaseException):
            raise attempt
        return attempt

    async def __aexit__(self, *exc):
        return False


def fake_client():
    return SimpleNamespace(
        me=lambda: {"wsUrl": "wss://ws2.example.invalid/ws3/1", "wsAuthToken": "jwt"},
        user_agent="ua", accept_language=None, proxy_url="http://203.0.113.10:8080", proxy_label="p")


@pytest.fixture
def no_pinger(monkeypatch):
    async def idle(ws, stop):
        await stop.wait()
    monkeypatch.setattr(of_ws, "_pinger", idle)


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


def test_backoff_resets_after_a_reconnect_that_delivers_a_frame(monkeypatch, no_pinger):
    refused = OSError("connection refused")
    monkeypatch.setattr(of_ws.websockets, "connect", FakeConnect([
        refused, refused, FakeSocket([HELLO]), refused, FakeSocket()]))
    waits = []
    ws = OFWebSocket(fake_client())

    async def no_sleep(aw, timeout):  # the backoff wait: record it, skip it
        aw.close()
        waits.append(timeout)
        if len(waits) == 5:
            ws.stop()
        raise asyncio.TimeoutError

    monkeypatch.setattr(of_ws.asyncio, "wait_for", no_sleep)

    async def main():
        return [f async for f in ws.events()]

    assert asyncio.run(main()) == [{"connected": True}]
    # Two refusals grow it; the reconnect that worked starts it over.
    assert waits == [RECONNECT_MIN_S, 2, RECONNECT_MIN_S, 2, 4]


def test_cancelling_events_cancels_the_pending_recv(monkeypatch, no_pinger):
    sock = FakeSocket([HELLO], block=True)
    monkeypatch.setattr(of_ws.websockets, "connect", FakeConnect([sock]))

    async def main():
        gen = OFWebSocket(fake_client()).events()
        assert await anext(gen) == {"connected": True}
        nxt = asyncio.create_task(anext(gen))
        await settle()  # parked on recv
        nxt.cancel()  # what the pump restart does
        with pytest.raises(asyncio.CancelledError):
            await nxt
        await settle()
        assert sock.recv_cancelled
        assert asyncio.all_tasks() == {asyncio.current_task()}

    asyncio.run(main())


def of_reply(status, body=None, content_type="application/json"):
    def json_():
        if body is None:
            raise ValueError("no JSON body")
        return body
    return SimpleNamespace(status_code=status, headers={"content-type": content_type}, json=json_)


WRONG_USER = {"error": {"code": 301, "message": "Wrong user."}}
OTP_STATE = of_error_body("otp_state")  # the account needs a 2FA code (reconstructed from OF's bundle)


@pytest.mark.parametrize(("resp", "rest", "users_me"), [
    (of_reply(401), True, True),
    (of_reply(400, WRONG_USER), True, True),
    (of_reply(400, OTP_STATE), True, True),
    (of_reply(400, {"error": {"code": 101, "message": "otpState"}}), True, True),  # the message marker alone
    (of_reply(400, {"error": {"code": 101, "message": "Enter the code", "payload": {"otpState": {}}}}), True, True),
    # 101 needs an otpState marker: a bare 101, or one whose payload has none, is an ordinary 400
    (of_reply(400, {"error": {"code": 101}}), False, False),
    (of_reply(400, {"error": {"code": 101, "message": "Wrong user."}}), False, False),
    (of_reply(400, {"error": {"code": 101, "payload": {"strong": True}}}), False, False),
    (of_reply(400, {"error": {"code": 101, "payload": "otpState"}}), False, False),
    # 105 is OF's per-request step-up (the request is retried with a code): the session is alive
    (of_reply(400, {"error": {"code": 105, "message": "otpState", "payload": {"otpState": {}}}}), False, False),
    (of_reply(400, {"error": {"code": 0, "message": "Bad request"}}), False, False),
    *[(of_reply(400, {"error": {"code": code}}), False, False) for code in (100, 102, 105, 300, 302, "101", None)],
    (of_reply(400, {"error": "otpState"}), False, False),
    (of_reply(401, OTP_STATE), True, True),
    (of_reply(403, OTP_STATE, "text/html"), False, False),
    (of_reply(400, content_type="text/html"), False, False),
    (of_reply(403, {"error": {"code": 0}}, "application/json; charset=utf-8"), False, True),
    (of_reply(403, content_type="text/html"), False, False),  # Cloudflare / flagged proxy IP
    (of_reply(500), False, False),
    (None, False, False),
])
def test_session_refused(resp, rest, users_me):
    assert session_refused(resp) is rest
    assert session_refused(resp, users_me=True) is users_me


@pytest.mark.parametrize("resp", [of_reply(401), of_reply(400, WRONG_USER), of_reply(400, OTP_STATE),
                                  of_reply(403, {"error": {}})])
def test_a_dead_session_on_users_me_raises_session_expired(resp, monkeypatch):
    client = fake_client()
    calls = []

    def refused_me():
        calls.append(1)
        raise OFAPIError(str(resp.status_code), response=resp)

    client.me = refused_me

    class Retried(BaseException):  # past the loop's `except Exception`
        pass

    async def no_retry(stop, timeout):  # the reconnect backoff: a dead session must never reach it
        raise Retried(timeout)

    monkeypatch.setattr(of_ws, "_backoff_wait", no_retry)

    async def main():
        async for _ in OFWebSocket(client).events():
            pass

    with pytest.raises(of_ws.SessionExpired):
        asyncio.run(main())
    assert calls == [1]  # one /users/me, then the socket gives up


def test_a_non_json_403_on_users_me_reconnects(monkeypatch, no_pinger):
    monkeypatch.setattr(of_ws.websockets, "connect", FakeConnect([FakeSocket([HELLO], block=True)]))
    replies = [OFAPIError("403", response=of_reply(403, content_type="text/html"))]
    client = fake_client()
    me = client.me

    def flaky_me():
        if replies:
            raise replies.pop(0)
        return me()

    client.me = flaky_me
    waits = []

    async def no_sleep(stop, timeout):  # the backoff wait: record it, skip it
        waits.append(timeout)
        return False

    monkeypatch.setattr(of_ws, "_backoff_wait", no_sleep)

    async def main():
        ws = OFWebSocket(client)
        gen = ws.events()
        first = await anext(gen)
        ws.stop()
        await gen.aclose()
        return first

    assert asyncio.run(main()) == {"connected": True}
    assert waits == [RECONNECT_MIN_S]

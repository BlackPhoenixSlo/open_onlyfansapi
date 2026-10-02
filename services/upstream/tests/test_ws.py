import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app as upstream

GOOD = ["bearer", f"bearer.{TOKEN}"]


@pytest.fixture
def client():
    with TestClient(upstream.app) as c:
        yield c


@pytest.mark.parametrize("offered", [
    [],
    ["bearer"],
    ["bearer", "bearer.wrong-token-0123456789"],
    [f"bearer.{TOKEN}"],  # the server may only select a protocol the client offered
])
def test_ws_refuses_bad_auth_before_accept(client, offered):
    with pytest.raises(WebSocketDisconnect) as e, client.websocket_connect("/ws", subprotocols=offered):
        pass
    assert e.value.code == 1008


def test_ws_ignores_the_http_bearer(client):
    with pytest.raises(WebSocketDisconnect) as e, client.websocket_connect(
            "/ws", headers={"Authorization": f"Bearer {TOKEN}"}):
        pass
    assert e.value.code == 1008


def test_ws_accepts_bearer_and_streams_frames(client):
    frame = {"id": "post.expired:100001:4440001", "type": "post.expired", "account_id": 100001,
             "ts": "2026-10-02T12:00:00.000Z", "payload": {"postId": 4440001}}
    with client.websocket_connect("/ws", subprotocols=GOOD) as ws:
        assert ws.accepted_subprotocol == "bearer"
        client.portal.call(_wait_for_socket)
        client.portal.call(upstream.hub.publish, frame)
        got = ws.receive_json()
    assert got == frame
    assert set(got) == {"id", "type", "account_id", "ts", "payload"}


async def _wait_for_socket():
    import asyncio
    for _ in range(100):
        if upstream.hub.sockets:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("socket never joined the hub")

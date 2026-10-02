"""`routes/chats.py` (plan-v5 Phase 2): chats, chat messages, mass messaging, the queue and Giphy, against `of_fake`.
The returned body is the `data` value the gateway wraps (plan-v5 §2.2)."""
import pytest
from conftest import AUTH
from fastapi.testclient import TestClient

import app as upstream
from of_client import API_BASE as OF

H = {**AUTH, "x-of-proxy-account-id": "1001"}
OK = {"success": True}
SENT = {"text": "hi", "lockedText": False, "mediaFiles": [], "price": 0, "previews": [],
        "scheduledDate": "2026-10-03T18:00:00+00:00", "userIds": [1002]}
DATES = "startDate=2026-10-01+00%3A00%3A00&endDate=2026-10-02+00%3A00%3A00"
FILTER = "filter%5BpublishDate%5D=2026-10-01&filter%5BpublishDateEnd%5D=2026-10-31&filter%5BtimeZone%5D=UTC"


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


def _page(n, has_more):
    return {"list": [{"id": 1010 - i} for i in range(n)], "hasMore": has_more}


@pytest.mark.parametrize(("method", "path", "body", "of_call", "data"), [
    ("post", "/of/chats/mark-as-read", None, ("POST", f"{OF}/chats/mark-as-read", None), OK),
    ("post", "/of/chats/1002/hide", None, ("POST", f"{OF}/chats/1002/hide", None), OK),
    ("post", "/of/chats/1002/mark-as-read", None, ("POST", f"{OF}/chats/1002/mark-as-read", None), OK),
    ("post", "/of/chats/1002/mark-as-unread", None, ("DELETE", f"{OF}/chats/1002/mark-as-read", None), OK),
    ("get", "/of/chats/1002/media", None,
     ("GET", f"{OF}/chats/1002/media?limit=20&offset=0&skip_users=all", None), _page(1, False)),
    ("get", "/of/chats/1002/media?limit=5&offset=10&skip_users=none", None,
     ("GET", f"{OF}/chats/1002/media?limit=5&offset=10", None), _page(1, False)),
    ("post", "/of/chats/1002/mute", None, ("POST", f"{OF}/chats/1002/mute", None), OK),
    ("delete", "/of/chats/1002/unmute", None, ("DELETE", f"{OF}/chats/1002/mute", None), OK),
    ("get", "/of/chats/1002/messages/search?query=hello", None,
     ("GET", f"{OF}/chats/1002/messages/search?query=hello", None), [1004, 1003]),
    ("delete", "/of/chats/1002/messages/1003", None,
     ("DELETE", f"{OF}/messages/1003", {"withUserId": 1002}), OK),
    ("post", "/of/chats/1002/messages/1003/like", None,
     ("POST", f"{OF}/messages/1003/like", None), {"success": True, "isLiked": True}),
    ("delete", "/of/chats/1002/messages/1003/unlike", None,
     ("DELETE", f"{OF}/messages/1003/like", None), {"success": True, "isLiked": False}),
    ("delete", "/of/chats/1002/messages/1003/unpin", None,
     ("DELETE", f"{OF}/messages/1003/pin/user/1002", None), OK),
    ("get", "/of/mass-messaging", None, ("GET", f"{OF}/messages/queue?limit=10&offset=0", None),
     {"list": [{"id": 1005, "isDone": False}], "hasMore": False}),
    ("post", "/of/mass-messaging",
     {"text": "hi", "userIds": [1002], "scheduledDate": "2026-10-03T18:00:00+00:00"},
     ("POST", f"{OF}/messages/queue", SENT), {"id": 1005, "isReady": False}),
    ("get", "/of/mass-messaging/overview?startDate=2026-10-01%2000:00:00&endDate=2026-10-02%2000:00:00&offset=5", None,
     ("GET", f"{OF}/users/me/stats/messages/group?{DATES}&limit=50&offset=5", None),
     {"hasMore": False, "items": [{"id": 1005, "sentCount": 2}]}),
    ("delete", "/of/mass-messaging/1005", None,
     ("DELETE", f"{OF}/messages/queue/1005", None), {"success": True, "queue": {"id": 1005}}),
    ("get", "/of/queue?publishDateStart=2026-10-01&publishDateEnd=2026-10-31&timezone=UTC&limit=5", None,
     ("GET", f"{OF}/schedules?limit=5&{FILTER}", None), {"list": [{"id": 1006}], "syncInProcess": False}),
    ("get", "/of/queue/counts?publishDateStart=2026-10-01&publishDateEnd=2026-10-31&timezone=UTC", None,
     ("GET", f"{OF}/schedules/counters?{FILTER}", None), {"list": {"2026-10-01": 1}, "syncInProcess": False}),
    ("get", "/of/giphy/search?q=cat", None,
     ("GET", f"{OF}/giphy/proxy/gifs/search?q=cat&limit=10&offset=0", None), {"data": [{"id": "gif_1"}]}),
    ("get", "/of/giphy/trending?limit=3&offset=6", None,
     ("GET", f"{OF}/giphy/proxy/gifs/trending?limit=3&offset=6", None), {"data": [{"id": "gif_1"}]}),
])
def test_each_route_reaches_its_of_call(client, of_fake, method, path, body, of_call, data):
    of_fake.respond(data)
    r = client.request(method, path, headers=H, json=body)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == data  # OF's body is the `data` value
    assert of_fake.calls == [of_call]
    assert "x-next-page" not in r.headers


def test_an_empty_of_response_is_null(client, of_fake):
    of_fake.respond(b"", status=204, headers={})
    r = client.post("/of/chats/1002/mute", headers=H)
    assert (r.status_code, r.json()) == (200, None)


def test_pinned_returns_the_rows(client, of_fake):
    of_fake.respond({"list": [{"id": 1003}], "hasMore": True})
    r = client.get("/of/chats/1002/messages/pinned?limit=5", headers=H)
    assert of_fake.calls == [("GET", f"{OF}/chats/1002/messages?limit=5&order=desc&skip_users=all&filter=pinned",
                              None)]
    assert r.json() == [{"id": 1003}] and "x-next-page" not in r.headers  # OF's hasMore lies here


PINNED = ("GET", f"{OF}/chats/1002/messages?limit=50&order=desc&skip_users=all&filter=pinned", None)


@pytest.mark.parametrize("body", [[{"id": 1003}], {"list": None, "hasMore": False}, {"hasMore": False}, "text"])
def test_pin_refuses_when_the_pinned_list_is_unreadable(client, of_fake, body):
    """An unexpected answer could hide that the message is pinned: refuse rather than toggle it off."""
    of_fake.respond(body)
    r = client.post("/of/chats/1002/messages/1003/pin", headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (502, "of_unexpected_response")
    assert of_fake.calls == [PINNED]


def test_pin_pins_an_unpinned_message(client, of_fake):
    of_fake.respond({"list": [{"id": 1004}], "hasMore": False})
    of_fake.respond(OK)
    r = client.post("/of/chats/1002/messages/1003/pin", headers=H)
    assert (r.status_code, r.json()) == (200, OK)
    assert of_fake.calls == [PINNED, ("POST", f"{OF}/messages/1003/pin/user/1002", None)]


def test_pin_leaves_a_pinned_message_pinned(client, of_fake):
    """OF's pin is a toggle: calling it on a pinned message would unpin it."""
    of_fake.respond({"list": [{"id": 1003}], "hasMore": False})
    r = client.post("/of/chats/1002/messages/1003/pin", headers=H)
    assert (r.status_code, r.json()) == (200, OK)
    assert of_fake.calls == [PINNED]


@pytest.mark.parametrize(("path", "header"), [
    ("/of/chats/1002/media?limit=2&offset=4", "/chats/1002/media?skip_users=all&limit=2&offset=6"),
    ("/of/mass-messaging?limit=2", "/mass-messaging?limit=2&offset=2"),
])
def test_offset_lists_set_a_next_page(client, of_fake, path, header):
    of_fake.respond(_page(2, True))
    assert client.get(path, headers=H).headers["x-next-page"] == header
    of_fake.respond(_page(1, True))  # a short page ends pagination
    assert "x-next-page" not in client.get(path, headers=H).headers


def _items(n, has_more):
    return {"hasMore": has_more, "items": [{"id": 1010 - i} for i in range(n)]}


@pytest.mark.parametrize(("body", "header"), [
    (_items(2, True), "/mass-messaging/overview?startDate=2026-10-01&endDate=2026-10-02&limit=2&offset=6"),
    (_items(1, True), None),   # short page
    (_items(2, False), None),  # OF says no more
    ({"hasMore": True, "items": None}, None),
])
def test_overview_pages_its_items(client, of_fake, body, header):
    of_fake.respond(body)
    r = client.get("/of/mass-messaging/overview?startDate=2026-10-01&endDate=2026-10-02&limit=2&offset=4",
                   headers=H)
    assert r.json() == body  # OF's `{hasMore, items}` is the `data` value
    assert r.headers.get("x-next-page") == header


def test_mass_message_maps_the_body_to_of(client, of_fake):
    of_fake.respond({"id": 1005})
    r = client.post("/of/mass-messaging", headers=H, json={
        "text": "hi", "userIds": [1002], "scheduledDate": "2026-10-03T18:00:00+00:00",
        "price": 5, "lockedText": True, "mediaFiles": [1007, 1008], "previews": [1007]})
    assert r.json() == {"id": 1005}
    assert of_fake.calls == [("POST", f"{OF}/messages/queue", {
        **SENT, "price": 5, "lockedText": True, "mediaFiles": [1007, 1008], "previews": [1007]})]


@pytest.mark.parametrize("body", [
    {"userIds": [1002], "scheduledDate": "2026-10-03T18:00:00+00:00"},                       # no text
    {"text": "hi", "scheduledDate": "2026-10-03T18:00:00+00:00"},                            # no recipient
    {"text": "hi", "userIds": [1002, 1003], "scheduledDate": "2026-10-03T18:00:00+00:00"},   # one recipient only
    {"text": "hi", "userIds": [1002]},                                                         # no date
    {"text": "hi", "userIds": [1002], "scheduledDate": "2026-10-03T18:00:00+00:00",
     "userLists": [1009]},                                                                     # not sent, so refused
])
def test_mass_message_rejects_what_it_cannot_send(client, of_fake, body):
    assert client.post("/of/mass-messaging", headers=H, json=body).status_code == 422
    assert of_fake.calls == []


@pytest.mark.parametrize(("method", "path"), [
    ("get", "/of/chats/1002/media?limit=0"), ("get", "/of/chats/1002/media?limit=101"),
    ("get", "/of/chats/1002/media?offset=-1"), ("get", "/of/chats/1002/messages/pinned?limit=51"),
    ("get", "/of/chats/1002/messages/search"), ("get", "/of/chats/1002/messages/search?query="),
    ("get", "/of/mass-messaging?limit=101"), ("get", "/of/mass-messaging/overview?startDate=2026-10-01"),
    ("get", "/of/mass-messaging/overview?startDate=2026-10-01&endDate=2026-10-02&offset=-1"),
    ("get", "/of/queue?publishDateStart=2026-10-01&publishDateEnd=2026-10-31"), ("get", "/of/queue/counts"),
    ("get", "/of/giphy/search"), ("get", "/of/giphy/trending?limit=51"), ("post", "/of/chats/fan_1/hide"),
])
def test_bad_parameters_are_422(client, of_fake, method, path):
    assert client.request(method, path, headers=H).status_code == 422
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=404)
    r = client.post("/of/chats/1002/messages/1003/like", headers=H)
    assert (r.status_code, r.json()) == (404, {"error": {"code": "of_error", "status": 404}})

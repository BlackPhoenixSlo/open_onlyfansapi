"""`routes/content.py` (plan-v6): posts, the media vault, stories and saved-for-later, against `of_fake`.
The returned body is the `data` value the gateway wraps (plan-v5 §2.2)."""
import pytest
from conftest import AUTH
from fastapi.testclient import TestClient

import app as upstream
from of_client import API_BASE as OF

H = {**AUTH, "x-of-proxy-account-id": "1001"}
OK = {"success": True}


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


def _page(n, has_more):
    return {"list": [{"id": 1010 - i} for i in range(n)], "hasMore": has_more}


@pytest.mark.parametrize(("method", "path", "body", "of_call"), [
    ("post", "/of/posts", {"text": "hi"}, ("POST", f"{OF}/posts", {"text": "hi", "mediaFiles": [], "price": 0})),
    ("delete", "/of/posts/1003", None, ("DELETE", f"{OF}/posts/1003", None)),
    ("get", "/of/posts/1003/comments", None,
     ("GET", f"{OF}/posts/1003/comments?limit=20&offset=0&order=publish_date_desc", None)),
    ("get", "/of/posts/1003/comments?limit=5&offset=0&sort=desc", None,
     ("GET", f"{OF}/posts/1003/comments?limit=5&offset=0&order=publish_date_desc", None)),
    ("post", "/of/media/vault/lists", {"name": "folder_1"}, ("POST", f"{OF}/vault/lists", {"name": "folder_1"})),
    ("get", "/of/media/vault/lists/1004", None, ("GET", f"{OF}/vault/lists/1004", None)),
    ("put", "/of/media/vault/lists/1004", {"name": "folder_2"},
     ("PATCH", f"{OF}/vault/lists/1004", {"name": "folder_2"})),
    ("patch", "/of/media/vault/lists/1004", {"name": "folder_2"},
     ("PATCH", f"{OF}/vault/lists/1004", {"name": "folder_2"})),
    ("delete", "/of/media/vault/lists/1004", None, ("DELETE", f"{OF}/vault/lists/1004", {"clearMedia": False})),
    ("post", "/of/media/vault/lists/1004/media", {"mediaIds": [1007, "1008"]},
     ("POST", f"{OF}/vault/lists/1004/media", {"mediaIds": [1007, 1008]})),
    ("get", "/of/stories", None, ("GET", f"{OF}/users/me/stories", None)),
    ("get", "/of/stories/archive?limit=5", None, ("GET", f"{OF}/stories/archive?limit=5&offset=0", None)),
    ("get", "/of/stories/highlights?limit=5&offset=0", None, ("GET", f"{OF}/users/1001/stories/highlights", None)),
    ("get", "/of/stories/1005", None, ("GET", f"{OF}/stories/1005", None)),
    ("delete", "/of/stories/1005", None, ("DELETE", f"{OF}/stories/1005", None)),
    ("get", "/of/saved-for-later/messages?limit=5&offset=0", None,
     ("GET", f"{OF}/schedules/later/chat?limit=5", None)),
    ("get", "/of/saved-for-later/messages/settings", None, ("GET", f"{OF}/users/settings/chat", None)),
    ("get", "/of/saved-for-later/posts/settings", None, ("GET", f"{OF}/users/settings/post", None)),
])
def test_each_route_reaches_its_of_call(client, of_fake, method, path, body, of_call):
    data = {**_page(2, True), "currentCode": "x"}  # a full page: one-page rows still set no next page
    of_fake.respond(data)
    r = client.request(method, path, headers=H, json=body)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == data  # OF's body is the `data` value
    assert of_fake.calls == [of_call]
    assert "x-next-page" not in r.headers


# ─── paged lists and literal-before-parameter routes ───────────────

@pytest.mark.parametrize(("path", "of_url", "items", "has_more", "header"), [
    ("/of/posts/labels", f"{OF}/labels?limit=10&offset=0", 10, True, "/posts/labels?limit=10&offset=10"),
    ("/of/posts/labels?limit=2&offset=4", f"{OF}/labels?limit=2&offset=4", 2, True,
     "/posts/labels?limit=2&offset=6"),
    ("/of/posts/labels?limit=2", f"{OF}/labels?limit=2&offset=0", 1, True, None),  # short page
    ("/of/media/vault/lists", f"{OF}/vault/lists?view=main&limit=10&offset=0", 10, True,
     "/media/vault/lists?limit=10&offset=10"),
    ("/of/media/vault/lists?limit=2&query=x&lightweight=true", f"{OF}/vault/lists?view=main&limit=2&offset=0",
     2, False, None),
    ("/of/saved-for-later/posts?limit=2&offset=2", f"{OF}/schedules/later/post?limit=2&offset=2", 2, True,
     "/saved-for-later/posts?limit=2&offset=4"),
    ("/of/saved-for-later/posts", f"{OF}/schedules/later/post?limit=10&offset=0", 0, True, None),
])
def test_paged_lists(client, of_fake, path, of_url, items, has_more, header):
    of_fake.respond(_page(items, has_more))
    r = client.get(path, headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == _page(items, has_more)
    assert of_fake.calls == [("GET", of_url, None)]
    assert r.headers.get("x-next-page") == header


def test_media_vault_by_id_still_reaches_its_route(client, of_fake):
    of_fake.respond({"id": 1007})
    assert client.get("/of/media/vault/1007", headers=H).json() == {"id": 1007}
    assert of_fake.calls == [("GET", f"{OF}/vault/media/1007", None)]


# ─── POST posts: the §1.2 write rule ───────────────────────────────

def test_create_post_maps_media_and_previews(client, of_fake):
    of_fake.respond({"id": 1003})
    r = client.post("/of/posts", headers=H, json={"text": "hi", "mediaFiles": [1007, 1008], "previews": [1007]})
    assert (r.status_code, r.json()) == (200, {"id": 1003})
    assert of_fake.calls == [("POST", f"{OF}/posts",
                              {"text": "hi", "mediaFiles": [1007, 1008], "price": 0, "preview": [1007]})]


def test_create_post_accepts_the_no_op_defaults(client, of_fake):
    of_fake.respond({"id": 1003})
    r = client.post("/of/posts", headers=H, json={
        "text": "hi", "scheduledDate": None, "expireDays": None, "fundRaisingTargetAmount": None,
        "fundRaisingTipsPresets": [], "labelIds": "", "rfTag": [], "saveForLater": False, "votingType": None,
        "votingOptions": [], "votingDue": None, "votingCorrectIndex": None, "blockBannedWords": None})
    assert r.status_code == 200, r.text
    assert of_fake.calls == [("POST", f"{OF}/posts", {"text": "hi", "mediaFiles": [], "price": 0})]


@pytest.mark.parametrize(("field", "value"), [
    ("scheduledDate", "2026-10-05T18:00:00+00:00"), ("expireDays", 7), ("expireDays", 0),
    ("fundRaisingTargetAmount", 100), ("fundRaisingTipsPresets", ["5"]), ("labelIds", "1009"), ("rfTag", ["1002"]),
    ("saveForLater", True), ("votingType", "poll"), ("votingOptions", ["a", "b"]), ("votingDue", 3),
    ("votingCorrectIndex", 0), ("blockBannedWords", "risky"),
])
def test_create_post_refuses_an_unverified_field(client, of_fake, field, value):
    r = client.post("/of/posts", headers=H, json={"text": "hi", field: value})
    assert r.status_code == 422
    assert r.json()["error"] == {"code": "unsupported_field", "message": f"{field}: not supported on this route"}
    assert of_fake.calls == []


@pytest.mark.parametrize("body", [
    {},                                              # no text
    {"text": "hi", "price": 5},                      # not a reference field
    {"text": "hi", "mediaFiles": ["upload_1"]},      # an upload id: uploads are out
])
def test_create_post_rejects_bad_bodies(client, of_fake, body):
    assert client.post("/of/posts", headers=H, json=body).status_code == 422
    assert of_fake.calls == []


# ─── one-page rows: cursors we cannot honour are 422 ───────────────

@pytest.mark.parametrize(("path", "field"), [
    ("/of/posts/1003/comments?offset=20", "offset"),
    ("/of/posts/1003/comments?sort=asc", "sort"),
    ("/of/stories/archive?marker=1700000000", "marker"),
    ("/of/stories/highlights?offset=10", "offset"),
    ("/of/saved-for-later/messages?offset=10", "offset"),
])
def test_unsupported_cursors_are_422(client, of_fake, path, field):
    r = client.get(path, headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (422, "unsupported_field")
    assert r.json()["error"]["message"].startswith(f"{field}:")
    assert of_fake.calls == []


@pytest.mark.parametrize(("method", "path", "body"), [
    ("get", "/of/posts/labels?limit=11", None),
    ("get", "/of/posts/1003/comments?limit=21", None),
    ("get", "/of/posts/1003/comments?sort=new", None),
    ("get", "/of/media/vault/lists?limit=11", None),
    ("get", "/of/stories/archive?limit=21", None),
    ("get", "/of/saved-for-later/messages?limit=11", None),
    ("get", "/of/saved-for-later/posts?offset=-1", None),
    ("get", "/of/stories/story_1", None),
    ("post", "/of/media/vault/lists", {"name": ""}),
    ("post", "/of/media/vault/lists", {"name": "folder_1", "color": "red"}),
    ("patch", "/of/media/vault/lists/1004", {}),
    ("post", "/of/media/vault/lists/1004/media", {"mediaIds": []}),
    ("post", "/of/media/vault/lists/1004/media", {"mediaIds": ["upload_1"]}),
])
def test_bad_input_is_422(client, of_fake, method, path, body):
    assert client.request(method, path, headers=H, json=body).status_code == 422
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=404)
    r = client.get("/of/stories/1005", headers=H)
    assert (r.status_code, r.json()) == (404, {"error": {"code": "of_error", "status": 404}})

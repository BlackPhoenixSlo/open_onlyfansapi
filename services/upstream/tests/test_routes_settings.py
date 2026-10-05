"""`routes/settings.py` (plan-v6): settings, release forms and notifications, against `of_fake`."""
import pytest
from conftest import AUTH
from fastapi.testclient import TestClient

import app as upstream
from of_client import API_BASE as OF

H = {**AUTH, "x-of-proxy-account-id": "1001"}
SETTINGS = {"blockedCountries": ["XX"], "isDrmEnabled": True, "other": 1}
TAGGABLE = f"{OF}/posts/tagged-friend-users?limit=20&offset=0&skip_users=all&filter=all&sort=date%3Adesc"


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


@pytest.mark.parametrize(("path", "of_url"), [
    ("/of/settings", f"{OF}/users/me/settings"),
    ("/of/settings/social-media-buttons", f"{OF}/users/1001/social/buttons"),
    ("/of/notifications/counts", f"{OF}/users/notifications/count"),
    ("/of/notifications/tabs-order", f"{OF}/users/notifications/settings/tabs-order"),
])
def test_each_route_reaches_its_of_call(client, of_fake, path, of_url):
    data = {"list": [{"id": 1010}], "hasMore": True}
    of_fake.respond(data)
    r = client.get(path, headers=H)
    assert (r.status_code, r.json()) == (200, data)
    assert of_fake.calls == [("GET", of_url, None)]
    assert "x-next-page" not in r.headers


@pytest.mark.parametrize(("path", "data"), [
    ("/of/settings/blocked-countries", {"blockedCountries": ["XX"]}),
    ("/of/settings/drm", {"enabled": True}),
])
def test_settings_reshapes(client, of_fake, path, data):
    of_fake.respond(SETTINGS)
    r = client.get(path, headers=H)
    assert (r.status_code, r.json()) == (200, data)
    assert of_fake.calls == [("GET", f"{OF}/users/me/settings", None)]


def test_settings_omit_streaming_key_fields(client, of_fake):
    """Streaming credentials never reach a read-scope key: every top-level key matching /stream/i is dropped."""
    of_fake.respond({"streamKey": "sk_1001", "streamUrl": "stream_url_1001", "isStreamingEnabled": True,
                     "blockedCountries": ["XX"], "isDrmEnabled": True})
    r = client.get("/of/settings", headers=H)
    assert (r.status_code, r.json()) == (200, {"blockedCountries": ["XX"], "isDrmEnabled": True})


@pytest.mark.parametrize("path", ["/of/settings/blocked-countries", "/of/settings/drm"])
@pytest.mark.parametrize("body", [[SETTINGS], {"other": 1}])
def test_settings_reshapes_refuse_an_unexpected_shape(client, of_fake, path, body):
    """A missing key is a 502 like any other unexpected shape, never `null`."""
    of_fake.respond(body)
    r = client.get(path, headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (502, "of_unexpected_response")


# ─── GET settings/welcome-message ──────────────────────────────────

WELCOME_URL = f"{OF}/messages/templates?template=reply_on_subscribe"
WELCOME = {"id": "7001", "template": "reply_on_subscribe", "text": "<p>welcome_1</p>", "media": [{"id": 9001}]}
SAVED = {"id": "7002", "template": "", "text": "saved_reply_1"}


@pytest.mark.parametrize(("body", "data"), [
    ([SAVED, WELCOME], WELCOME),  # a bare array; a saved reply is skipped
    ({"list": [WELCOME], "hasMore": False}, WELCOME),
    ([], None),  # no welcome message set
    ([SAVED], None),
])
def test_welcome_message_is_the_reply_on_subscribe_template(client, of_fake, body, data):
    of_fake.respond(body)
    r = client.get("/of/settings/welcome-message", headers=H)
    assert (r.status_code, r.json()) == (200, data)
    assert of_fake.calls == [("GET", WELCOME_URL, None)]


@pytest.mark.parametrize("body", [{"other": 1}, "text"])
def test_welcome_message_refuses_an_unexpected_shape(client, of_fake, body):
    of_fake.respond(body)
    r = client.get("/of/settings/welcome-message", headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (502, "of_unexpected_response")


# ─── POST settings/profile ─────────────────────────────────────────

@pytest.mark.parametrize(("body", "sent"), [
    ({"about": "bio_1"}, {"about": "bio_1"}),
    ({"about": ""}, {"about": ""}),  # clears the bio
    ({"about": "bio_1", "name": None, "username": None, "avatar": None}, {"about": "bio_1"}),
])
def test_profile_sets_the_bio(client, of_fake, body, sent):
    of_fake.respond({"success": True})
    r = client.post("/of/settings/profile", headers=H, json=body)
    assert (r.status_code, r.json()) == (200, {"success": True})
    assert of_fake.calls == [("PATCH", f"{OF}/users/me", sent)]


@pytest.mark.parametrize("field", ["username", "avatar", "header", "name", "location", "website", "wishlist"])
@pytest.mark.parametrize("value", ["x", ""])  # "" on an update means clear: a 422 too
def test_profile_refuses_what_it_cannot_set(client, of_fake, field, value):
    r = client.post("/of/settings/profile", headers=H, json={"about": "bio_1", field: value})
    assert (r.status_code, r.json()["error"]["code"]) == (422, "unsupported_field")
    assert of_fake.calls == []


@pytest.mark.parametrize("body", [{}, {"about": None}, {"header": "upload_1"}, {"about": "x", "bio": "x"}])
def test_profile_needs_about_and_known_fields(client, of_fake, body):
    assert client.post("/of/settings/profile", headers=H, json=body).status_code == 422
    assert of_fake.calls == []


# ─── release forms: taggable users ─────────────────────────────────

def _items(n, has_more):
    return {"items": [{"id": 1010 - i} for i in range(n)], "hasMore": has_more}


@pytest.mark.parametrize(("path", "of_url", "body", "header"), [
    ("/of/release-forms/taggable-users", TAGGABLE, _items(20, True),
     "/release-forms/taggable-users?limit=20&offset=20"),
    ("/of/release-forms/taggable-users?limit=2&offset=4&name=user&filter=all&sort=date&sortDirection=desc",
     f"{OF}/posts/tagged-friend-users?limit=2&offset=4&skip_users=all&filter=all&sort=date%3Adesc&name=user",
     _items(2, True), "/release-forms/taggable-users?name=user&limit=2&offset=6"),
    ("/of/release-forms/taggable-users?limit=50", TAGGABLE, _items(20, True),
     "/release-forms/taggable-users?limit=20&offset=20"),  # clamped to the cap: a full page still pages
    ("/of/release-forms/taggable-users?limit=2", TAGGABLE.replace("limit=20", "limit=2"), _items(1, True), None),
    ("/of/release-forms/taggable-users?limit=2", TAGGABLE.replace("limit=20", "limit=2"), _items(2, False), None),
])
def test_taggable_users_page_on_items(client, of_fake, path, of_url, body, header):
    of_fake.respond(body)
    r = client.get(path, headers=H)
    assert r.json() == body
    assert of_fake.calls == [("GET", of_url, None)]
    assert r.headers.get("x-next-page") == header


# ─── refused values and routes left to the passthrough ────────────────────────────────────────────────

@pytest.mark.parametrize("path", [
    "/of/release-forms/taggable-users?filter=pending", "/of/release-forms/taggable-users?sort=name",
    "/of/release-forms/taggable-users?sortDirection=asc",
])
def test_unsupported_values_are_422(client, of_fake, path):
    r = client.get(path, headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (422, "unsupported_field")
    assert of_fake.calls == []


@pytest.mark.parametrize("path", [
    "/of/release-forms/taggable-users?limit=0", "/of/release-forms/taggable-users?offset=-1",
])
def test_bad_parameters_are_422(client, of_fake, path):
    assert client.get(path, headers=H).status_code == 422
    assert of_fake.calls == []


def test_notifications_list_is_not_served(client, of_fake):
    """OF's list call may mark notifications read and was never probed: passthrough only."""
    assert client.get("/of/notifications", headers=H).status_code == 404
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Forbidden"}}, status=403)
    r = client.get("/of/settings", headers=H)
    assert (r.status_code, r.json()) == (403, {"error": {"code": "of_error", "status": 403}})

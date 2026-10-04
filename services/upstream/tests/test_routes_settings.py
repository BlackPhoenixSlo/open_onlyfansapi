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
    ("/of/notifications", f"{OF}/users/notifications?limit=10&offset=0"),
    ("/of/notifications?type=all&limit=5&skip_users=none&from_id=0", f"{OF}/users/notifications?limit=5&offset=0"),
    ("/of/notifications?type=subscriptions", f"{OF}/users/notifications?limit=10&offset=0&type=subscribed"),
    ("/of/notifications?type=tips", f"{OF}/users/notifications?limit=10&offset=0&type=tipped"),
    ("/of/notifications?type=comments", f"{OF}/users/notifications?limit=10&offset=0&type=commented"),
    ("/of/notifications?type=mentions", f"{OF}/users/notifications?limit=10&offset=0&type=mentioned"),
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


@pytest.mark.parametrize("path", ["/of/settings/blocked-countries", "/of/settings/drm"])
def test_settings_reshapes_refuse_an_unexpected_shape(client, of_fake, path):
    of_fake.respond([SETTINGS])
    r = client.get(path, headers=H)
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


@pytest.mark.parametrize(("body", "code"), [
    ({}, "missing_field"),
    ({"about": None}, "missing_field"),
    ({"about": "bio_1", "username": "user_1"}, "unsupported_field"),
    ({"about": "bio_1", "avatar": "upload_1"}, "unsupported_field"),
    ({"header": "upload_1"}, "unsupported_field"),
    ({"about": "bio_1", "name": "name_1"}, "unsupported_field"),
    ({"about": "bio_1", "location": ""}, "unsupported_field"),  # "" on an update means clear: a 422 too
    ({"about": "bio_1", "website": "x"}, "unsupported_field"),
    ({"about": "bio_1", "wishlist": "x"}, "unsupported_field"),
])
def test_profile_refuses_what_it_cannot_set(client, of_fake, body, code):
    r = client.post("/of/settings/profile", headers=H, json=body)
    assert (r.status_code, r.json()["error"]["code"]) == (422, code)
    assert of_fake.calls == []


def test_profile_rejects_unknown_fields(client, of_fake):
    assert client.post("/of/settings/profile", headers=H, json={"about": "x", "bio": "x"}).status_code == 422
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
    ("/of/release-forms/taggable-users?limit=2", TAGGABLE.replace("limit=20", "limit=2"), _items(1, True), None),
    ("/of/release-forms/taggable-users?limit=2", TAGGABLE.replace("limit=20", "limit=2"), _items(2, False), None),
])
def test_taggable_users_page_on_items(client, of_fake, path, of_url, body, header):
    of_fake.respond(body)
    r = client.get(path, headers=H)
    assert r.json() == body
    assert of_fake.calls == [("GET", of_url, None)]
    assert r.headers.get("x-next-page") == header


# ─── refused values ────────────────────────────────────────────────

@pytest.mark.parametrize(("path", "code"), [
    ("/of/release-forms/taggable-users?filter=pending", "unsupported_field"),
    ("/of/release-forms/taggable-users?sort=name", "unsupported_field"),
    ("/of/release-forms/taggable-users?sortDirection=asc", "unsupported_field"),
    ("/of/notifications?from_id=1010", "unsupported_field"),
    ("/of/notifications?type=purchases", "unsupported_type"),
    ("/of/notifications?type=tags", "unsupported_type"),
    ("/of/notifications?type=likes", "unsupported_type"),
    ("/of/notifications?type=promotions", "unsupported_type"),
    ("/of/notifications?type=onlyfans", "unsupported_type"),
])
def test_unsupported_values_are_422(client, of_fake, path, code):
    r = client.get(path, headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (422, code)
    assert of_fake.calls == []


@pytest.mark.parametrize("path", [
    "/of/notifications?limit=11", "/of/notifications?from_id=-1", "/of/release-forms/taggable-users?limit=21",
    "/of/release-forms/taggable-users?offset=-1",
])
def test_bad_parameters_are_422(client, of_fake, path):
    assert client.get(path, headers=H).status_code == 422
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Forbidden"}}, status=403)
    r = client.get("/of/settings", headers=H)
    assert (r.status_code, r.json()) == (403, {"error": {"code": "of_error", "status": 403}})

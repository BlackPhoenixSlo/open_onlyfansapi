"""Fans, users, lists and the account (`routes/fans.py`, plan-v5 Phase 3), against `of_fake`."""
import pytest
from conftest import AUTH
from curl_cffi.requests import exceptions as curl_errors
from fastapi.testclient import TestClient

import app as upstream

H = {**AUTH, "x-of-proxy-account-id": "1001"}
OF = "https://onlyfans.com/api2/v2"
DATES = "start_date=2026-09-01&end_date=2026-09-30"
OF_DATES = "startDate=2026-09-01&endDate=2026-09-30"


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


def _page(n, has_more, key="list", **extra):
    return {key: [{"id": 1010 - i} for i in range(n)], "hasMore": has_more, **extra}


@pytest.mark.parametrize(("method", "path", "body", "of_calls"), [
    ("get", "/of/me/model-start-date", None, [("GET", f"{OF}/users/me/start-date-model", None)]),
    ("get", f"/of/subscribers/statistics?{DATES}", None,
     [("GET", f"{OF}/subscriptions/subscribers/chart?{OF_DATES}", None)]),
    ("get", f"/of/fans/top?{DATES}&by=tips", None,
     [("GET", f"{OF}/subscriptions/subscribers/top?{OF_DATES}&by=tips", None)]),
    ("put", "/of/fans/1002/custom-name", {"custom_name": "fan_1"},
     [("PUT", f"{OF}/subscriptions/1002", {"displayName": "fan_1"})]),
    ("put", "/of/fans/1002/notes", {"notes": "likes cats"},
     [("PUT", f"{OF}/subscriptions/1002", {"notice": "likes cats"})]),
    ("delete", "/of/fans/1002/notes", None, [("PUT", f"{OF}/subscriptions/1002", {"notice": ""})]),
    ("get", "/of/users/list?ids=1002,1003", None, [("GET", f"{OF}/users/list?m%5B%5D=1002&m%5B%5D=1003", None)]),
    ("get", "/of/users/fan_1", None, [("GET", f"{OF}/users/fan_1", None)]),
    ("get", "/of/users/1002", None, [("GET", f"{OF}/users/1002", None)]),
    ("post", "/of/users/1002/block", None, [("POST", f"{OF}/users/1002/block", None)]),
    ("delete", "/of/users/1002/block", None, [("DELETE", f"{OF}/users/1002/block", None)]),
    ("post", "/of/users/1002/restrict", None, [("POST", f"{OF}/users/1002/restrict", None)]),
    ("delete", "/of/users/1002/restrict", None, [("DELETE", f"{OF}/users/1002/restrict", None)]),
    ("post", "/of/users/1002/subscribe", None, [("POST", f"{OF}/users/1002/subscribe", {})]),
    ("delete", "/of/users/1002/subscribe", {"reason": "1"}, [("DELETE", f"{OF}/users/1002/subscribe", {"reason": 1})]),
    ("get", "/of/users/1002/labels", None, [("GET", f"{OF}/users/1002/labels", None)]),
    ("get", "/of/users/1002/stories/highlights", None, [("GET", f"{OF}/users/1002/stories/highlights", None)]),
    ("post", "/of/user-lists", {"name": "list_1"}, [("POST", f"{OF}/lists", {"name": "list_1"})]),
    ("get", "/of/user-lists/1004", None, [("GET", f"{OF}/lists/1004", None)]),
    ("get", "/of/user-lists/fans", None, [("GET", f"{OF}/lists/fans", None)]),
    ("put", "/of/user-lists/1004", {"name": "list_2"}, [("PATCH", f"{OF}/lists/1004", {"name": "list_2"})]),
    ("patch", "/of/user-lists/1004", {"name": "list_2"}, [("PATCH", f"{OF}/lists/1004", {"name": "list_2"})]),
    ("delete", "/of/user-lists/1004", None, [("DELETE", f"{OF}/lists/1004", None)]),
    ("delete", "/of/user-lists/1004/users/1002", None, [("DELETE", f"{OF}/lists/1004/users/1002", None)]),
])
def test_each_route_reaches_its_of_call(client, of_fake, method, path, body, of_calls):
    of_fake.respond({"id": 1001})
    r = client.request(method, path, headers=H, json=body)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == {"id": 1001}  # OF's body is the `data` value
    assert of_fake.calls == of_calls
    assert "x-next-page" not in r.headers


def test_an_empty_of_write_returns_null(client, of_fake):
    of_fake.respond(b"", status=204)
    r = client.post("/of/users/1002/block", headers=H)
    assert (r.status_code, r.json()) == (200, None)


def test_statistics_default_to_ofs_date_window(client, of_fake):
    of_fake.respond({"total": 0})
    assert client.get("/of/subscribers/statistics", headers=H).json() == {"total": 0}
    [(_, url, _)] = of_fake.calls
    assert url.startswith(f"{OF}/subscriptions/subscribers/chart?startDate=") and "&endDate=" in url


# ─── paged lists ───────────────────────────────────────────────────

FANS_Q = "filter%5Bonline%5D=1&filter%5Btotal_spent%5D=50&filter%5Btips%5D=5"


@pytest.mark.parametrize(("path", "of_url", "body", "header"), [
    ("/of/fans/active?limit=2", (f"{OF}/subscriptions/subscribers?type=active&limit=2&offset=0"
     "&sort=-users.last_activity"), _page(2, True), "/fans/active?limit=2&offset=2"),
    (f"/of/fans/all?limit=2&offset=4&{FANS_Q}", (f"{OF}/subscriptions/subscribers?type=all&limit=2&offset=4"
     f"&sort=-users.last_activity&{FANS_Q}"), _page(2, True), f"/fans/all?{FANS_Q}&limit=2&offset=6"),
    ("/of/fans/expired?filter[online]=0", (f"{OF}/subscriptions/subscribers?type=expired&limit=10&offset=0"
     "&sort=-users.last_activity&filter%5Bonline%5D=0"), _page(2, True), None),  # short page
    (f"/of/fans/latest?{DATES}&type=new&limit=2", (f"{OF}/subscriptions/subscribers/latest?{OF_DATES}"
     "&type=new&limit=2&offset=0"), _page(2, True, "users", offset=0),
     f"/fans/latest?{DATES}&type=new&limit=2&offset=2"),
    ("/of/following/active?limit=2", f"{OF}/subscriptions/subscribes?type=active&limit=2&offset=0&format=infinite",
     _page(2, True), "/following/active?limit=2&offset=2"),
    ("/of/following/all", f"{OF}/subscriptions/subscribes?type=all&limit=10&offset=0&format=infinite",
     _page(2, False), None),
    ("/of/following/expired?offset=3&limit=1", (f"{OF}/subscriptions/subscribes?type=expired&limit=1&offset=3"
     "&format=infinite"), _page(1, True), "/following/expired?limit=1&offset=4"),
    ("/of/users/1002/posts?limit=2", (f"{OF}/users/1002/posts?limit=2&skip_users=all"
     "&order=publish_date_desc&format=infinite"), _page(2, True, tailMarker="1700000000.000000"),
     "/users/1002/posts?order=publish_date&sort=desc&limit=2&beforePublishTime=1700000000.000000"),
    ("/of/users/1002/posts?limit=2&order=tips_summ&sort=asc", (f"{OF}/users/1002/posts?limit=2&skip_users=all"
     "&order=tips_summ_asc&format=infinite"), _page(2, True, tailMarker="1700000000.000000"), None),  # not a cursor
    ("/of/users/1002/posts?limit=2&sort=asc", (f"{OF}/users/1002/posts?limit=2&skip_users=all"
     "&order=publish_date_asc&format=infinite"), _page(2, True, tailMarker="1700000000.000000"), None),
    ("/of/users/1002/posts?limit=2&beforePublishTime=1700000000.000000", (f"{OF}/users/1002/posts?limit=2"
     "&skip_users=all&order=publish_date_desc&format=infinite&beforePublishTime=1700000000.000000"),
     _page(2, True, tailMarker="1700000000.000000"), None),  # the cursor did not move
    ("/of/users/1002/posts?beforePublishTime=1700000000.000000", (f"{OF}/users/1002/posts?limit=10&skip_users=all"
     "&order=publish_date_desc&format=infinite&beforePublishTime=1700000000.000000"), _page(2, True), None),
    ("/of/user-lists?limit=2", f"{OF}/lists?limit=2&offset=0&format=infinite", _page(2, True),
     "/user-lists?limit=2&offset=2"),
    ("/of/user-lists/1004/users?limit=2&offset=2", f"{OF}/lists/1004/users?limit=2&offset=2",
     _page(2, True, nextOffset=4), "/user-lists/1004/users?limit=2&offset=4"),
])
def test_paged_lists(client, of_fake, path, of_url, body, header):
    of_fake.respond(body)
    r = client.get(path, headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == body
    assert of_fake.calls == [("GET", of_url, None)]
    assert r.headers.get("x-next-page") == header


# ─── add users to a list: one OF call per user ─────────────────────

def test_add_users_calls_of_once_per_user(client, of_fake):
    of_fake.respond({"id": 1004})
    of_fake.respond({"id": 1004})
    r = client.post("/of/user-lists/1004/users", headers=H, json={"ids": ["1002", 1003]})
    assert (r.status_code, r.json()) == (200, {"1004": [1002, 1003]})
    assert of_fake.calls == [("POST", f"{OF}/lists/1004/users/1002", None), ("POST", f"{OF}/lists/1004/users/1003", None)]


@pytest.mark.parametrize("status", [400, 404, 422])
def test_add_users_skip_invalid_reports_per_id_failures(client, of_fake, status):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=status)
    of_fake.respond({"id": 1004})
    r = client.post("/of/user-lists/1004/users", headers=H, json={"ids": [1002, 1003], "skip_invalid": True})
    assert (r.status_code, r.json()) == (200, {"added": [1003], "failed": {"1002": f"of_error {status}"}})
    assert len(of_fake.calls) == 2


@pytest.mark.parametrize("status", [401, 429, 500])
def test_add_users_skip_invalid_stops_at_other_of_errors(client, of_fake, status):
    of_fake.respond({"id": 1004})
    of_fake.respond({"error": {"code": 0, "message": "No"}}, status=status)
    r = client.post("/of/user-lists/1004/users", headers=H, json={"ids": [1002, 1003, 1005], "skip_invalid": True})
    assert (r.status_code, r.json()) == (status, {"error": {"code": "of_error", "status": status}})
    assert len(of_fake.calls) == 2


def test_add_users_skip_invalid_stops_at_transport_errors(client, of_fake):
    of_fake.fail(curl_errors.Timeout("timed out"))
    r = client.post("/of/user-lists/1004/users", headers=H, json={"ids": [1002, 1003], "skip_invalid": True})
    assert (r.status_code, r.json()) == (504, {"error": {"code": "of_timeout"}})
    assert len(of_fake.calls) == 1


def test_add_users_first_error_names_the_ids_already_added(client, of_fake):
    of_fake.respond({"id": 1004})
    of_fake.respond({"id": 1004})
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=400)
    r = client.post("/of/user-lists/1004/users", headers=H, json={"ids": [1002, 1003, 1005, 1006]})
    assert r.status_code == 400
    assert r.json() == {"error": {"code": "of_error", "message": "stopped at user 1005; already added: 1002,1003"}}
    assert len(of_fake.calls) == 3


def test_add_users_first_id_error_passes_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=404)
    r = client.post("/of/user-lists/1004/users", headers=H, json={"ids": [1002, 1003]})
    assert (r.status_code, r.json()) == (404, {"error": {"code": "of_error", "status": 404}})
    assert len(of_fake.calls) == 1


# ─── validation and OF errors ──────────────────────────────────────

@pytest.mark.parametrize(("method", "path", "body"), [
    ("get", "/of/fans/active?limit=21", None),
    ("get", "/of/fans/active?filter[online]=2", None),
    ("get", "/of/fans/all?filter[tips]=-1", None),
    ("get", "/of/fans/latest?type=all", None),
    ("get", "/of/fans/top?by=fans", None),
    ("get", "/of/following/active?offset=-1", None),
    ("get", "/of/users/list", None),
    ("get", "/of/users/list?ids=1002,fan_1", None),
    ("get", "/of/users/..x", None),
    ("get", "/of/users/blocked", None),  # not a username; the list route is not served
    ("get", "/of/users/restricted", None),
    ("get", "/of/users/1002/posts?limit=51", None),
    ("get", "/of/user-lists?limit=51", None),
    ("get", "/of/users/1002/posts?order=recent", None),
    ("get", "/of/user-lists/a.b", None),
    ("get", "/of/user-lists/1004/users?limit=21", None),
    ("post", "/of/users/fan_1/block", None),
    ("delete", "/of/users/1002/subscribe", {}),
    ("put", "/of/fans/1002/notes", {}),
    ("post", "/of/user-lists", {"name": ""}),
    ("patch", "/of/user-lists/1004", {}),
    ("post", "/of/user-lists/1004/users", {"ids": []}),
    ("post", "/of/user-lists/1004/users", {"ids": ["fan_1"]}),
])
def test_bad_input_is_422(client, of_fake, method, path, body):
    assert client.request(method, path, headers=H, json=body).status_code == 422
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=404)
    r = client.get("/of/users/fan_1", headers=H)
    assert (r.status_code, r.json()) == (404, {"error": {"code": "of_error", "status": 404}})

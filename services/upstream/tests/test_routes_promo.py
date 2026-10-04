"""`routes/promo.py` (plan-v6): tracking links, trial links, promotions and bundles, against `of_fake`.
Fixtures follow the shapes the plan-v6 §3 probes recorded: `campaigns` and `trials` answer a bare array,
`promotions` `{hasMore, items}`."""
import pytest
from conftest import AUTH
from fastapi.testclient import TestClient

import app as upstream
from of_client import API_BASE as OF

H = {**AUTH, "x-of-proxy-account-id": "1001"}


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


def _array(n):
    return [{"id": 1010 - i} for i in range(n)]


@pytest.mark.parametrize(("method", "path", "body", "of_call", "data"), [
    ("post", "/of/tracking-links", {"name": "link_1"}, ("POST", f"{OF}/campaigns", {"name": "link_1"}),
     {"id": 1006}),
    ("post", "/of/tracking-links", {"name": "link_1", "tags": []}, ("POST", f"{OF}/campaigns", {"name": "link_1"}),
     {"id": 1006}),
    ("delete", "/of/tracking-links/1006", None, ("DELETE", f"{OF}/campaigns/1006", None), {"success": True}),
    ("delete", "/of/trial-links/1006", None, ("DELETE", f"{OF}/trials/1006", None), {"success": True}),
    ("delete", "/of/promotions/1006", None, ("DELETE", f"{OF}/promotions/1006", None), {"success": True}),
    ("delete", "/of/promotions/1006", None, ("DELETE", f"{OF}/promotions/1006", None), {"success": False}),
    ("get", "/of/bundles", None, ("GET", f"{OF}/subscriptions/bundles", None), _array(2)),
])
def test_each_route_reaches_its_of_call(client, of_fake, method, path, body, of_call, data):
    of_fake.respond(data)
    r = client.request(method, path, headers=H, json=body)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == data  # OF's body, `{success: false}` included, is the `data` value
    assert of_fake.calls == [of_call]
    assert "x-next-page" not in r.headers


def _items(n, has_more):
    return {"hasMore": has_more, "items": [{"id": 1010 - i} for i in range(n)]}


@pytest.mark.parametrize(("path", "of_url", "body", "header"), [
    # tracking and trial links: a bare array, paged by offset (P12, P13) on the full-page rule alone
    ("/of/tracking-links", f"{OF}/campaigns?limit=10&offset=0", _array(10), "/tracking-links?limit=10&offset=10"),
    ("/of/tracking-links?limit=2&offset=4&pagination=1&synchronous=true", f"{OF}/campaigns?limit=2&offset=4",
     _array(2), "/tracking-links?limit=2&offset=6"),
    ("/of/tracking-links?limit=2", f"{OF}/campaigns?limit=2&offset=0", _array(1), None),
    ("/of/tracking-links?limit=2", f"{OF}/campaigns?limit=2&offset=0", {"error": "x"}, None),
    ("/of/trial-links", f"{OF}/trials?offset=0&limit=10", _array(10), "/trial-links?limit=10&offset=10"),
    ("/of/trial-links?limit=2&offset=4&synchronous=true", f"{OF}/trials?offset=4&limit=2", _array(2),
     "/trial-links?limit=2&offset=6"),
    ("/of/trial-links?limit=500", f"{OF}/trials?offset=0&limit=100", _array(100),
     "/trial-links?limit=100&offset=100"),  # clamped to the verified cap
    ("/of/trial-links?limit=2", f"{OF}/trials?offset=0&limit=2", [], None),
    ("/of/promotions", f"{OF}/promotions?offset=0&limit=10", _items(10, True), "/promotions?limit=10&offset=10"),
    ("/of/promotions?limit=2&offset=4", f"{OF}/promotions?offset=4&limit=2", _items(2, True),
     "/promotions?limit=2&offset=6"),
    ("/of/promotions?limit=500", f"{OF}/promotions?offset=0&limit=100", _items(100, True),
     "/promotions?limit=100&offset=100"),
    ("/of/promotions?limit=2", f"{OF}/promotions?offset=0&limit=2", _items(1, True), None),  # short page
    ("/of/promotions?limit=2", f"{OF}/promotions?offset=0&limit=2", _items(2, False), None),
])
def test_paged_lists(client, of_fake, path, of_url, body, header):
    of_fake.respond(body)
    r = client.get(path, headers=H)
    assert r.json() == body  # OF's body is the `data` value
    assert of_fake.calls == [("GET", of_url, None)]
    assert r.headers.get("x-next-page") == header


@pytest.mark.parametrize(("method", "path", "body", "field"), [
    ("get", "/of/tracking-links?startDate=2026-10-01", None, "startDate"),
    ("get", "/of/tracking-links?endDate=2026-10-31", None, "endDate"),
    ("get", "/of/tracking-links?with_deleted=1", None, "with_deleted"),
    ("get", "/of/tracking-links?sortby=claims", None, "sortby"),
    ("get", "/of/tracking-links?sort=asc", None, "sort"),
    ("get", "/of/trial-links?startDate=2026-10-01", None, "startDate"),
    ("get", "/of/trial-links?endDate=2026-10-31", None, "endDate"),
    ("get", "/of/trial-links?sort=asc", None, "sort"),
    ("get", "/of/trial-links?field=claims_count", None, "field"),
    ("post", "/of/tracking-links", {"name": "link_1", "tags": ["tag_1"]}, "tags"),
    ("post", "/of/tracking-links", {"name": "link_1", "tags": 0}, "tags"),
])
def test_unsupported_fields_are_422(client, of_fake, method, path, body, field):
    r = client.request(method, path, headers=H, json=body)
    assert (r.status_code, r.json()["error"]["code"]) == (422, "unsupported_field")
    assert r.json()["error"]["message"].startswith(f"{field}:")
    assert of_fake.calls == []


@pytest.mark.parametrize(("method", "path", "body"), [
    ("get", "/of/tracking-links?limit=0", None),
    ("get", "/of/trial-links?offset=-1", None),
    ("get", "/of/promotions?limit=0", None),
    ("post", "/of/tracking-links", {}),
    ("post", "/of/tracking-links", {"name": ""}),
    ("post", "/of/tracking-links", {"name": "link_1", "code": 1}),
    ("delete", "/of/promotions/promo_1", None),
])
def test_bad_input_is_422(client, of_fake, method, path, body):
    assert client.request(method, path, headers=H, json=body).status_code == 422
    assert of_fake.calls == []


def test_bundle_delete_is_not_served(client, of_fake):
    """Deleting a bundle changes pricing (plan-v6 §9 Q6): passthrough only."""
    assert client.delete("/of/bundles/1006", headers=H).status_code == 404
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=404)
    r = client.delete("/of/promotions/1006", headers=H)
    assert (r.status_code, r.json()) == (404, {"error": {"code": "of_error", "status": 404}})

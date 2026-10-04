"""`routes/promo.py` (plan-v6): tracking links, trial links, promotions and bundles, against `of_fake`."""
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


@pytest.mark.parametrize(("method", "path", "body", "of_call"), [
    ("get", "/of/tracking-links", None, ("GET", f"{OF}/campaigns?limit=100", None)),
    ("get", "/of/tracking-links?limit=5&offset=0&startDate=2026-10-01&sortby=claims&synchronous=true", None,
     ("GET", f"{OF}/campaigns?limit=5", None)),
    ("post", "/of/tracking-links", {"name": "link_1"}, ("POST", f"{OF}/campaigns", {"name": "link_1"})),
    ("post", "/of/tracking-links", {"name": "link_1", "tags": []}, ("POST", f"{OF}/campaigns", {"name": "link_1"})),
    ("delete", "/of/tracking-links/1006", None, ("DELETE", f"{OF}/campaigns/1006", None)),
    ("get", "/of/trial-links", None, ("GET", f"{OF}/trials?offset=0&limit=100", None)),
    ("get", "/of/trial-links?limit=5&field=claims_count&sort=asc", None,
     ("GET", f"{OF}/trials?offset=0&limit=5", None)),
    ("delete", "/of/trial-links/1006", None, ("DELETE", f"{OF}/trials/1006", None)),
    ("delete", "/of/promotions/1006", None, ("DELETE", f"{OF}/promotions/1006", None)),
    ("get", "/of/bundles", None, ("GET", f"{OF}/subscriptions/bundles", None)),
    ("delete", "/of/bundles/1006", None, ("DELETE", f"{OF}/subscriptions/bundles/1006", None)),
])
def test_each_route_reaches_its_of_call(client, of_fake, method, path, body, of_call):
    data = [{"id": 1006}, {"id": 1005}]  # OF's bare arrays carry no `hasMore`: never a next page
    of_fake.respond(data)
    r = client.request(method, path, headers=H, json=body)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == data
    assert of_fake.calls == [of_call]
    assert "x-next-page" not in r.headers


def _items(n, has_more):
    return {"hasMore": has_more, "items": [{"id": 1010 - i} for i in range(n)]}


@pytest.mark.parametrize(("path", "of_url", "body", "header"), [
    ("/of/promotions", f"{OF}/promotions?offset=0&limit=10", _items(10, True), "/promotions?limit=10&offset=10"),
    ("/of/promotions?limit=2&offset=4", f"{OF}/promotions?offset=4&limit=2", _items(2, True),
     "/promotions?limit=2&offset=6"),
    ("/of/promotions?limit=2", f"{OF}/promotions?offset=0&limit=2", _items(1, True), None),  # short page
    ("/of/promotions?limit=2", f"{OF}/promotions?offset=0&limit=2", _items(2, False), None),
])
def test_promotions_page_on_items(client, of_fake, path, of_url, body, header):
    of_fake.respond(body)
    r = client.get(path, headers=H)
    assert r.json() == body  # OF's `{hasMore, items}` is the `data` value
    assert of_fake.calls == [("GET", of_url, None)]
    assert r.headers.get("x-next-page") == header


@pytest.mark.parametrize(("method", "path", "body", "code"), [
    ("get", "/of/tracking-links?offset=100", None, "unsupported_field"),
    ("get", "/of/trial-links?offset=100", None, "unsupported_field"),
    ("post", "/of/tracking-links", {"name": "link_1", "tags": ["tag_1"]}, "unsupported_field"),
])
def test_unsupported_fields_are_422(client, of_fake, method, path, body, code):
    r = client.request(method, path, headers=H, json=body)
    assert (r.status_code, r.json()["error"]["code"]) == (422, code)
    assert of_fake.calls == []


@pytest.mark.parametrize(("method", "path", "body"), [
    ("get", "/of/tracking-links?limit=101", None),
    ("get", "/of/trial-links?limit=0", None),
    ("get", "/of/promotions?limit=101", None),
    ("post", "/of/tracking-links", {}),
    ("post", "/of/tracking-links", {"name": ""}),
    ("post", "/of/tracking-links", {"name": "link_1", "code": 1}),
    ("delete", "/of/bundles/bundle_1", None),
])
def test_bad_input_is_422(client, of_fake, method, path, body):
    assert client.request(method, path, headers=H, json=body).status_code == 422
    assert of_fake.calls == []


def test_of_errors_pass_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=404)
    r = client.delete("/of/promotions/1006", headers=H)
    assert (r.status_code, r.json()) == (404, {"error": {"code": "of_error", "status": 404}})

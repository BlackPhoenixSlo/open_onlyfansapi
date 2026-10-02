"""Raw passthrough `/of/_of/{path}` (plan-v5 §2.1), against `of_fake`."""
import pytest
from conftest import AUTH
from curl_cffi.requests import exceptions as curl_errors
from fastapi.testclient import TestClient

import app as upstream

H = {**AUTH, "x-of-proxy-account-id": "1001"}
OF = "https://onlyfans.com/api2/v2"


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


@pytest.mark.parametrize(("method", "body", "sent"), [
    ("GET", None, None),
    ("DELETE", None, None),
    ("POST", b'{"text":"hi","price":0}', {"text": "hi", "price": 0}),
    ("PUT", b'[1001,1002]', [1001, 1002]),
    ("PATCH", b'{"fan_1":true}', {"fan_1": True}),
])
def test_method_url_and_body_reach_of(client, of_fake, method, body, sent):
    of_fake.respond({"ok": True})
    headers = {**H, "content-type": "application/json; charset=utf-8"} if body else H
    r = client.request(method, "/of/_of/chats/1001/messages?limit=5&a%20b=c&flag=&id=1002",
                       headers=headers, content=body)
    assert (r.status_code, r.json()) == (200, {"ok": True})
    assert of_fake.calls == [(method, f"{OF}/chats/1001/messages?limit=5&a%20b=c&flag=&id=1002", sent)]


def test_no_query_and_an_empty_body_send_neither(client, of_fake):
    of_fake.respond({})
    r = client.post("/of/_of/users/me", headers={**H, "content-type": "text/plain"}, content=b"")
    assert r.status_code == 200
    assert of_fake.calls == [("POST", f"{OF}/users/me", None)]


@pytest.mark.parametrize("path", [
    "httpbin/get",
    "http%3A%2F%2Fevil.example%2Fx",
    "https:/evil.example/x",
    "users/%2E%2E/me",
    "users/%2e/me",
    "%2E%2E",
    "users//me",
    "users/me%3Fx=1",
    "users/%20me",
    "",
])
def test_invalid_paths_are_400_and_reach_nothing(client, of_fake, path):
    r = client.get(f"/of/_of/{path}", headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_path"), path
    assert of_fake.calls == []


@pytest.mark.parametrize(("ctype", "body", "status", "code"), [
    ("text/plain", b'{"a":1}', 415, "unsupported_media_type"),
    ("application/x-www-form-urlencoded", b"a=1", 415, "unsupported_media_type"),
    (None, b'{"a":1}', 415, "unsupported_media_type"),
    ("application/json", b'{"a":', 400, "invalid_json"),
    ("application/json", b"\xff\xfe\xfa", 400, "invalid_json"),
])
def test_bad_bodies_are_refused(client, of_fake, ctype, body, status, code):
    headers = {**H, "content-type": ctype} if ctype else H
    r = client.post("/of/_of/chats/1001/messages", headers=headers, content=body)
    assert (r.status_code, r.json()["error"]["code"]) == (status, code)
    assert of_fake.calls == []


@pytest.mark.parametrize("status", [404, 500])
def test_of_errors_pass_through_byte_for_byte(client, of_fake, status):
    raw = b'{"error":{"code":0,"message":"Not found"}}  \n'
    of_fake.respond(raw, status=status, headers={"content-type": "application/json; charset=utf-8"})
    r = client.get("/of/_of/posts/1001", headers=H)
    assert r.status_code == status
    assert r.content == raw
    assert r.headers["content-type"] == "application/json; charset=utf-8"


def test_only_content_type_comes_back(client, of_fake):
    of_fake.respond(b'{"id":1001}', headers={
        "content-type": "application/json", "set-cookie": "sess=x; Path=/", "x-of-rev": "test-rev",
        "cache-control": "no-store", "x-custom": "1"})
    r = client.get("/of/_of/users/me", headers=H)
    assert r.status_code == 200 and r.content == b'{"id":1001}'
    # content-length is framing, set by the server for the body it sends.
    assert set(r.headers) == {"content-type", "content-length"}


def test_a_response_without_content_type_gets_none(client, of_fake):
    of_fake.respond(b"", status=204, headers={})
    r = client.delete("/of/_of/chats/1001", headers=H)
    assert (r.status_code, r.content) == (204, b"")
    assert "content-type" not in r.headers


@pytest.mark.parametrize(("error", "status", "code"), [
    (curl_errors.ProxyError("CONNECT 403"), 502, "proxy_error"),
    (curl_errors.ConnectionError("refused"), 502, "of_unreachable"),
    (curl_errors.Timeout("timed out"), 504, "of_timeout"),
])
def test_transport_failures_keep_v4_codes(client, of_fake, error, status, code):
    of_fake.fail(error)
    r = client.get("/of/_of/users/me", headers=H)
    assert (r.status_code, r.json()) == (status, {"error": {"code": code}})


@pytest.mark.parametrize("method", ["OPTIONS", "HEAD"])
def test_options_and_head_are_405(client, of_fake, method):
    assert client.request(method, "/of/_of/users/me", headers=H).status_code == 405
    assert of_fake.calls == []


def test_openapi_has_one_operation_per_method():
    spec = upstream.app.openapi()
    item = spec["paths"]["/of/_of/{path}"]
    assert {m: op["operationId"] for m, op in item.items()} == {
        m: f"of.passthrough.{m}" for m in ("get", "post", "put", "patch", "delete")}
    for op in item.values():
        assert op["tags"] == ["of-api"]
        assert "/api2/v2/{path}" in op["description"] and "assumption" in op["description"]

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import AUTH, TOKEN, make_account
from curl_cffi.requests import exceptions as curl_errors
from fastapi.testclient import TestClient

import accounts
import app as upstream
import client_pool
import proxies
import session_bootstrap
from of_client import OFAPIError

H = {**AUTH, "x-of-proxy-account-id": "100001"}


class FakeOFClient:
    """OF at the object seam: records each call, returns canned data or raises `fail`."""

    def __init__(self):
        self.calls = []
        self.fail = None

    def _call(self, name, *args, **kw):
        self.calls.append((name, args, kw))
        if self.fail is not None:
            raise self.fail
        return {"method": name}

    def __getattr__(self, name):
        if name in {"me", "list_chats", "get_messages", "send_message", "list_posts", "get_post",
                    "vault_media", "vault_media_by_id"}:
            return lambda *a, **kw: self._call(name, *a, **kw)
        raise AttributeError(name)


@pytest.fixture
def fake():
    return FakeOFClient()


@pytest.fixture
def client(fake):
    upstream.app.dependency_overrides[upstream.account_client] = lambda: fake
    with TestClient(upstream.app) as c:
        yield c
    upstream.app.dependency_overrides.clear()


@pytest.fixture
def routed():
    """The real `account_client`, for header-routing tests."""
    with TestClient(upstream.app) as c:
        yield c


# ─── auth ──────────────────────────────────────────────────────────

def test_bearer_is_required_everywhere_but_healthz(routed):
    assert routed.get("/healthz").json() == {"ok": True}
    for path in ("/of-accounts", "/docs/json", "/of/users/me"):
        assert routed.get(path).status_code == 401
        r = routed.get(path, headers={"Authorization": "Bearer wrong-token-0123456789"})
        assert r.status_code == 401
        assert r.json() == {"error": {"code": "unauthorized"}}
    assert routed.get("/of-accounts", headers=AUTH).status_code == 200


def test_refuses_to_boot_with_a_short_token():
    env = {**os.environ, "UPSTREAM_TOKEN": "short"}
    r = subprocess.run([sys.executable, "-c", "import app"], cwd=Path(__file__).parent.parent,
                       env=env, capture_output=True, text=True, check=False)
    assert r.returncode != 0
    assert "UPSTREAM_TOKEN" in r.stderr


# ─── header routing ────────────────────────────────────────────────

def test_account_header_routing(routed, monkeypatch, fake):
    def code(headers):
        r = routed.get("/of/users/me", headers={**AUTH, **headers})
        return r.status_code, r.json().get("error", {}).get("code")

    assert code({}) == (400, "invalid_account_id")
    assert code({"x-of-proxy-account-id": "abc"}) == (400, "invalid_account_id")
    assert code({"x-of-proxy-account-id": "100001"}) == (404, "unknown_account")
    make_account("100001", session=False, proxy=False)
    assert code({"x-of-proxy-account-id": "100001"}) == (409, "no_session")
    make_account("100001", proxy=False)
    assert code({"x-of-proxy-account-id": "100001"}) == (409, "proxy_required")
    make_account("100001")
    got = []
    monkeypatch.setattr(client_pool, "get", lambda aid: got.append(aid) or fake)
    r = routed.get("/of/users/me", headers=H)
    assert r.status_code == 200 and r.json() == {"method": "me"}
    assert got == ["100001"]


def test_proxy_not_required_when_disabled(routed, monkeypatch, fake):
    monkeypatch.setattr(upstream, "REQUIRE_PROXY", False)
    monkeypatch.setattr(client_pool, "get", lambda aid: fake)
    make_account("100001", proxy=False)
    assert routed.get("/of/users/me", headers=H).status_code == 200


# ─── handlers ──────────────────────────────────────────────────────

def test_each_handler_calls_its_client_method(client, fake):
    cases = [
        ("get", "/of/users/me", None, ("me", (), {})),
        ("get", "/of/chats", None, ("list_chats", (), {"limit": 10, "offset": 0, "order": "recent"})),
        ("get", "/of/chats?limit=5&offset=10&order=old", None,
         ("list_chats", (), {"limit": 5, "offset": 10, "order": "old"})),
        ("get", "/of/chats/42/messages", None,
         ("get_messages", (42,), {"limit": 10, "order": "desc", "before_id": None})),
        ("get", "/of/chats/42/messages?limit=3&order=asc&id=99", None,
         ("get_messages", (42,), {"limit": 3, "order": "asc", "before_id": 99})),
        ("post", "/of/chats/42/messages", {"text": "hi"},
         ("send_message", (42, "hi"), {"price": 0, "media_files": [], "previews": [], "locked_text": False})),
        ("post", "/of/chats/42/messages",
         {"text": "ppv", "price": 5, "mediaFiles": [1, 2], "previews": [1], "lockedText": True},
         ("send_message", (42, "ppv"), {"price": 5, "media_files": [1, 2], "previews": [1], "locked_text": True})),
        ("get", "/of/posts", None, ("list_posts", (), {"limit": 10, "offset": 0})),
        ("get", "/of/posts/7", None, ("get_post", (7,), {})),
        ("get", "/of/vault/media", None, ("vault_media", (), {"limit": 24, "offset": 0})),
        ("get", "/of/vault/media/8", None, ("vault_media_by_id", (8,), {})),
    ]
    for method, path, body, call in cases:
        fake.calls.clear()
        r = client.request(method, path, headers=H, json=body)
        assert r.status_code == 200, (path, r.text)
        assert r.json() == {"method": call[0]}
        assert fake.calls == [call], path


def test_send_requires_text(client):
    assert client.post("/of/chats/42/messages", headers=H, json={}).status_code == 422


@pytest.mark.parametrize(("error", "status", "body"), [
    (OFAPIError("404 for /api2/v2/posts/7", response=SimpleNamespace(status_code=404)), 404,
     {"error": {"code": "of_error", "status": 404}}),
    (OFAPIError("401", response=SimpleNamespace(status_code=401)), 401,
     {"error": {"code": "of_error", "status": 401}}),
    (curl_errors.ProxyError("CONNECT 403"), 502, {"error": {"code": "proxy_error"}}),
    (curl_errors.ConnectionError("refused"), 502, {"error": {"code": "of_unreachable"}}),
    (curl_errors.Timeout("timed out"), 504, {"error": {"code": "of_timeout"}}),
])
def test_of_errors_pass_through(client, fake, error, status, body):
    fake.fail = error
    r = client.get("/of/posts/7", headers=H)
    assert (r.status_code, r.json()) == (status, body)


# ─── /of-accounts, /docs/json ──────────────────────────────────────

def test_of_accounts_shape(routed):
    make_account("100001", nickname="Main", username="main_acct", name="Main Account",
                 avatar="https://cdn.example.invalid/a.jpg")
    make_account("100002", proxy=False)
    make_account("100003", session=False)
    rows = sorted(routed.get("/of-accounts", headers=AUTH).json(), key=lambda r: r["id"])
    assert rows == [
        {"id": 100001, "label": "Main", "ofUsername": "main_acct", "ofDisplayName": "Main Account",
         "ofAvatarUrl": "https://cdn.example.invalid/a.jpg", "status": "connecting"},
        {"id": 100002, "label": "Account 100002", "ofUsername": None, "ofDisplayName": None,
         "ofAvatarUrl": None, "status": "no_proxy"},
        {"id": 100003, "label": "Account 100003", "ofUsername": None, "ofDisplayName": None,
         "ofAvatarUrl": None, "status": "no_session"},
    ]


def test_docs_json_lists_the_eight_of_api_operations(routed):
    assert routed.get("/docs").status_code in (401, 404)
    spec = routed.get("/docs/json", headers=AUTH).json()
    ops = {op["operationId"]: (method, path, op)
           for path, item in spec["paths"].items() for method, op in item.items()
           if "of-api" in op.get("tags", [])}
    assert {k: v[:2] for k, v in ops.items()} == {
        "users.me": ("get", "/of/users/me"),
        "chats.list": ("get", "/of/chats"),
        "chats.messages.list": ("get", "/of/chats/{chatId}/messages"),
        "chats.messages.send": ("post", "/of/chats/{chatId}/messages"),
        "posts.list": ("get", "/of/posts"),
        "posts.get": ("get", "/of/posts/{postId}"),
        "vault.media.list": ("get", "/of/vault/media"),
        "vault.media.get": ("get", "/of/vault/media/{mediaId}"),
    }
    for _, path, op in ops.values():
        assert path.startswith("/of/")
        for p in op.get("parameters", []):
            assert p["in"] in ("query", "path"), p  # the account header is not published
            assert "anyOf" not in p["schema"] and p["schema"].get("type") != "null", p
    assert "/session/bootstrap" not in [p for p in spec["paths"] if p.startswith("/of/")]


# ─── /session/bootstrap ────────────────────────────────────────────

CURL = "curl 'https://onlyfans.com/api2/v2/users/me' -H 'user-id: 100001' -H 'x-bc: redacted' -b 'sess=redacted'"


@pytest.fixture
def bootstrap_fakes(monkeypatch, fake):
    seen = {}

    def from_curl(curl, **kw):
        seen.update(kw)
        make_account("100001", proxy=False, nickname=kw.get("nickname") or "Account 100001")
        return accounts.latest_session_path("100001")

    async def idle(_aid):
        import asyncio
        await asyncio.Event().wait()
        yield {}

    fake.me = lambda: {"username": "main_acct", "name": "Main", "avatar": "https://cdn.example.invalid/a.jpg",
                       "wsAuthToken": "secret"}
    monkeypatch.setattr(session_bootstrap, "from_curl", from_curl)
    monkeypatch.setattr(client_pool, "get", lambda aid: fake)
    monkeypatch.setattr(upstream.supervisor, "source", idle)
    return seen


def test_bootstrap_with_proxy(routed, bootstrap_fakes):
    r = routed.post("/session/bootstrap", headers=AUTH, json={
        "curl": CURL, "nickname": "Main", "static_param": "sp", "proxy_url": "socks5://u:p@203.0.113.10:1080"})
    assert r.status_code == 200, r.text
    assert r.json() == {"accountId": 100001, "username": "main_acct", "status": "connecting"}
    assert bootstrap_fakes == {"static_param_override": "sp", "nickname": "Main",
                               "proxy_url": "socks5://u:p@203.0.113.10:1080"}
    p = proxies.get_for_account("100001")
    assert (p["label"], p["scheme"], p["host"], p["port"], p["username"], p["password"]) == (
        "acct-100001", "socks5", "203.0.113.10", 1080, "u", "p")
    meta = accounts.load_meta("100001")
    assert (meta["nickname"], meta["username"], meta["name"]) == ("Main", "main_acct", "Main")
    assert "secret" not in r.text and "sess" not in r.text
    assert "100001" in upstream.supervisor._pumps  # reconciled: the pump is running


def test_bootstrap_refuses_without_a_proxy(routed, bootstrap_fakes):
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL})
    assert (r.status_code, r.json()["error"]["code"]) == (409, "proxy_required")
    assert bootstrap_fakes == {}  # refused before anything reached OF


def test_bootstrap_reuses_the_assigned_proxy(routed, bootstrap_fakes):
    proxies.upsert({"label": "shared", "scheme": "http", "host": "203.0.113.10", "port": 8080})
    proxies.assign_account("shared", "100001")
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL})
    assert r.status_code == 200, r.text
    assert bootstrap_fakes["proxy_url"] == "http://203.0.113.10:8080"
    assert proxies.get_for_account("100001")["label"] == "shared"


def test_bootstrap_rejects_bad_input(routed, bootstrap_fakes):
    def code(body):
        r = routed.post("/session/bootstrap", headers=AUTH, json=body)
        return r.status_code, r.json().get("error", {}).get("code")

    assert code({"curl": "not a curl"}) == (400, "invalid_curl")
    assert code({"curl": "curl https://onlyfans.com/x"}) == (400, "invalid_curl")
    assert code({"curl": CURL, "proxy_url": "ftp://203.0.113.10:21"}) == (400, "invalid_proxy_url")
    assert code({"curl": CURL, "proxy_url": "http://203.0.113.10"}) == (400, "invalid_proxy_url")
    assert routed.post("/session/bootstrap", headers=AUTH, json={}).status_code == 422
    assert bootstrap_fakes == {}


def test_token_is_never_in_the_spec(routed):
    assert TOKEN not in routed.get("/docs/json", headers=AUTH).text

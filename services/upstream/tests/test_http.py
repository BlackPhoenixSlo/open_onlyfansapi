import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import AUTH, TOKEN, OFFake, key_paths, make_account, payload_fixture
from curl_cffi.requests import exceptions as curl_errors
from fastapi.testclient import TestClient

import accounts
import app as upstream
import client_pool
import events
import proxies
import session_bootstrap
from of_client import API_BASE as OF
from of_client import OFAPIError, OFClient

H = {**AUTH, "x-of-proxy-account-id": "100001"}


@pytest.fixture
def fake():
    """An `OFFake` handed out by a patched `client_pool.get` (header-routing and bootstrap tests)."""
    return OFFake()


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


@pytest.fixture
def routed():
    """The real `account_client`, for header-routing tests."""
    with TestClient(upstream.app) as c:
        yield c


# ─── auth ──────────────────────────────────────────────────────────

def test_bearer_is_required_everywhere_but_healthz(routed):
    assert routed.get("/healthz").json() == {"ok": True}
    for path in ("/of-accounts", "/docs/json", "/of/me"):
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
        r = routed.get("/of/me", headers={**AUTH, **headers})
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
    fake.respond({"id": 100001})
    r = routed.get("/of/me", headers=H)
    assert r.status_code == 200 and r.json() == {"id": 100001}
    assert got == ["100001"]


def test_a_client_built_without_a_proxy_is_refused(routed, monkeypatch, fake):
    make_account("100001")
    fake.proxy_url = None
    monkeypatch.setattr(client_pool, "get", lambda aid: fake)
    r = routed.get("/of/me", headers=H)
    assert (r.status_code, r.json()["error"]["code"]) == (409, "proxy_required")
    assert fake.calls == []


def test_proxy_not_required_when_disabled(routed, monkeypatch, fake):
    monkeypatch.setattr(upstream.supervisor, "require_proxy", False)
    fake.proxy_url = None
    monkeypatch.setattr(client_pool, "get", lambda aid: fake)
    make_account("100001", proxy=False)
    fake.respond({"id": 100001})
    assert routed.get("/of/me", headers=H).status_code == 200


# ─── handlers ──────────────────────────────────────────────────────

SENT_DEFAULTS = {"lockedText": False, "mediaFiles": [], "price": 0, "previews": [],
                 "rfTag": [], "rfGuest": [], "rfPartner": [], "isForward": False, "isCouplePeopleMedia": False}


@pytest.mark.parametrize(("method", "path", "body", "of_call"), [
    ("get", "/of/me", None, ("GET", f"{OF}/users/me", None)),
    ("get", "/of/chats", None, ("GET", f"{OF}/chats?limit=10&order=recent&offset=0&skip_users=all", None)),
    ("get", "/of/chats?limit=5&offset=10&order=old&skip_users=none&filter=unread&query=fan_1", None,
     ("GET", f"{OF}/chats?limit=5&order=old&offset=10&filter=unread&query=fan_1", None)),
    ("get", "/of/chats/1002/messages", None,
     ("GET", f"{OF}/chats/1002/messages?limit=10&order=desc&skip_users=all", None)),
    ("get", "/of/chats/1002/messages?limit=3&order=asc&first_id=1003&id=1004", None,
     ("GET", f"{OF}/chats/1002/messages?limit=3&order=asc&skip_users=all&id=1003", None)),
    ("post", "/of/chats/1002/messages", {"text": "hi"}, None),
    ("get", "/of/posts", None,
     ("GET", f"{OF}/posts?limit=10&offset=0&order=publish_date_desc&skip_users=all", None)),
    ("get", "/of/posts/1004", None, ("GET", f"{OF}/posts/1004", None)),
    ("get", "/of/media/vault", None,
     ("GET", f"{OF}/vault/media?limit=24&offset=0&sort=desc&field=recent&list=all", None)),
    ("get", "/of/media/vault?limit=10&offset=20&type=video&list=1005&sort=asc&field=most-liked&query=x", None,
     ("GET", f"{OF}/vault/media?limit=10&offset=20&sort=asc&field=most-liked&list=1005&type=video&query=x", None)),
    ("get", "/of/media/vault/1006", None, ("GET", f"{OF}/vault/media/1006", None)),
])
def test_each_route_reaches_its_of_call(client, of_fake, method, path, body, of_call):
    of_fake.respond({"id": 1001})
    r = client.request(method, path, headers=H, json=body)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == {"id": 1001}  # OF's body is the `data` value
    if of_call is not None:
        assert of_fake.calls == [of_call]


def test_send_maps_the_body_to_of(client, of_fake):
    of_fake.respond({"id": 1003})
    r = client.post("/of/chats/1002/messages", headers=H,
                    json={"text": "ppv", "price": 5, "mediaFiles": [1004, 1005], "previews": [1004], "lockedText": True})
    assert r.status_code == 200
    [(method, url, sent)] = of_fake.calls
    assert (method, url) == ("POST", f"{OF}/chats/1002/messages")
    assert {k: sent[k] for k in ("text", "price", "mediaFiles", "previews", "lockedText")} == {
        "text": "<p>ppv</p>", "price": 5, "mediaFiles": [1004, 1005], "previews": [1004], "lockedText": True}


def test_v4_paths_are_gone(client, of_fake):
    for path in ("/of/users/me", "/of/vault/media", "/of/vault/media/1006"):
        assert client.get(path, headers=H).status_code == 404, path
    assert of_fake.calls == []


def test_send_requires_text(client):
    assert client.post("/of/chats/1002/messages", headers=H, json={}).status_code == 422


# ─── x-next-page ───────────────────────────────────────────────────

def _page(n, has_more):
    return {"list": [{"id": 1010 - i} for i in range(n)], "hasMore": has_more}


@pytest.mark.parametrize(("items", "has_more", "header"), [
    (2, True, "/chats?order=old&skip_users=all&limit=2&offset=12"),  # full page and hasMore
    (2, False, None),                                                 # OF says no more
    (1, True, None),                                                  # short page: OF's hasMore is unreliable
    (0, True, None),                                                  # empty page, even with hasMore
])
def test_chats_next_page(client, of_fake, items, has_more, header):
    of_fake.respond(_page(items, has_more))
    r = client.get("/of/chats?limit=2&order=old&offset=10&unknown=1", headers=H)
    assert r.status_code == 200 and r.json() == _page(items, has_more)
    assert r.headers.get("x-next-page") == header  # built from declared parameters only


def test_chats_next_page_carries_the_default_limit(client, of_fake):
    of_fake.respond(_page(10, True))
    r = client.get("/of/chats?query=fan_1", headers=H)
    assert r.headers["x-next-page"] == "/chats?order=recent&skip_users=all&query=fan_1&limit=10&offset=10"


@pytest.mark.parametrize(("items", "has_more", "header"), [
    (2, True, "/chats/1002/messages?order=desc&limit=2&first_id=1009"),
    (1, True, "/chats/1002/messages?order=desc&limit=2&first_id=1010"),  # OF ignores limit: id cursor
    (0, True, None),
    (2, False, None),
])
def test_messages_desc_next_page_is_older_than_the_oldest(client, of_fake, items, has_more, header):
    of_fake.respond(_page(items, has_more))
    r = client.get("/of/chats/1002/messages?limit=2", headers=H)
    assert r.headers.get("x-next-page") == header


def test_messages_asc_pages_by_offset(client, of_fake):
    of_fake.respond(_page(2, True))
    r = client.get("/of/chats/1002/messages?limit=2&order=asc&offset=4", headers=H)
    assert of_fake.calls == [("GET", f"{OF}/chats/1002/messages?limit=2&order=asc&skip_users=all&offset=4", None)]
    assert r.headers["x-next-page"] == "/chats/1002/messages?order=asc&limit=2&offset=6"
    of_fake.respond(_page(1, True))
    assert "x-next-page" not in client.get("/of/chats/1002/messages?limit=2&order=asc", headers=H).headers


@pytest.mark.parametrize("body", [[{"id": 1001}], {"list": None, "hasMore": True}, {"list": [1001], "hasMore": True},
                                  {"list": [{"id": "x"}], "hasMore": True}, "text"])
def test_unexpected_page_shapes_set_no_next_page(client, of_fake, body):
    of_fake.respond(body)
    r = client.get("/of/chats/1002/messages?limit=1", headers=H)
    assert r.status_code == 200 and "x-next-page" not in r.headers


@pytest.mark.parametrize(("path", "header"), [
    ("/of/posts?limit=2", "/posts?limit=2&offset=2"),
    ("/of/media/vault?limit=2&type=video", "/media/vault?field=recent&sort=desc&type=video&limit=2&offset=2"),
])
def test_offset_lists_set_a_next_page(client, of_fake, path, header):
    of_fake.respond(_page(2, True))
    assert client.get(path, headers=H).headers["x-next-page"] == header


@pytest.mark.parametrize("path", [
    "/of/chats?limit=0", "/of/chats?limit=51", "/of/chats?offset=-1", "/of/chats/1002/messages?limit=101",
    "/of/chats/1002/messages?first_id=-1", "/of/posts?limit=0", "/of/media/vault?limit=101", "/of/media/vault?type=",
])
def test_out_of_range_parameters_are_422(client, of_fake, path):
    assert client.get(path, headers=H).status_code == 422
    assert of_fake.calls == []


@pytest.mark.parametrize(("error", "status", "body"), [
    (404, 404, {"error": {"code": "of_error", "status": 404}}),  # an OF status: of_error
    (401, 401, {"error": {"code": "of_error", "status": 401}}),
    (curl_errors.ProxyError("CONNECT 403"), 502, {"error": {"code": "proxy_error"}}),
    (curl_errors.ConnectionError("refused"), 502, {"error": {"code": "of_unreachable"}}),
    (curl_errors.Timeout("timed out"), 504, {"error": {"code": "of_timeout"}}),
])
def test_of_errors_pass_through(client, of_fake, error, status, body):
    if isinstance(error, int):
        of_fake.respond({"error": {"code": 0, "message": "Not found"}}, status=error)
    else:
        of_fake.fail(error)
    r = client.get("/of/posts/1004", headers=H)
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


def test_docs_json_lists_the_of_api_operations(routed):
    assert routed.get("/docs").status_code in (401, 404)
    spec = routed.get("/docs/json", headers=AUTH).json()
    ops = {op["operationId"]: (method, path, op)
           for path, item in spec["paths"].items() for method, op in item.items()
           if "of-api" in op.get("tags", [])}
    # Phase 1 operations; the wave modules add theirs (asserted in their own test files).
    phase1 = {
        "me.get": ("get", "/of/me"),
        "chats.list": ("get", "/of/chats"),
        "chats.messages.list": ("get", "/of/chats/{chat_id}/messages"),
        "chats.messages.send": ("post", "/of/chats/{chat_id}/messages"),
        "posts.list": ("get", "/of/posts"),
        "posts.get": ("get", "/of/posts/{post_id}"),
        "media.vault.list": ("get", "/of/media/vault"),
        "media.vault.get": ("get", "/of/media/vault/{media_id}"),
        "of.passthrough.get": ("get", "/of/_of/{path}"),
        "of.passthrough.post": ("post", "/of/_of/{path}"),
        "of.passthrough.put": ("put", "/of/_of/{path}"),
        "of.passthrough.patch": ("patch", "/of/_of/{path}"),
        "of.passthrough.delete": ("delete", "/of/_of/{path}"),
    }
    assert {k: v[:2] for k, v in ops.items() if k in phase1} == phase1
    for _, path, op in ops.values():
        assert path.startswith("/of/")
        for p in op.get("parameters", []):
            assert p["in"] in ("query", "path"), p  # the account header is not published
            assert "anyOf" not in p["schema"] and p["schema"].get("type") != "null", p
    assert "/session/bootstrap" not in [p for p in spec["paths"] if p.startswith("/of/")]


# ─── /session/bootstrap ────────────────────────────────────────────

CURL = "curl 'https://onlyfans.com/api2/v2/users/me' -H 'user-id: 100001' -H 'x-bc: redacted' -b 'sess=redacted'"
ME = {"username": "main_acct", "name": "Main", "avatar": "https://cdn.example.invalid/a.jpg",
      "wsAuthToken": "secret"}


@pytest.fixture
def bootstrap_fakes(monkeypatch, fake):
    """`seen`: from_curl's kwargs; `seen["probe"]`: how the validation client was built."""
    seen = {}

    def from_curl(curl, **kw):
        seen.update(kw)
        make_account("100001", proxy=False, nickname=kw.get("nickname") or "Account 100001")
        path = accounts.latest_session_path("100001")
        (path.parent / f"chunk_2313_{path.stem.removeprefix('session_')}.js").write_text("chunk")
        return path

    def from_session_file(path, **kw):
        seen["probe"] = (Path(path).name, kw)
        return fake

    async def idle(_client):
        import asyncio
        await asyncio.Event().wait()
        yield {}

    fake.me = lambda: ME
    monkeypatch.setattr(session_bootstrap, "from_curl", from_curl)
    monkeypatch.setattr(OFClient, "from_session_file", staticmethod(from_session_file))
    monkeypatch.setattr(client_pool, "get", lambda aid: fake)
    monkeypatch.setattr(upstream.supervisor, "source", idle)
    return seen


def test_bootstrap_with_proxy(routed, bootstrap_fakes):
    r = routed.post("/session/bootstrap", headers=AUTH, json={
        "curl": CURL, "nickname": "Main", "static_param": "sp", "proxy_url": "socks5://u:p@203.0.113.10:1080"})
    assert r.status_code == 200, r.text
    assert r.json() == {"accountId": 100001, "username": "main_acct", "status": "connecting"}
    probe = bootstrap_fakes.pop("probe")
    assert bootstrap_fakes == {"static_param_override": "sp", "nickname": "Main",
                               "proxy_url": "socks5://u:p@203.0.113.10:1080"}
    assert probe[0] == accounts.latest_session_path("100001").name  # me() ran on the new session
    assert probe[1]["proxies"] == {"http": "socks5://u:p@203.0.113.10:1080",
                                   "https": "socks5://u:p@203.0.113.10:1080"}
    p = proxies.get_for_account("100001")
    assert (p["label"], p["scheme"], p["host"], p["port"], p["username"], p["password"]) == (
        "acct-100001", "socks5", "203.0.113.10", 1080, "u", "p")
    meta = accounts.load_meta("100001")
    assert (meta["nickname"], meta["username"], meta["name"]) == ("Main", "main_acct", "Main")
    assert "secret" not in r.text and "sess" not in r.text
    assert "100001" in upstream.supervisor._pumps  # reconciled: the pump is running


def test_bootstrap_emits_connected_then_reconnected(routed, bootstrap_fakes, monkeypatch):
    frames, mtimes = [], []
    monkeypatch.setattr(upstream.supervisor, "hub", SimpleNamespace(publish=frames.append))
    for _ in range(2):
        r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL, "proxy_url": "http://203.0.113.10:8080"})
        assert r.status_code == 200, r.text
        mtimes.append(upstream.supervisor.key("100001")[0])
    assert [f["type"] for f in frames] == ["accounts.connected", "accounts.reconnected"]
    for f, mtime in zip(frames, mtimes, strict=True):
        assert f["account_id"] == 100001 and f["amount_cents"] is None
        assert f["id"] == f"{f['type']}:100001:{int(mtime * 1000)}"  # new in v5: public name, ms mtime
        attempt = f["payload"]["latestAuthAttempt"]
        assert f["payload"]["state"] == "authenticated" and attempt["success"] is True
        assert attempt["started_at"] == events.iso(datetime.fromtimestamp(mtime, UTC))
        assert attempt["completed_at"] == f["ts"]
        assert key_paths(f["payload"]) == key_paths(payload_fixture(f["type"])["payload"])


def test_failed_bootstrap_emits_nothing(routed, bootstrap_fakes, fake, monkeypatch):
    frames = []
    monkeypatch.setattr(upstream.supervisor, "hub", SimpleNamespace(publish=frames.append))
    fake.me = lambda: (_ for _ in ()).throw(OFAPIError("401", response=SimpleNamespace(status_code=401)))
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL, "proxy_url": "http://203.0.113.10:8080"})
    assert r.status_code == 401 and frames == []


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
    assert bootstrap_fakes["probe"][1] == {"proxies": {"http": "http://203.0.113.10:8080",
                                                       "https": "http://203.0.113.10:8080"},
                                           "proxy_label": "shared"}
    assert proxies.get_for_account("100001")["label"] == "shared"


def test_bootstrap_clears_stale_proxy_credentials(routed, bootstrap_fakes):
    proxies.upsert({"label": "acct-100001", "scheme": "http", "host": "203.0.113.10", "port": 8080,
                    "username": "old", "password": "old"})
    proxies.assign_account("acct-100001", "100001")
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL, "proxy_url": "http://203.0.113.12:3128"})
    assert r.status_code == 200, r.text
    assert proxies.proxy_url(proxies.get_for_account("100001")) == "http://203.0.113.12:3128"


@pytest.mark.parametrize(("error", "status"), [
    (OFAPIError("401", response=SimpleNamespace(status_code=401)), 401),
    (curl_errors.ProxyError("CONNECT 403"), 502),
    (curl_errors.Timeout("timed out"), 504),
])
def test_failed_validation_rolls_back(routed, bootstrap_fakes, fake, error, status):
    make_account("100001")  # a working session + proxy already in place
    prev = accounts.latest_session_path("100001")
    assigned = proxies.get_for_account("100001")
    fake.me = lambda: (_ for _ in ()).throw(error)
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL, "proxy_url": "http://203.0.113.12:3128"})
    assert r.status_code == status, r.text
    assert accounts.latest_session_path("100001") == prev  # previous session restored
    assert [p.name for p in prev.parent.glob("session_*.json")] == [prev.name]  # failed one deleted
    assert proxies.get_for_account("100001") == assigned  # proxy binding untouched
    assert proxies.get_by_label("acct-100001")["host"] == "203.0.113.10"


def test_failed_bootstrap_does_not_revive_an_expired_session(routed, bootstrap_fakes, fake, monkeypatch):
    import asyncio

    from of_ws import SessionExpired

    events, starts = [], []

    async def expiring(_client):
        starts.append(1)
        raise SessionExpired("/users/me answered 401")
        yield {}

    async def settle():
        for _ in range(10):
            await asyncio.sleep(0)

    monkeypatch.setattr(upstream.supervisor, "source", expiring)
    monkeypatch.setattr(upstream.supervisor, "hub", SimpleNamespace(publish=events.append))
    make_account("100001")
    routed.portal.call(upstream.supervisor.reconcile)
    routed.portal.call(settle)
    assert upstream.supervisor.status("100001") == "session_expired" and len(events) == 1

    fake.me = lambda: (_ for _ in ()).throw(OFAPIError("401", response=SimpleNamespace(status_code=401)))
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL})
    assert r.status_code == 401
    routed.portal.call(upstream.supervisor.reconcile)
    routed.portal.call(settle)
    assert starts == [1] and len(events) == 1  # no restart, no second session_expired
    assert upstream.supervisor.status("100001") == "session_expired"


def test_failed_validation_of_a_new_account_leaves_no_session(routed, bootstrap_fakes, fake):
    fake.me = lambda: (_ for _ in ()).throw(OFAPIError("401", response=SimpleNamespace(status_code=401)))
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL, "proxy_url": "http://203.0.113.12:3128"})
    assert r.status_code == 401
    assert accounts.latest_session_path("100001") is None
    assert not accounts.account_dir("100001").exists()  # no session, chunk or meta.json left
    assert proxies.get_for_account("100001") is None


def test_failed_bootstrap_keeps_prior_files_and_removes_its_own(routed, bootstrap_fakes, fake):
    make_account("100001", nickname="Prior")
    adir = accounts.account_dir("100001")
    (adir / "chunk_2313_20261000T120000Z.js").write_text("prior chunk")
    before = {p.name: p.read_bytes() for p in adir.iterdir()}
    fake.me = lambda: (_ for _ in ()).throw(OFAPIError("401", response=SimpleNamespace(status_code=401)))
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": CURL, "nickname": "New"})
    assert r.status_code == 401
    assert {p.name: p.read_bytes() for p in adir.iterdir()} == before  # new debris gone, prior intact
    assert accounts.load_meta("100001")["nickname"] == "Prior"


def test_bootstrap_rejects_bad_input(routed, bootstrap_fakes):
    def code(body):
        r = routed.post("/session/bootstrap", headers=AUTH, json=body)
        return r.status_code, r.json().get("error", {}).get("code")

    assert code({"curl": "not a curl"}) == (400, "invalid_curl")
    assert code({"curl": "curl https://onlyfans.com/x"}) == (400, "invalid_curl")
    no_cookie = "curl 'https://onlyfans.com/api2/v2/users/me' -H 'user-id: 100001' -H 'cookie: sess=x'"
    r = routed.post("/session/bootstrap", headers=AUTH, json={"curl": no_cookie, "proxy_url": "http://203.0.113.10:1"})
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_curl")
    assert "-b" in r.json()["error"]["message"]
    assert code({"curl": CURL, "proxy_url": "ftp://203.0.113.10:21"}) == (400, "invalid_proxy_url")
    assert code({"curl": CURL, "proxy_url": "http://203.0.113.10"}) == (400, "invalid_proxy_url")
    assert routed.post("/session/bootstrap", headers=AUTH, json={}).status_code == 422
    assert bootstrap_fakes == {}


def test_token_is_never_in_the_spec(routed):
    assert TOKEN not in routed.get("/docs/json", headers=AUTH).text

"""PATCH /of-accounts/{id}, GET /proxies, POST /proxies/{label}/probe and the proxy_stats hook."""
import pytest
from conftest import AUTH, FAKE_SESSION, make_account
from curl_cffi.requests import exceptions as curl_errors
from fastapi.testclient import TestClient

import accounts
import app as upstream
import client_pool
import proxies
import proxy_stats
from of_client import OFClient


@pytest.fixture
def client(monkeypatch):
    async def reconcile():
        reconciled.append(True)

    reconciled = []
    with TestClient(upstream.app) as c:
        monkeypatch.setattr(upstream.supervisor, "reconcile", reconcile)
        c.reconciled = reconciled
        yield c


@pytest.fixture(autouse=True)
def _stats():
    proxy_stats.reset()
    yield
    proxy_stats.reset()


def patch(client, aid, body):
    return client.patch(f"/of-accounts/{aid}", headers=AUTH, json=body)


# ─── PATCH /of-accounts/{id} ───────────────────────────────────────

def test_patch_nickname_keeps_the_rest_of_meta_and_the_proxy(client):
    make_account("100001", nickname="Old", username="main_acct", avatar="https://cdn.example.invalid/a.jpg")
    r = patch(client, "100001", {"nickname": "New"})
    assert r.status_code == 200
    assert r.json() == {"id": 100001, "label": "New", "ofUsername": "main_acct", "ofDisplayName": None,
                        "ofAvatarUrl": "https://cdn.example.invalid/a.jpg", "status": "connecting",
                        "proxyLabel": "acct-100001"}
    assert accounts.load_meta("100001")["username"] == "main_acct"
    assert client.reconciled == []  # no proxy change, no reconcile


def test_patch_proxy_by_label_moves_the_account(client, monkeypatch):
    make_account("100001")
    proxies.upsert({"label": "shared", "host": "203.0.113.20", "port": 3128})
    evicted = []
    monkeypatch.setattr(client_pool, "evict", evicted.append)
    r = patch(client, "100001", {"proxy": {"label": "shared"}})
    assert r.status_code == 200 and r.json()["proxyLabel"] == "shared"
    assert proxies.get_by_label("acct-100001")["assigned_account_ids"] == []
    assert evicted == ["100001"] and client.reconciled == [True]


def test_patch_proxy_by_url_stores_the_accounts_own_proxy(client):
    make_account("100001", proxy=False)
    r = patch(client, "100001", {"nickname": "Main", "proxy": {"url": "socks5://u:p@203.0.113.30:1080"}})
    assert r.status_code == 200
    assert (r.json()["label"], r.json()["proxyLabel"]) == ("Main", "acct-100001")
    p = proxies.get_by_label("acct-100001")
    assert (p["scheme"], p["host"], p["port"], p["username"], p["password"]) == ("socks5", "203.0.113.30", 1080, "u", "p")
    assert p["assigned_account_ids"] == ["100001"]


def test_patch_proxy_null_unbinds(client):
    make_account("100001")
    r = patch(client, "100001", {"proxy": None})
    assert r.status_code == 200
    assert (r.json()["proxyLabel"], r.json()["status"]) == (None, "no_proxy")
    assert proxies.get_by_label("acct-100001")["assigned_account_ids"] == []
    assert client.reconciled == [True]


@pytest.mark.parametrize(("aid", "body", "status", "code"), [
    ("100009", {"nickname": "x"}, 404, "account_not_found"),
    ("abc", {"nickname": "x"}, 404, "account_not_found"),
    ("100001", {"proxy": {"label": "nope"}}, 404, "proxy_not_found"),
    ("100001", {"proxy": {"url": "ftp://203.0.113.1:21"}}, 400, "invalid_proxy_url"),
])
def test_patch_errors(client, aid, body, status, code):
    make_account("100001")
    r = patch(client, aid, body)
    assert (r.status_code, r.json()["error"]["code"]) == (status, code)
    assert client.reconciled == []


@pytest.mark.parametrize("proxy", [{}, {"label": "a", "url": "http://203.0.113.1:1"}])
def test_patch_needs_exactly_one_proxy_field(client, proxy):
    make_account("100001")
    assert patch(client, "100001", {"proxy": proxy}).status_code == 422


# ─── GET /proxies ──────────────────────────────────────────────────

def test_proxies_list_masks_the_password_and_carries_stats(client):
    make_account("100001")
    make_account("100002", proxy=False)
    proxies.upsert({"label": "acct-100001", "host": "203.0.113.10", "port": 8080,
                    "username": "user", "password": "secret-pw"})
    proxies.assign_account("acct-100001", "100002")
    proxy_stats.record_ok("acct-100001")
    proxy_stats.record_failed("acct-100001", "timeout: slow")
    r = client.get("/proxies", headers=AUTH)
    assert r.status_code == 200
    assert "secret-pw" not in r.text and "password" not in r.text
    [p] = r.json()
    stats = p.pop("stats")
    assert p == {"label": "acct-100001", "scheme": "http", "host": "203.0.113.10", "port": 8080,
                 "username": "user", "assigned_account_ids": ["100001", "100002"],
                 "verified_ip": None, "verified_at": None, "verified_geo": None, "since": proxy_stats.SINCE}
    assert (stats["ok"], stats["failed"], stats["last_error"]) == (1, 1, "timeout: slow")
    assert stats["last_error_at"] and stats["last_used_at"]


# ─── POST /proxies/{label}/probe ───────────────────────────────────

def test_probe_records_the_egress(client, monkeypatch):
    make_account("100001")
    monkeypatch.setattr(proxies, "probe", lambda p: {"ok": True, "ip": "198.51.100.7", "geo": "Ljubljana, SI",
                                                      "error": None})
    r = client.post("/proxies/acct-100001/probe", headers=AUTH)
    assert r.status_code == 200
    assert (r.json()["verified_ip"], r.json()["verified_geo"]) == ("198.51.100.7", "Ljubljana, SI")
    assert proxies.get_by_label("acct-100001")["verified_at"]


def test_probe_failure_is_502_without_the_password(client, monkeypatch):
    proxies.upsert({"label": "p", "host": "203.0.113.10", "port": 8080, "username": "u", "password": "secret-pw"})
    monkeypatch.setattr(proxies, "probe", lambda p: {"ok": False, "ip": None, "geo": None,
                                                      "error": "proxy_probe_failed: refused secret-pw"})
    r = client.post("/proxies/p/probe", headers=AUTH)
    assert r.status_code == 502
    assert r.json() == {"error": {"code": "proxy_error", "message": "proxy_probe_failed: refused ***"}}
    assert proxies.get_by_label("p")["verified_ip"] is None


def test_probe_unknown_label_is_404(client):
    assert client.post("/proxies/nope/probe", headers=AUTH).status_code == 404


# ─── proxy_stats hook ──────────────────────────────────────────────

def test_proxied_calls_are_counted_per_label():
    c = OFClient(FAKE_SESSION, proxies={"https": "http://203.0.113.10:8080"}, proxy_label="p")
    assert c._proxy_retry(lambda: "response") == "response"

    def timeout():
        raise curl_errors.Timeout("took too long")

    with pytest.raises(curl_errors.Timeout):
        c._proxy_retry(timeout)

    def refused():
        raise curl_errors.ProxyError("CONNECT 403")

    with pytest.raises(curl_errors.ProxyError):
        c._proxy_retry(refused, pause_s=0)
    s = proxy_stats.get("p")
    assert (s["ok"], s["failed"], s["last_error"]) == (1, 2, "proxy_error: CONNECT 403")


def test_unproxied_calls_are_not_counted():
    c = OFClient(FAKE_SESSION)
    c._proxy_retry(lambda: "response")
    assert proxy_stats._stats == {}

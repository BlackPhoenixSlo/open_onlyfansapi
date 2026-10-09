"""PATCH /of-accounts/{id}, GET /proxies, POST /proxies/{label}/probe and the proxy_stats hook."""
from types import SimpleNamespace

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


def test_patch_url_keeps_the_other_accounts_on_a_shared_own_proxy(client):
    make_account("100001")
    make_account("100002", proxy=False)
    proxies.assign_account("acct-100001", "100002")
    r = patch(client, "100001", {"proxy": {"url": "http://203.0.113.40:8080"}})
    assert r.status_code == 200
    p = proxies.get_by_label("acct-100001")
    assert (p["host"], sorted(p["assigned_account_ids"])) == ("203.0.113.40", ["100001", "100002"])


def test_patch_url_with_a_new_endpoint_drops_the_last_probe_and_stats(client):
    make_account("100001")
    proxies.record_verification("acct-100001", ip="198.51.100.7", geo="X", ok=True)
    proxy_stats.record_ok("acct-100001")
    patch(client, "100001", {"proxy": {"url": "http://203.0.113.10:8080"}})  # same endpoint: kept
    assert proxies.get_by_label("acct-100001")["verified_ip"] == "198.51.100.7"
    assert proxy_stats.get("acct-100001")["ok"] == 1
    patch(client, "100001", {"proxy": {"url": "http://u:p@203.0.113.10:8080"}})  # credentials changed
    p = proxies.get_by_label("acct-100001")
    assert (p["verified_ip"], p["verified_at"], p["verified_geo"]) == (None, None, None)
    assert (p["verified_of_reachable"], p["verified_of_error"]) == (None, None)
    assert proxy_stats.get("acct-100001")["ok"] == 0


@pytest.mark.parametrize("proxy", [{"label": "nope"}, {"url": "ftp://203.0.113.1:21"}])
def test_a_bad_proxy_leaves_the_nickname_unchanged(client, proxy):
    make_account("100001", nickname="Old")
    assert patch(client, "100001", {"nickname": "New", "proxy": proxy}).status_code in (400, 404)
    assert accounts.load_meta("100001")["nickname"] == "Old"
    assert proxies.get_by_label("acct-100001")["assigned_account_ids"] == ["100001"]


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
    assert "secret-pw" not in r.text and "password" not in r.text and "username" not in r.text
    [p] = r.json()
    stats = p.pop("stats")
    assert p == {"label": "acct-100001", "scheme": "http", "host": "203.0.113.10", "port": 8080,
                 "assigned_account_ids": ["100001", "100002"],
                 "verified_ip": None, "verified_at": None, "verified_geo": None,
                 "verified_of_reachable": None, "verified_of_error": None, "since": proxy_stats.SINCE}
    assert (stats["ok"], stats["failed"], stats["blocked"], stats["last_error"]) == (1, 1, 0, "timeout: slow")
    assert stats["last_error_at"] and stats["last_used_at"] and stats["last_ok_at"]


# ─── POST /proxies ─────────────────────────────────────────────────

def test_create_proxy_is_unbound_and_hides_the_password(client):
    r = client.post("/proxies", headers=AUTH, json={"label": "pool-1", "url": "socks5h://u:secret-pw@203.0.113.50:1080"})
    assert r.status_code == 200
    assert "secret-pw" not in r.text
    body = r.json()
    assert (body["label"], body["scheme"], body["host"], body["port"], body["assigned_account_ids"]) == (
        "pool-1", "socks5h", "203.0.113.50", 1080, [])
    stored = proxies.get_by_label("pool-1")
    assert (stored["username"], stored["password"]) == ("u", "secret-pw")


@pytest.mark.parametrize(("body", "status", "code"), [
    ({"label": "taken", "url": "http://203.0.113.1:8080"}, 409, "proxy_exists"),
    ({"label": "acct-100001", "url": "http://203.0.113.1:8080"}, 400, "invalid_label"),
    ({"label": "new", "url": "ftp://203.0.113.1:21"}, 400, "invalid_proxy_url"),
])
def test_create_proxy_errors(client, body, status, code):
    proxies.upsert({"label": "taken", "host": "203.0.113.9", "port": 8080, "password": "keep"})
    r = client.post("/proxies", headers=AUTH, json=body)
    assert (r.status_code, r.json()["error"]["code"]) == (status, code)
    assert proxies.get_by_label("taken")["password"] == "keep"
    assert [p["label"] for p in proxies.list_proxies()] == ["taken"]


@pytest.mark.parametrize("label", ["", ".hidden", "a/b"])
def test_create_proxy_label_is_one_path_segment(client, label):
    assert client.post("/proxies", headers=AUTH, json={"label": label, "url": "http://203.0.113.1:1"}).status_code == 422


# ─── POST /proxies/{label}/probe ───────────────────────────────────

def test_probe_records_the_egress(client, monkeypatch):
    make_account("100001")
    monkeypatch.setattr(proxies, "probe", lambda p: {"ok": True, "ip": "198.51.100.7", "geo": "Ljubljana, SI",
                                                      "error": None, "of_reachable": False,
                                                      "of_error": "CONNECT tunnel failed, response 403"})
    r = client.post("/proxies/acct-100001/probe", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert (body["verified_ip"], body["verified_geo"]) == ("198.51.100.7", "Ljubljana, SI")
    assert (body["verified_of_reachable"], body["verified_of_error"]) == (False, "CONNECT tunnel failed, response 403")
    stored = proxies.get_by_label("acct-100001")
    assert stored["verified_at"] and stored["verified_of_reachable"] is False


def _fake_cffi(monkeypatch, of_error=None):
    """curl_cffi.requests.get answering ipify and ipinfo; onlyfans.com answers, or raises `of_error`."""
    from curl_cffi import requests as cffi

    calls = []

    def get(url, **kw):
        calls.append((url, kw.get("proxies"), kw.get("allow_redirects", True)))
        if url == proxies.OF_PROBE_URL and of_error is not None:
            raise of_error
        return SimpleNamespace(status_code=302, text="198.51.100.7\n", raise_for_status=lambda: None,
                               json=lambda: {"city": "Ljubljana", "country": "SI"})

    monkeypatch.setattr(cffi, "get", get)
    return calls


SOCKS = {"label": "s", "scheme": "socks5h", "host": "203.0.113.10", "port": 1080, "username": "u", "password": "pw-secret"}


def test_probe_goes_through_curl_cffi_with_the_proxy(monkeypatch):
    calls = _fake_cffi(monkeypatch)
    assert proxies.probe(SOCKS) == {"ok": True, "ip": "198.51.100.7", "geo": "Ljubljana, SI", "error": None,
                                    "of_reachable": True, "of_error": None}
    url = "socks5h://u:pw-secret@203.0.113.10:1080"
    assert calls == [("https://api.ipify.org", {"http": url, "https": url}, True),
                     ("https://ipinfo.io/198.51.100.7/json", None, True),
                     ("https://onlyfans.com/", {"http": url, "https": url}, False)]


def test_probe_reports_a_proxy_that_refuses_onlyfans(monkeypatch):
    error = curl_errors.ProxyError(
        "Failed to perform, curl: (56) CONNECT tunnel failed, response 403 via socks5h://u:pw-secret@203.0.113.10")
    _fake_cffi(monkeypatch, of_error=error)
    result = proxies.probe(SOCKS)
    assert (result["ok"], result["ip"], result["of_reachable"]) == (True, "198.51.100.7", False)
    assert "CONNECT tunnel failed, response 403" in result["of_error"]
    assert "pw-secret" not in result["of_error"] and "***" in result["of_error"]


def test_probe_skips_onlyfans_when_no_ip_came_back(monkeypatch):
    from curl_cffi import requests as cffi

    def get(url, **kw):
        raise curl_errors.ProxyError("refused pw-secret")

    monkeypatch.setattr(cffi, "get", get)
    result = proxies.probe(SOCKS)
    assert (result["ok"], result["of_reachable"], result["of_error"]) == (False, None, None)
    assert result["error"] == "proxy_probe_failed: refused ***"


def test_probe_failure_is_502_without_the_password(client, monkeypatch):
    proxies.upsert({"label": "p", "host": "203.0.113.10", "port": 8080, "username": "u", "password": "secret-pw"})
    monkeypatch.setattr(proxies, "probe", lambda p: {"ok": False, "ip": None, "geo": None,
                                                      "error": "proxy_probe_failed: refused secret-pw",
                                                      "of_reachable": None, "of_error": None})
    r = client.post("/proxies/p/probe", headers=AUTH)
    assert r.status_code == 502
    assert r.json() == {"error": {"code": "proxy_error", "message": "proxy_probe_failed: refused ***"}}
    assert proxies.get_by_label("p")["verified_ip"] is None


def test_probe_unknown_label_is_404(client):
    assert client.post("/proxies/nope/probe", headers=AUTH).status_code == 404


# ─── proxy_stats hook ──────────────────────────────────────────────

def test_proxied_calls_are_counted_per_label():
    c = OFClient(FAKE_SESSION, proxies={"https": "http://203.0.113.10:8080"}, proxy_label="p")
    assert c._proxy_retry(lambda: SimpleNamespace(status_code=200)).status_code == 200
    assert proxy_stats.get("p")["last_ok_at"]
    c._proxy_retry(lambda: SimpleNamespace(status_code=429))
    s = proxy_stats.get("p")
    assert (s["ok"], s["blocked"], s["last_status"], s["failed"]) == (2, 1, 429, 0)

    def fail(error):
        def call():
            raise error
        return call

    with pytest.raises(curl_errors.Timeout):
        c._proxy_retry(fail(curl_errors.Timeout("took too long")))
    with pytest.raises(curl_errors.ConnectionError):
        c._proxy_retry(fail(curl_errors.ConnectionError("curl: (7) Failed to connect")))
    with pytest.raises(curl_errors.ProxyError):  # 5 tries, counted once when they run out
        c._proxy_retry(fail(curl_errors.ProxyError("CONNECT 403")), pause_s=0)
    s = proxy_stats.get("p")
    assert (s["ok"], s["failed"], s["last_error"]) == (2, 3, "proxy_error: CONNECT 403")


def _flaky(*answers):
    """A raw call that raises or returns each of `answers` in turn."""
    answers = list(answers)

    def call():
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    return call


def test_a_proxy_error_is_retried_5_times_with_growing_pauses(monkeypatch, caplog):
    sleeps = []
    monkeypatch.setattr("of_client.time.sleep", sleeps.append)
    c = OFClient(FAKE_SESSION, proxies={"https": "http://203.0.113.10:8080"}, proxy_label="p")
    with caplog.at_level("INFO", logger="of-client"), pytest.raises(curl_errors.ProxyError):
        c._proxy_retry(_flaky(*[curl_errors.ProxyError("CONNECT 403")] * 5), what="GET /x")
    assert sleeps == [0.4, 0.8, 1.6, 3.2]
    retries = [r for r in caplog.records if r.getMessage().startswith("proxy_error_retry")]
    assert [f"attempt={n}/5 GET /x" in r.getMessage() and r.levelname == "INFO"
            for n, r in enumerate(retries, 1)] == [True] * 4
    s = proxy_stats.get("p")
    assert (s["ok"], s["failed"], s["last_error"]) == (0, 1, "proxy_error: CONNECT 403")


def test_a_retry_that_recovers_is_not_counted_as_failed(monkeypatch):
    sleeps = []
    monkeypatch.setattr("of_client.time.sleep", sleeps.append)
    c = OFClient(FAKE_SESSION, proxies={"https": "http://203.0.113.10:8080"}, proxy_label="p")
    blip = curl_errors.ProxyError("blip")
    assert c._proxy_retry(_flaky(blip, blip, blip, SimpleNamespace(status_code=200))).status_code == 200
    assert sleeps == [0.4, 0.8, 1.6]
    s = proxy_stats.get("p")
    assert (s["ok"], s["failed"], s["last_error"]) == (1, 0, None)


def test_unproxied_calls_are_not_counted():
    c = OFClient(FAKE_SESSION)
    c._proxy_retry(lambda: "response")
    assert proxy_stats._stats == {}

"""The pasted-proxy line parser + redactor (proxies.parse_line / redact_line) and POST /proxies/bulk."""
import pytest
from conftest import AUTH
from fastapi.testclient import TestClient

import app as upstream
import proxies


@pytest.fixture
def client():
    with TestClient(upstream.app) as c:
        yield c


# ─── proxies.parse_line ────────────────────────────────────────────

@pytest.mark.parametrize(("line", "scheme", "host", "port", "user", "pw", "label"), [
    ("socks5h://u:p@203.0.113.10:1080", "socks5h", "203.0.113.10", 1080, "u", "p", "203.0.113.10:1080"),
    ("u:p@203.0.113.10:8080", "http", "203.0.113.10", 8080, "u", "p", "203.0.113.10:8080"),
    ("203.0.113.10:8080:u:p", "http", "203.0.113.10", 8080, "u", "p", "203.0.113.10:8080"),
    ("203.0.113.10:8080@u:p", "http", "203.0.113.10", 8080, "u", "p", "203.0.113.10:8080"),
    ("203.0.113.10:8080", "http", "203.0.113.10", 8080, "", "", "203.0.113.10:8080"),
    ("203.0.113.10:8080  my-label", "http", "203.0.113.10", 8080, "", "", "my-label"),
    ("http://203.0.113.10:8080 lbl", "http", "203.0.113.10", 8080, "", "", "lbl"),
])
def test_parse_line_formats(line, scheme, host, port, user, pw, label):
    entry, got_label = proxies.parse_line(line)
    assert entry == {"scheme": scheme, "host": host, "port": port, "username": user, "password": pw}
    assert got_label == label


def test_parse_line_default_scheme_is_overridable():
    entry, _ = proxies.parse_line("203.0.113.10:1080", scheme_default="socks5")
    assert entry["scheme"] == "socks5"


@pytest.mark.parametrize("line", ["", "   ", "nonsense", "ftp://203.0.113.1:21", "host:notaport",
                                  "203.0.113.10:99999", "203.0.113.10:8080:onlyuser"])
def test_parse_line_rejects_bad_lines(line):
    with pytest.raises(proxies.ProxyLineError):
        proxies.parse_line(line)


# ─── proxies.redact_line ───────────────────────────────────────────

@pytest.mark.parametrize(("line", "expect"), [
    ("socks5h://u:secret@203.0.113.10:1080", "socks5h://u:***@203.0.113.10:1080"),
    ("u:secret@203.0.113.10:8080", "u:***@203.0.113.10:8080"),
    ("203.0.113.10:8080:u:secret", "203.0.113.10:8080:***:***"),
    ("203.0.113.10:8080@u:secret", "203.0.113.10:8080@u:***"),
    ("203.0.113.10:8080", "203.0.113.10:8080"),
    ("u:secret@203.0.113.10:8080 label", "u:***@203.0.113.10:8080 label"),
])
def test_redact_line_masks_the_password(line, expect):
    out = proxies.redact_line(line)
    assert out == expect
    assert "secret" not in out


# ─── POST /proxies/bulk ────────────────────────────────────────────

def test_bulk_registers_good_lines_and_reports_bad_ones_with_1_based_numbers(client):
    # line 1 comment, 2 blank, 3 ok+labelled, 4 ok, 5 bad scheme, 6 reserved label, 7 duplicate label
    text = (
        "# a comment\n"
        "\n"
        "203.0.113.10:8080:user:top-secret pool-a\n"
        "socks5h://u:p@203.0.113.11:1080\n"
        "ftp://203.0.113.1:21\n"
        "203.0.113.12:9090 acct-42\n"
        "203.0.113.10:8080 pool-a"
    )
    r = client.post("/proxies/bulk", headers=AUTH, json={"text": text})
    assert r.status_code == 200, r.text
    assert "top-secret" not in r.text and "password" not in r.text
    body = r.json()
    assert [a["label"] for a in body["added"]] == ["pool-a", "203.0.113.11:1080"]
    assert body["added"][0] == {"label": "pool-a", "host": "203.0.113.10", "port": 8080,
                                "scheme": "http", "username": "user"}
    assert [(e["line"], e["reason"].split(";")[0].split(" ")[0]) for e in body["errors"]] == [
        (5, "unsupported"), (6, "acct-<id>"), (7, "duplicate")]
    # The stored proxies carry the credentials; the response never does.
    stored = proxies.get_by_label("pool-a")
    assert (stored["username"], stored["password"]) == ("user", "top-secret")


def test_bulk_line_6_label_is_acct_reserved(client):
    # "acct-42" with no trailing label -> its label defaults to host:port? No: "acct-42" alone is not
    # host:port, so it fails to parse. The reserved-label guard is for a *trailing* acct-<id> label.
    r = client.post("/proxies/bulk", headers=AUTH, json={"text": "203.0.113.10:8080 acct-42"})
    assert r.status_code == 200
    assert r.json()["errors"][0]["reason"].startswith("acct-<id>")
    assert r.json()["added"] == []


def test_bulk_bad_default_scheme_is_400(client):
    r = client.post("/proxies/bulk", headers=AUTH, json={"text": "203.0.113.10:8080", "scheme": "ftp"})
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_proxy_url")

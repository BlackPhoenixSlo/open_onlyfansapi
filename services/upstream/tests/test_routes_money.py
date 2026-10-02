"""Money routes (plan-v5 Phase 4, `routes/money.py`) against `of_fake`: the OF call, the `data` value and
`x-next-page`."""
import pytest
from conftest import AUTH
from fastapi.testclient import TestClient

import app as upstream
from of_client import API_BASE as OF

H = {**AUTH, "x-of-proxy-account-id": "1001"}
D1, D2 = "2026-01-01", "2026-01-31"


@pytest.fixture
def client(of_fake):
    with TestClient(upstream.app) as c:
        yield c


def _page(n, has_more, key="list"):
    return {key: [{"id": 1010 - i, "amount": 500} for i in range(n)], "hasMore": has_more}


@pytest.mark.parametrize(("path", "of_url"), [
    ("/payouts/balances", "/payouts/balances"),
    (f"/payouts/earning-statistics?startDate={D1}&endDate={D2}", f"/payouts/stats?by=day&start={D1}&end={D2}"),
    ("/payouts/eligibility", "/payouts/check-receive"),
    ("/payouts/payout-requests", "/payouts/requests?limit=10&offset=0"),
    ("/payouts/payout-requests?limit=2&offset=4", "/payouts/requests?limit=2&offset=4"),
    ("/payouts/transactions", "/payouts/transactions?limit=20&offset=0"),
    (f"/payouts/transactions?limit=2&offset=4&startDate={D1}&type=tip",
     f"/payouts/transactions?limit=2&offset=4&type=tip&start={D1}"),
    ("/transactions", "/payouts/transactions?limit=20&offset=0"),
    (f"/transactions?startDate={D1}&type=tip", f"/payouts/transactions?limit=20&offset=0&type=tip&start={D1}"),
    (f"/chargebacks/ratio?start_date={D1}&end_date={D2}", f"/payouts/chargebacks/ratio?startDate={D1}&endDate={D2}"),
    (f"/statistics/overview?start_date={D1}&end_date={D2}",
     f"/users/me/stats/overview?startDate={D1}&endDate={D2}&by=visitors"),
    (f"/engagement/messages/mass-messages?startDate={D1}&endDate={D2}",
     f"/users/me/stats/messages/group?startDate={D1}&endDate={D2}&limit=50&offset=0"),
    (f"/engagement/messages/mass-messages?startDate={D1}&endDate={D2}&limit=2&offset=4",
     f"/users/me/stats/messages/group?startDate={D1}&endDate={D2}&limit=2&offset=4"),
    (f"/statistics/reach/profile-visitors?start_date={D1}&end_date={D2}&type=x&filter=y",
     f"/users/me/profile/stats?startDate={D1}&endDate={D2}&limit=10"),
    (f"/statistics/reach/profile-visitors?start_date={D1}&end_date={D2}&limit=5",
     f"/users/me/profile/stats?startDate={D1}&endDate={D2}&limit=5"),
    (f"/statistics/statements/earnings?start_date={D1}&end_date={D2}&type=x",
     f"/earnings/chart?startDate={D1}&endDate={D2}&withTotal=true"),
])
def test_each_route_reaches_its_of_call(client, of_fake, path, of_url):
    of_fake.respond({"id": 1001, "amount": 500})
    r = client.get(f"/of{path}", headers=H)
    assert r.status_code == 200, (path, r.text)
    assert r.json() == {"id": 1001, "amount": 500}  # OF's body is the `data` value
    assert of_fake.calls == [("GET", f"{OF}{of_url}", None)]
    assert "x-next-page" not in r.headers


@pytest.mark.parametrize("path", ["/chargebacks/ratio", "/statistics/overview"])
def test_empty_dates_take_the_client_default_range(client, of_fake, path):
    of_fake.respond({"id": 1001})
    assert client.get(f"/of{path}", headers=H).status_code == 200
    [(_, url, _)] = of_fake.calls
    assert "startDate=" in url and "endDate=" in url  # the last 30 days, filled in by OFClient


@pytest.mark.parametrize(("path", "items", "has_more", "header"), [
    ("/payouts/payout-requests?limit=2&offset=4", 2, True, "/payouts/payout-requests?limit=2&offset=6"),
    ("/payouts/payout-requests?limit=2", 1, True, None),  # short page: OF's hasMore is unreliable
    ("/payouts/payout-requests?limit=2", 2, False, None),
    (f"/transactions?limit=2&type=tip&startDate={D1}&x=1", 2, True,
     f"/transactions?startDate={D1}&type=tip&limit=2&offset=2"),
    ("/payouts/transactions?limit=2", 2, True, "/payouts/transactions?limit=2&offset=2"),
    ("/transactions?limit=2", 0, True, None),
])
def test_offset_lists_set_a_next_page(client, of_fake, path, items, has_more, header):
    of_fake.respond(_page(items, has_more))
    r = client.get(f"/of{path}", headers=H)
    assert r.status_code == 200 and r.json() == _page(items, has_more)
    assert r.headers.get("x-next-page") == header


@pytest.mark.parametrize(("items", "has_more", "header"), [
    (2, True, f"/engagement/messages/mass-messages?startDate={D1}&endDate={D2}&limit=2&offset=6"),
    (1, True, None),
    (2, False, None),
])
def test_mass_messages_page_on_items(client, of_fake, items, has_more, header):
    of_fake.respond(_page(items, has_more, key="items"))
    r = client.get(f"/of/engagement/messages/mass-messages?startDate={D1}&endDate={D2}&limit=2&offset=4",
                   headers=H)
    assert r.status_code == 200 and r.json() == _page(items, has_more, key="items")
    assert r.headers.get("x-next-page") == header


@pytest.mark.parametrize("path", [
    "/payouts/payout-requests?limit=0", "/payouts/payout-requests?offset=-1", "/transactions?limit=101",
    "/payouts/transactions?offset=-1", f"/engagement/messages/mass-messages?startDate={D1}&endDate={D2}&limit=0",
    f"/engagement/messages/mass-messages?startDate={D1}", f"/statistics/reach/profile-visitors?end_date={D2}",
    f"/statistics/reach/profile-visitors?start_date={D1}&end_date={D2}&limit=101",
    f"/statistics/statements/earnings?start_date={D1}",
])
def test_out_of_range_parameters_are_422(client, of_fake, path):
    assert client.get(f"/of{path}", headers=H).status_code == 422
    assert of_fake.calls == []


def test_of_4xx_passes_through(client, of_fake):
    of_fake.respond({"error": {"code": 0, "message": "Forbidden"}}, status=403)
    r = client.get("/of/payouts/balances", headers=H)
    assert (r.status_code, r.json()) == (403, {"error": {"code": "of_error", "status": 403}})

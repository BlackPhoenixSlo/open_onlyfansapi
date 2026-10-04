"""Payouts, statistics, chargebacks, transactions and engagement (plan-v5 Phase 4, `money.py`). Paths and
parameter names are the reference product's; each handler maps them to OF's wire names. Date parameters are
plain strings passed through as given; an empty one means OF's or OFClient's default."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response

from deps import Client
from of_client import API_BASE
from routes.shape import next_page, one_page, unsupported

router = APIRouter(prefix="/of", tags=["of-api"])


# ─── payouts ───────────────────────────────────────────────────────

@router.get("/payouts/balances", operation_id="payouts.balances.get")
def payouts_balances(client: Client) -> Any:
    return client.payout_balances()


@router.get("/payouts/earning-statistics", operation_id="payouts.earning_statistics.get")
def payouts_earning_statistics(client: Client, startDate: str = "", endDate: str = "") -> Any:
    return client.earning_stats(start=startDate, end=endDate)


@router.get("/payouts/eligibility", operation_id="payouts.eligibility.get")
def payouts_eligibility(client: Client) -> Any:
    return client.payout_check_receive()


@router.get("/payouts/payout-requests", operation_id="payouts.payout_requests.list")
def payouts_payout_requests(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    page = client.payout_requests(limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


@router.get("/payouts/transactions", operation_id="payouts.transactions.list")
@router.get("/transactions", operation_id="transactions.list")
def transactions_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    startDate: str = "",
    tx_type: Annotated[str, Query(alias="type")] = "",  # "" = every type
) -> Any:
    page = client.transactions(limit=limit, offset=offset, type=tx_type, start=startDate)
    next_page(request, response, page, limit, {"startDate": startDate, "type": tx_type}, offset=offset + limit)
    return page


# ─── chargebacks, statistics ───────────────────────────────────────

@router.get("/chargebacks", operation_id="chargebacks.list")
def chargebacks_list(
    client: Client, start_date: str = "", end_date: str = "",
    limit: Annotated[int, Query(ge=0)] = 0,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """One page, OF's own size. Empty dates mean every chargeback, so dates are sent only when given.
    `limit` and `offset` are 422s when set: OF's paging on this call is unverified (it pages by its own
    `marker`; a non-null `marker` in the answer means more chargebacks exist)."""
    if limit:
        raise unsupported("limit", "OF's page size on this call is unverified")
    one_page(offset)
    params = {k: v for k, v in {"startDate": start_date, "endDate": end_date}.items() if v}
    return client.request_json("GET", f"{API_BASE}/payouts/chargebacks", params=params)


@router.get("/chargebacks/ratio", operation_id="chargebacks.ratio.get")
def chargebacks_ratio(client: Client, start_date: str = "", end_date: str = "") -> Any:
    return client.chargebacks_ratio(start=start_date, end=end_date)


@router.get("/statistics/overview", operation_id="statistics.overview.get")
def statistics_overview(client: Client, start_date: str = "", end_date: str = "") -> Any:
    return client.my_stats_overview(start=start_date, end=end_date)


@router.get("/statistics/reach/profile-visitors", operation_id="statistics.reach.profile_visitors.get")
def statistics_profile_visitors(
    client: Client, start_date: str, end_date: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
) -> Any:
    """The reference's `type` and `filter` are not supported: OF's profile stats call takes neither."""
    return client.my_profile_stats(start=start_date, end=end_date, limit=limit)


@router.get("/statistics/statements/earnings", operation_id="statistics.statements.earnings.get")
def statistics_statements_earnings(client: Client, start_date: str, end_date: str) -> Any:
    """The reference's `type` is not supported: OF's earnings chart call does not take it."""
    return client.earnings_chart(start=start_date, end=end_date)


# ─── engagement ────────────────────────────────────────────────────

@router.get("/engagement/messages/mass-messages", operation_id="engagement.messages.mass_messages.list")
def engagement_mass_messages(
    client: Client, startDate: str, endDate: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """The reference's `query` is not supported: OF's mass-message stats call does not take it. No
    `x-next-page`: OF ignores `offset` on this call and always reports `hasMore` (plan-v6 §1.8.1)."""
    return client.mass_message_history(start_date=startDate, end_date=endDate, limit=limit, offset=offset)


@router.get("/engagement/messages/direct-messages", operation_id="engagement.messages.direct_messages.list")
def engagement_direct_messages(
    client: Client, startDate: str, endDate: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    query: str = "",
) -> Any:
    """One page: OF ignores `offset` on this call. The reference's `query` is a 422 when set: OF's
    direct-message stats call does not take it."""
    if query:
        raise unsupported("query")
    one_page(offset)
    return client.request_json("GET", f"{API_BASE}/users/me/stats/messages/direct",
                               params={"startDate": startDate, "endDate": endDate, "limit": limit})


@router.get("/engagement/messages/top-message", operation_id="engagement.messages.top_message.get")
def engagement_top_message(client: Client, startDate: str = "", endDate: str = "") -> Any:
    return client.request_json("GET", f"{API_BASE}/users/me/stats/top/message",
                               params=client.date_range_params(startDate or None, endDate or None))

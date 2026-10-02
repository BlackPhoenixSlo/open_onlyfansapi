"""Payouts, statistics, chargebacks, transactions and engagement (plan-v5 Phase 4, `money.py`). Paths and
parameter names are the reference product's; each handler maps them to OF's wire names. Date parameters are
plain strings passed to OF as given; an empty one takes the OFClient default (the last 30 days)."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response

from deps import Client
from routes.shape import next_page

router = APIRouter(prefix="/of", tags=["of-api"])


# ─── payouts ───────────────────────────────────────────────────────

@router.get("/payouts/balances", operation_id="payouts.balances.get")
def payouts_balances(client: Client) -> Any:
    return client.payout_balances()


@router.get("/payouts/earning-statistics", operation_id="payouts.earning_statistics.get")
def payouts_earning_statistics(client: Client, startDate: str = "", endDate: str = "") -> Any:
    return client.earning_stats(start=startDate or None, end=endDate or None)


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
    page = client.transactions(limit=limit, offset=offset, type=tx_type or None, start=startDate or None)
    next_page(request, response, page, limit, {"startDate": startDate, "type": tx_type}, offset=offset + limit)
    return page


# ─── chargebacks, statistics ───────────────────────────────────────

@router.get("/chargebacks/ratio", operation_id="chargebacks.ratio.get")
def chargebacks_ratio(client: Client, start_date: str = "", end_date: str = "") -> Any:
    return client.chargebacks_ratio(start=start_date or None, end=end_date or None)


@router.get("/statistics/overview", operation_id="statistics.overview.get")
def statistics_overview(client: Client, start_date: str = "", end_date: str = "") -> Any:
    return client.my_stats_overview(start=start_date or None, end=end_date or None)


# ─── engagement ────────────────────────────────────────────────────

@router.get("/engagement/messages/mass-messages", operation_id="engagement.messages.mass_messages.list")
def engagement_mass_messages(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    startDate: str = "",
    endDate: str = "",
) -> Any:
    dates = client._date_range_params(startDate or None, endDate or None)
    page = client.mass_message_history(start_date=dates["startDate"], end_date=dates["endDate"],
                                       limit=limit, offset=offset)
    # OF's page here is `{hasMore, items}`, not `{list, hasMore}`.
    if isinstance(page, dict):
        next_page(request, response, {"list": page.get("items"), "hasMore": page.get("hasMore")}, limit,
                  {"startDate": startDate, "endDate": endDate}, offset=offset + limit)
    return page

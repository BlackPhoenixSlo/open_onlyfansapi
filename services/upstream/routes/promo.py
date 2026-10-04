"""Tracking links, trial links, promotions and bundles (plan-v6, `promo.py`). Paths and parameter names are
the reference product's; each handler maps them to OF's wire names. Deleting a bundle is passthrough-only:
it changes subscription pricing (plan-v6 §9 Q6)."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from deps import Client
from of_client import API_BASE
from routes.shape import is_noop, next_page, refuse, unsupported

router = APIRouter(prefix="/of", tags=["of-api"])

# OFClient default; promotions verified to at least 100, trials only to 18. TRACKING_CAP is unverified.
TRIALS_CAP = PROMOTIONS_CAP = TRACKING_CAP = 100


def _page_bare_array(request: Request, response: Response, page: Any, limit: int, offset: int) -> None:
    """OF answers these lists as a bare array with no `hasMore`, but `offset` pages them (probes P12, P13):
    the full-page rule alone decides the next page."""
    if isinstance(page, list):
        next_page(request, response, {"list": page, "hasMore": True}, limit, {}, offset=offset + limit)


# ─── tracking links ────────────────────────────────────────────────

@router.get("/tracking-links", operation_id="tracking_links.list")
def tracking_links_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
    startDate: str = "", endDate: str = "", with_deleted: bool = False, sortby: str = "", sort: str = "",
) -> Any:
    """`startDate`, `endDate`, `with_deleted`, `sortby` and `sort` are 422s when set: OF's call takes none of
    them. `pagination` and `synchronous` are not supported and are ignored."""
    refuse(startDate=startDate, endDate=endDate, with_deleted=with_deleted, sortby=sortby, sort=sort)
    limit = min(limit, TRACKING_CAP)
    page = client.request_json("GET", f"{API_BASE}/campaigns", params={"limit": limit, "offset": offset})
    _page_bare_array(request, response, page, limit, offset)
    return page


class CreateTrackingLink(BaseModel):
    """`name` is sent; the reference's `tags` has no OF field and answers 422 unless empty (plan-v6 §1.2)."""
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)]
    tags: Any = None


@router.post("/tracking-links", operation_id="tracking_links.create")
def tracking_links_create(client: Client, body: CreateTrackingLink) -> Any:
    if not is_noop(body.tags):
        raise unsupported("tags")
    return client.create_tracking_link(name=body.name)


@router.delete("/tracking-links/{tracking_link_id}", operation_id="tracking_links.delete")
def tracking_links_delete(client: Client, tracking_link_id: int) -> Any:
    return client.delete_tracking_link(tracking_link_id)


# ─── trial links ───────────────────────────────────────────────────

@router.get("/trial-links", operation_id="trial_links.list")
def trial_links_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
    startDate: str = "", endDate: str = "", sort: str = "", field: str = "",
) -> Any:
    """`startDate`, `endDate`, `sort` and `field` are 422s when set: OF's call takes none of them.
    `synchronous` is not supported and is ignored."""
    refuse(startDate=startDate, endDate=endDate, sort=sort, field=field)
    limit = min(limit, TRIALS_CAP)
    page = client.trial_links(offset=offset, limit=limit)
    _page_bare_array(request, response, page, limit, offset)
    return page


@router.delete("/trial-links/{trial_link_id}", operation_id="trial_links.delete")
def trial_links_delete(client: Client, trial_link_id: int) -> Any:
    return client.delete_trial_link(trial_link_id)


# ─── promotions ────────────────────────────────────────────────────

@router.get("/promotions", operation_id="promotions.list")
def promotions_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    limit = min(limit, PROMOTIONS_CAP)
    page = client.promotions(offset=offset, limit=limit)
    if isinstance(page, dict):  # OF's `{hasMore, items}` page, read as `{list, hasMore}`
        next_page(request, response, {"list": page.get("items"), "hasMore": page.get("hasMore")}, limit, {},
                  offset=offset + limit)
    return page


@router.delete("/promotions/{promotion_id}", operation_id="promotions.delete")
def promotions_delete(client: Client, promotion_id: int) -> Any:
    return client.delete_promo(promotion_id)


# ─── bundles ───────────────────────────────────────────────────────

@router.get("/bundles", operation_id="bundles.list")
def bundles_list(client: Client) -> Any:
    return client.subscription_bundles()

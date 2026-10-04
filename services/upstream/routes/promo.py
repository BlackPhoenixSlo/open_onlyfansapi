"""Tracking links, trial links, promotions and bundles (plan-v6, `promo.py`). Paths and parameter names are
the reference product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from deps import ApiError, Client
from of_client import API_BASE
from routes.shape import next_page

router = APIRouter(prefix="/of", tags=["of-api"])


def _no_offset(offset: int) -> None:
    """Rows whose OF call has no cursor we can honour: a later page is a 422, never page 1 again (plan-v6 §2.3)."""
    if offset > 0:
        raise ApiError(422, "unsupported_field", "offset: this route returns one page only")


# ─── tracking links ────────────────────────────────────────────────

@router.get("/tracking-links", operation_id="tracking_links.list")
def tracking_links_list(
    client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """One page (OF answers a bare array). The reference's `startDate`, `endDate`, `with_deleted`, `sortby`,
    `sort`, `pagination` and `synchronous` are not supported: OF's call takes none of them."""
    _no_offset(offset)
    return client.request_json("GET", f"{API_BASE}/campaigns", params={"limit": limit})


class CreateTrackingLink(BaseModel):
    """`name` is sent; the reference's `tags` has no OF field and answers 422 when set (plan-v6 §1.2)."""
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)]
    tags: list[str] | None = None


@router.post("/tracking-links", operation_id="tracking_links.create")
def tracking_links_create(client: Client, body: CreateTrackingLink) -> Any:
    if body.tags:
        raise ApiError(422, "unsupported_field", "tags: not supported on this route")
    return client.create_tracking_link(name=body.name)


@router.delete("/tracking-links/{tracking_link_id}", operation_id="tracking_links.delete")
def tracking_links_delete(client: Client, tracking_link_id: int) -> Any:
    return client.delete_tracking_link(tracking_link_id)


# ─── trial links ───────────────────────────────────────────────────

@router.get("/trial-links", operation_id="trial_links.list")
def trial_links_list(
    client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """One page (OF answers a bare array). The reference's `startDate`, `endDate`, `sort`, `field` and
    `synchronous` are not supported: OF's call takes none of them."""
    _no_offset(offset)
    return client.trial_links(limit=limit)


@router.delete("/trial-links/{trial_link_id}", operation_id="trial_links.delete")
def trial_links_delete(client: Client, trial_link_id: int) -> Any:
    return client.delete_trial_link(trial_link_id)


# ─── promotions ────────────────────────────────────────────────────

@router.get("/promotions", operation_id="promotions.list")
def promotions_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
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


@router.delete("/bundles/{bundle_id}", operation_id="bundles.delete")
def bundles_delete(client: Client, bundle_id: int) -> Any:
    return client.delete_bundle(bundle_id)

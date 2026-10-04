"""Settings, release forms and notifications (plan-v6, `settings.py`). Paths and parameter names are the
reference product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict

from deps import ApiError, Client
from routes.shape import next_page, unsupported

router = APIRouter(prefix="/of", tags=["of-api"])

TAGGABLE_CAP = 20  # `tagged_friend_users`' default page


# ─── settings ──────────────────────────────────────────────────────

@router.get("/settings", operation_id="settings.get")
def settings_get(client: Client) -> Any:
    return client.my_settings()


def _setting(client: Client, key: str) -> Any:
    """One key of OF's settings; a missing key or another shape is a 502, never a null."""
    settings = client.my_settings()
    if not isinstance(settings, dict) or key not in settings:
        raise ApiError(502, "of_unexpected_response", "OF's settings had an unexpected shape")
    return settings[key]


@router.get("/settings/blocked-countries", operation_id="settings.blocked_countries.get")
def settings_blocked_countries(client: Client) -> Any:
    return {"blockedCountries": _setting(client, "blockedCountries")}


@router.get("/settings/drm", operation_id="settings.drm.get")
def settings_drm(client: Client) -> Any:
    return {"enabled": _setting(client, "isDrmEnabled")}


class UpdateProfile(BaseModel):
    """The reference body. Only `about` (the bio) has a verified OF mapping; every other field answers 422
    unless it is absent or null (plan-v6 §1.2: on an update `""` means "clear", so it is a 422 too)."""
    model_config = ConfigDict(extra="forbid")

    about: str  # required: the only field this route can set
    username: str | None = None
    name: str | None = None
    avatar: str | None = None
    header: str | None = None
    location: str | None = None
    website: str | None = None
    wishlist: str | None = None


@router.post("/settings/profile", operation_id="settings.profile.update")
def settings_profile(client: Client, body: UpdateProfile) -> Any:
    for field, value in body:
        if field != "about" and value is not None:
            raise unsupported(field)
    return client.update_profile(about=body.about)


@router.get("/settings/social-media-buttons", operation_id="settings.social_media_buttons.list")
def settings_social_media_buttons(client: Client) -> Any:
    return client.user_social_buttons(client.user_id)


# ─── release forms ─────────────────────────────────────────────────

@router.get("/release-forms/taggable-users", operation_id="release_forms.taggable_users.list")
def release_forms_taggable_users(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    name: Annotated[str, Query(max_length=100)] = "",  # a name search
    filter: str = "all",
    sort: str = "date",
    sortDirection: str = "desc",
) -> Any:
    """OF's tag picker. Only the order it was captured with is supported: `filter=all`, `sort=date`,
    `sortDirection=desc`; any other value is a 422."""
    for field, value, supported in (("filter", filter, "all"), ("sort", sort, "date"),
                                    ("sortDirection", sortDirection, "desc")):
        if value != supported:
            raise unsupported(field, f"only {supported} is supported")
    limit = min(limit, TAGGABLE_CAP)
    page = client.tagged_friend_users(search=name or None, limit=limit, offset=offset)
    if isinstance(page, dict):  # OF's `{items, hasMore}` page, read as `{list, hasMore}`
        next_page(request, response, {"list": page.get("items"), "hasMore": page.get("hasMore")}, limit,
                  {"name": name}, offset=offset + limit)
    return page


# ─── notifications ─────────────────────────────────────────────────
# GET notifications is passthrough-only: OF's list call may mark notifications read, and it was never probed.

@router.get("/notifications/counts", operation_id="notifications.counts")
def notifications_counts(client: Client) -> Any:
    return client.notifications_count()


@router.get("/notifications/tabs-order", operation_id="notifications.tabs_order")
def notifications_tabs_order(client: Client) -> Any:
    return client.notification_tabs_order()

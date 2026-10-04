"""Settings, release forms and notifications (plan-v6, `settings.py`). Paths and parameter names are the
reference product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict

from deps import ApiError, Client
from routes.shape import next_page

router = APIRouter(prefix="/of", tags=["of-api"])


def _unsupported(field: str, detail: str = "not supported on this route") -> ApiError:
    return ApiError(422, "unsupported_field", f"{field}: {detail}")


# ─── settings ──────────────────────────────────────────────────────

@router.get("/settings", operation_id="settings.get")
def settings_get(client: Client) -> Any:
    return client.my_settings()


def _my_settings(client: Client) -> dict:
    settings = client.my_settings()
    if not isinstance(settings, dict):
        raise ApiError(502, "of_unexpected_response", "OF's settings had an unexpected shape")
    return settings


@router.get("/settings/blocked-countries", operation_id="settings.blocked_countries.get")
def settings_blocked_countries(client: Client) -> Any:
    return {"blockedCountries": _my_settings(client).get("blockedCountries")}


@router.get("/settings/drm", operation_id="settings.drm.get")
def settings_drm(client: Client) -> Any:
    return {"enabled": _my_settings(client).get("isDrmEnabled")}


class UpdateProfile(BaseModel):
    """The reference body. Only `about` (the bio) has a verified OF mapping; every other field answers 422
    unless it is absent or null (plan-v6 §1.2: on an update `""` means "clear", so it is a 422 too)."""
    model_config = ConfigDict(extra="forbid")

    about: str | None = None
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
            raise _unsupported(field)
    if body.about is None:
        raise ApiError(422, "missing_field", "about: the only field this route can set")
    return client.update_profile(about=body.about)


@router.get("/settings/social-media-buttons", operation_id="settings.social_media_buttons.list")
def settings_social_media_buttons(client: Client) -> Any:
    return client.user_social_buttons(client.user_id)


# ─── release forms ─────────────────────────────────────────────────

@router.get("/release-forms/taggable-users", operation_id="release_forms.taggable_users.list")
def release_forms_taggable_users(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=20)] = 20,
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
            raise _unsupported(field, f"only {supported} is supported")
    page = client.tagged_friend_users(search=name or None, limit=limit, offset=offset)
    if isinstance(page, dict):  # OF's `{items, hasMore}` page, read as `{list, hasMore}`
        next_page(request, response, {"list": page.get("items"), "hasMore": page.get("hasMore")}, limit,
                  {"name": name}, offset=offset + limit)
    return page


# ─── notifications ─────────────────────────────────────────────────

# The reference's types with a verified OF value; the others are a 422.
_NOTIFICATION_TYPES = {"all": None, "subscriptions": "subscribed", "tips": "tipped", "comments": "commented",
                       "mentions": "mentioned"}


@router.get("/notifications", operation_id="notifications.list")
def notifications_list(
    client: Client,
    limit: Annotated[int, Query(ge=1, le=10)] = 10,
    type: str = "all",
    from_id: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """One page, newest first. The reference's `from_id` cursor is not supported (a 422 when set), and
    neither is `skip_users`: OF's call does not take it."""
    if type not in _NOTIFICATION_TYPES:
        raise ApiError(422, "unsupported_type", f"type: one of {', '.join(_NOTIFICATION_TYPES)}")
    if from_id:
        raise _unsupported("from_id", "this route returns one page only")
    return client.notifications(limit=limit, type=_NOTIFICATION_TYPES[type])


@router.get("/notifications/counts", operation_id="notifications.counts")
def notifications_counts(client: Client) -> Any:
    return client.notifications_count()


@router.get("/notifications/tabs-order", operation_id="notifications.tabs_order")
def notifications_tabs_order(client: Client) -> Any:
    return client.notification_tabs_order()

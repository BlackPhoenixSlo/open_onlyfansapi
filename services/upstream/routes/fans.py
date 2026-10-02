"""Fans, users, lists and the account itself (plan-v5 Phase 3, `fans.py`). Paths and parameter names are the
reference API's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Path, Query, Request, Response
from pydantic import AfterValidator, BaseModel, Field

from deps import ApiError, Client
from of_client import API_BASE, OFAPIError
from routes.shape import next_page

router = APIRouter(prefix="/of", tags=["of-api"])

# A list id is numeric for custom lists and a word for OF's own ("fans", "following"); no dots, so no `..`.
ListId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
DateQuery = Annotated[str, Query(max_length=32)]  # "" = OF's default window (the last 30 days)

# ─── me, statistics ────────────────────────────────────────────────


@router.get("/me", operation_id="me.get")
def me(client: Client) -> Any:
    return client.me()


@router.get("/me/model-start-date", operation_id="me.model-start-date")
def me_model_start_date(client: Client) -> Any:
    return client.my_start_date()


@router.get("/subscribers/statistics", operation_id="subscribers.statistics")
def subscribers_statistics(client: Client, start_date: DateQuery = "", end_date: DateQuery = "") -> Any:
    return client.subscribers_chart(start=start_date or None, end=end_date or None)


# ─── fans ──────────────────────────────────────────────────────────


def _fans_route(fan_type: str):
    def fans_list(
        request: Request, response: Response, client: Client,
        limit: Annotated[int, Query(ge=1, le=20)] = 10,  # OF caps this list at 20
        offset: Annotated[int, Query(ge=0)] = 0,
        online: Annotated[Literal["", "1", "0"], Query(alias="filter[online]")] = "",
        total_spent: Annotated[int, Query(alias="filter[total_spent]", ge=0)] = 0,  # 0 = no filter
        tips: Annotated[int, Query(alias="filter[tips]", ge=0)] = 0,
    ) -> Any:
        page = client.subscribers(type=fan_type, limit=limit, offset=offset,
                                  online=(online == "1") if online else None,
                                  min_spent=total_spent or None, min_tips=tips or None)
        next_page(request, response, page, limit,
                  {"filter[online]": online, "filter[total_spent]": total_spent or None,
                   "filter[tips]": tips or None}, offset=offset + limit)
        return page
    return fans_list


for _type in ("active", "all", "expired"):
    router.add_api_route(f"/fans/{_type}", _fans_route(_type), methods=["GET"], operation_id=f"fans.{_type}")


@router.get("/fans/latest", operation_id="fans.latest")
def fans_latest(
    request: Request, response: Response, client: Client,
    start_date: DateQuery = "", end_date: DateQuery = "",
    type: Literal["total", "renew", "new"] = "total",
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    params = {**client._date_range_params(start_date or None, end_date or None),
              "type": type, "limit": limit, "offset": offset}
    page = client.request_json("GET", f"{API_BASE}/subscriptions/subscribers/latest", params=params)
    if isinstance(page, dict):  # OF's page is `{users, hasMore}`, not `{list, hasMore}`
        next_page(request, response, {"list": page.get("users"), "hasMore": page.get("hasMore")}, limit,
                  {"start_date": start_date, "end_date": end_date, "type": type}, offset=offset + limit)
    return page


@router.get("/fans/top", operation_id="fans.top")
def fans_top(
    client: Client, start_date: DateQuery = "", end_date: DateQuery = "",
    by: Literal["total", "subscribes", "tips", "messages", "post", "streams"] = "total",
) -> Any:
    params = {**client._date_range_params(start_date or None, end_date or None), "by": by}
    return client.request_json("GET", f"{API_BASE}/subscriptions/subscribers/top", params=params)


class CustomName(BaseModel):
    custom_name: str  # "" clears it


@router.put("/fans/{fan_id}/custom-name", operation_id="fans.custom-name.update")
def fans_custom_name(client: Client, fan_id: int, body: CustomName) -> Any:
    return client.set_fan_custom_name(fan_id, body.custom_name)


class Notes(BaseModel):
    notes: str  # "" clears them


@router.put("/fans/{fan_id}/notes", operation_id="fans.notes.update")
def fans_notes(client: Client, fan_id: int, body: Notes) -> Any:
    return client.set_fan_note(fan_id, body.notes)


# ─── following ─────────────────────────────────────────────────────


def _following_route(follow_type: str):
    def following_list(
        request: Request, response: Response, client: Client,
        limit: Annotated[int, Query(ge=1, le=20)] = 10,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> Any:
        page = client.following(type=follow_type, limit=limit, offset=offset)
        next_page(request, response, page, limit, {}, offset=offset + limit)
        return page
    return following_list


for _type in ("active", "all", "expired"):
    router.add_api_route(f"/following/{_type}", _following_route(_type), methods=["GET"],
                         operation_id=f"following.{_type}")


# ─── users (literal paths before `users/{username}`) ───────────────


@router.get("/users/list", operation_id="users.list")
def users_list(
    client: Client,
    ids: Annotated[str, Query(pattern=r"^[0-9]{1,19}(,[0-9]{1,19}){0,49}$")],  # comma-separated, up to 50
) -> Any:
    # `OFClient.list_users`' URL, sent through `request_json` (list_users calls `self.http` directly).
    query = urlencode([("m[]", uid) for uid in ids.split(",")])
    return client.request_json("GET", f"{API_BASE}/users/list?{query}")


def _not_a_list_route(username: str) -> str:
    """`users/blocked` and `users/restricted` are the reference API's list routes (not served: OF path unknown),
    never usernames. pydantic's default regex engine has no lookahead, so this is a validator, not the pattern."""
    if username in ("blocked", "restricted"):
        raise ValueError("not a username")
    return username


@router.get("/users/{username}", operation_id="users.get")
def users_get(
    client: Client,
    username: Annotated[str, Path(pattern=r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$"), AfterValidator(_not_a_list_route)],
) -> Any:
    return client.get_user(username)  # a username or a numeric id


@router.post("/users/{user_id}/block", operation_id="users.block")
def users_block(client: Client, user_id: int) -> Any:
    return client.block_user(user_id)


@router.delete("/users/{user_id}/block", operation_id="users.unblock")
def users_unblock(client: Client, user_id: int) -> Any:
    return client.unblock_user(user_id)


@router.post("/users/{user_id}/restrict", operation_id="users.restrict")
def users_restrict(client: Client, user_id: int) -> Any:
    return client.restrict_user(user_id)


@router.delete("/users/{user_id}/restrict", operation_id="users.unrestrict")
def users_unrestrict(client: Client, user_id: int) -> Any:
    return client.unrestrict_user(user_id)


@router.post("/users/{user_id}/subscribe", operation_id="users.subscribe")
def users_subscribe(client: Client, user_id: int) -> Any:
    """Subscribe to a user. Free only when their subscription price is 0; otherwise OF charges the account.
    Check `subscribePrice` with GET users/{username} first."""
    return client.follow_user(user_id)


class Unsubscribe(BaseModel):
    reason: int  # OF's reason id; OF rejects an unsubscribe without one


@router.delete("/users/{user_id}/subscribe", operation_id="users.unsubscribe")
def users_unsubscribe(client: Client, user_id: int, body: Unsubscribe) -> Any:
    return client.unfollow_user(user_id, reason_id=body.reason)


@router.get("/users/{user_id}/labels", operation_id="users.labels")
def users_labels(client: Client, user_id: int) -> Any:
    return client.user_labels_on(user_id)


@router.get("/users/{user_id}/posts", operation_id="users.posts")
def users_posts(
    request: Request, response: Response, client: Client, user_id: int,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    order: Literal["publish_date", "favorites_count", "tips_summ"] = "publish_date",
    sort: Literal["desc", "asc"] = "desc",
    beforePublishTime: Annotated[str, Query(max_length=32)] = "",  # the previous page's `tailMarker`
) -> Any:
    page = client.user_posts(user_id, limit=limit, order=f"{order}_{sort}", format="infinite",
                             before_publish_time=beforePublishTime or None)
    # `tailMarker` is a publish time: it is a cursor only for newest-first order, and only while it moves.
    tail = page.get("tailMarker") if isinstance(page, dict) else None
    if (order, sort) == ("publish_date", "desc") and isinstance(tail, str) and tail and tail != beforePublishTime:
        next_page(request, response, page, limit, {"order": order, "sort": sort}, beforePublishTime=tail)
    return page


@router.get("/users/{user_id}/stories/highlights", operation_id="users.stories.highlights")
def users_highlights(client: Client, user_id: int) -> Any:
    return client.user_highlights(user_id)


# ─── user lists ────────────────────────────────────────────────────


class ListName(BaseModel):
    name: Annotated[str, Field(min_length=1)]


@router.get("/user-lists", operation_id="user-lists.index")
def user_lists_index(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    page = client.get_lists(limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


@router.post("/user-lists", operation_id="user-lists.store")
def user_lists_store(client: Client, body: ListName) -> Any:
    return client.create_list(body.name)


@router.get("/user-lists/{userListId}", operation_id="user-lists.show")
def user_lists_show(client: Client, userListId: ListId) -> Any:
    return client.get_list(userListId)


@router.put("/user-lists/{userListId}", operation_id="user-lists.update.put")
@router.patch("/user-lists/{userListId}", operation_id="user-lists.update")
def user_lists_update(client: Client, userListId: ListId, body: ListName) -> Any:
    return client.rename_list(userListId, body.name)


@router.delete("/user-lists/{userListId}", operation_id="user-lists.destroy")
def user_lists_destroy(client: Client, userListId: ListId) -> Any:
    return client.delete_list(userListId)


@router.get("/user-lists/{userListId}/users", operation_id="user-lists.users")
def user_lists_users(
    request: Request, response: Response, client: Client, userListId: ListId,
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    page = client.list_users_in(userListId, limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


class AddUsers(BaseModel):
    ids: Annotated[list[int], Field(min_length=1, max_length=50)]
    skip_invalid: bool = False


_PER_ID_ERRORS = {400, 404, 422}  # OF rejected this one id; anything else (401, 429, 5xx) is not per id


@router.post("/user-lists/{userListId}/users", operation_id="user-lists.users.add")
def user_lists_users_add(client: Client, userListId: ListId, body: AddUsers) -> Any:
    """One OF call per user, in order. With `skip_invalid`, an OF 400/404/422 for one id is reported in
    `{added, failed}`; any other error stops the request. Without it, the first OF error stops the request,
    and its message names the ids already added (they stay added)."""
    added: list[int] = []
    failed: dict[str, str] = {}
    for uid in body.ids:
        try:
            client.add_user_to_list(userListId, uid)
        except OFAPIError as e:
            status = getattr(e.response, "status_code", None) or 502
            if body.skip_invalid and status in _PER_ID_ERRORS:
                failed[str(uid)] = f"of_error {status}"
                continue
            if added and not body.skip_invalid:
                raise ApiError(status, "of_error",
                               f"stopped at user {uid}; already added: {','.join(map(str, added))}") from e
            raise
        added.append(uid)
    return {"added": added, "failed": failed} if body.skip_invalid else {userListId: added}


@router.delete("/user-lists/{userListId}/users/{userId}", operation_id="user-lists.remove-user")
def user_lists_remove_user(client: Client, userListId: ListId, userId: int) -> Any:
    return client.remove_user_from_list(userListId, userId)

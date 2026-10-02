"""Chats, chat messages, mass messaging, the queue and Giphy (plan-v5 Phase 2, `chats.py`). Paths and
parameter names are the reference product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from deps import ApiError, Client
from of_client import API_BASE
from routes.shape import next_page, page_items

router = APIRouter(prefix="/of", tags=["of-api"])


# ─── chats ─────────────────────────────────────────────────────────

@router.get("/chats", operation_id="chats.list")
def chats_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
    order: Literal["recent", "old"] = "recent",
    skip_users: Literal["all", "none"] = "all",
    filter: str = "",  # "" = every chat
    query: str = "",
) -> Any:
    page = client.list_chats(limit=limit, offset=offset, order=order, filter=filter or None,
                             query=query or None, skip_users=None if skip_users == "none" else "all")
    next_page(request, response, page, limit,
              {"order": order, "skip_users": skip_users, "filter": filter, "query": query}, offset=offset + limit)
    return page


@router.post("/chats/mark-as-read", operation_id="chats.markAllRead")
def chats_mark_all_read(client: Client) -> Any:
    return client.mark_all_chats_read()


@router.post("/chats/{chat_id}/hide", operation_id="chats.hide")
def chats_hide(client: Client, chat_id: int) -> Any:
    return client.hide_chat(chat_id)


@router.post("/chats/{chat_id}/mark-as-read", operation_id="chats.markRead")
def chats_mark_read(client: Client, chat_id: int) -> Any:
    return client.mark_chat_read(chat_id)


@router.post("/chats/{chat_id}/mark-as-unread", operation_id="chats.markUnread")
def chats_mark_unread(client: Client, chat_id: int) -> Any:
    return client.mark_chat_unread(chat_id)


@router.get("/chats/{chat_id}/media", operation_id="chats.media")
def chats_media(
    request: Request, response: Response, client: Client, chat_id: int,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    skip_users: Literal["all", "none"] = "all",
) -> Any:
    page = client.chat_media(chat_id, limit=limit, offset=offset,
                             skip_users=None if skip_users == "none" else "all")
    next_page(request, response, page, limit, {"skip_users": skip_users}, offset=offset + limit)
    return page


@router.post("/chats/{chat_id}/mute", operation_id="chats.mute")
def chats_mute(client: Client, chat_id: int) -> Any:
    return client.mute_chat(chat_id)


@router.delete("/chats/{chat_id}/unmute", operation_id="chats.unmute")
def chats_unmute(client: Client, chat_id: int) -> Any:
    return client.unmute_chat(chat_id)


# ─── chat messages ─────────────────────────────────────────────────

@router.get("/chats/{chat_id}/messages", operation_id="chats.messages.list")
def chats_messages_list(
    request: Request, response: Response, client: Client, chat_id: int,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    order: Literal["desc", "asc"] = "desc",
    first_id: Annotated[int, Query(ge=0)] = 0,  # messages older than this id (OF's `id`); 0 = newest
    offset: Annotated[int, Query(ge=0)] = 0,  # order=asc: messages to skip from the first one
) -> Any:
    page = client.get_messages(chat_id, limit=limit, order=order, before_id=first_id or None,
                               offset=offset or None)
    items = page_items(page)
    if order == "asc":
        next_page(request, response, page, limit, {"order": order, "first_id": first_id or None},
                  offset=offset + limit)
    elif items and isinstance(items[-1], dict) and isinstance(items[-1].get("id"), int):
        # OF returns fewer messages than `limit` asks for: an id cursor pages on any non-empty page.
        next_page(request, response, page, limit, {"order": order}, full=False, first_id=items[-1]["id"])
    return page


class SendMessage(BaseModel):
    text: str
    price: float = 0
    mediaFiles: list[int] = []  # the reference product's and OF's names
    previews: list[int] = []
    lockedText: bool = False


@router.post("/chats/{chat_id}/messages", operation_id="chats.messages.send")
def chats_messages_send(client: Client, chat_id: int, body: SendMessage) -> Any:
    return client.send_message(
        chat_id, body.text, price=body.price, media_files=body.mediaFiles,
        previews=body.previews, locked_text=body.lockedText)


@router.get("/chats/{chat_id}/messages/pinned", operation_id="chats.messages.pinned")
def chats_messages_pinned(client: Client, chat_id: int, limit: Annotated[int, Query(ge=1, le=50)] = 50) -> Any:
    return client.get_pinned_messages(chat_id, limit=limit)  # the rows: OF's hasMore lies on this filter


@router.get("/chats/{chat_id}/messages/search", operation_id="chats.messages.search")
def chats_messages_search(client: Client, chat_id: int, query: Annotated[str, Query(min_length=1)]) -> Any:
    return client.search_chat(chat_id, query)  # matching message ids, newest first


@router.delete("/chats/{chat_id}/messages/{message_id}", operation_id="chats.messages.unsend")
def chats_messages_unsend(client: Client, chat_id: int, message_id: int) -> Any:
    return client.unsend_message(message_id, with_user_id=chat_id)


@router.post("/chats/{chat_id}/messages/{message_id}/like", operation_id="chats.messages.like")
def chats_messages_like(client: Client, chat_id: int, message_id: int) -> Any:
    return client.like_message(message_id)


@router.post("/chats/{chat_id}/messages/{message_id}/pin", operation_id="chats.messages.pin")
def chats_messages_pin(client: Client, chat_id: int, message_id: int) -> Any:
    # OF's pin is a toggle: pinning a pinned message unpins it and still answers success. Read the
    # pinned list first and refuse rather than toggle blind when OF's answer is not the expected page.
    page = client.request_json("GET", f"{API_BASE}/chats/{chat_id}/messages", params={
        "limit": 50, "order": "desc", "skip_users": "all", "filter": "pinned"})
    pinned = page_items(page)
    if pinned is None:
        raise ApiError(502, "of_unexpected_response", "OF's pinned list had an unexpected shape")
    if any(isinstance(m, dict) and m.get("id") == message_id for m in pinned):
        return {"success": True}
    return client.pin_message(message_id, chat_id)


@router.delete("/chats/{chat_id}/messages/{message_id}/unlike", operation_id="chats.messages.unlike")
def chats_messages_unlike(client: Client, chat_id: int, message_id: int) -> Any:
    return client.unlike_message(message_id)


@router.delete("/chats/{chat_id}/messages/{message_id}/unpin", operation_id="chats.messages.unpin")
def chats_messages_unpin(client: Client, chat_id: int, message_id: int) -> Any:
    return client.unpin_message(message_id, chat_id)


# ─── mass messaging ────────────────────────────────────────────────

@router.get("/mass-messaging", operation_id="massMessaging.list")
def mass_messaging_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    # Queue entries (yaml: id/isReady/isDone/total/pending), so OF's message queue; history is the overview.
    page = client.scheduled_messages(limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


class MassMessage(BaseModel):
    """The reference body's fields that OF's queue call takes; any other field is a 422, not dropped."""
    model_config = ConfigDict(extra="forbid")

    text: str
    userIds: list[int] = Field(min_length=1, max_length=1, description=(
        "Exactly one recipient; multi-recipient lists and send-now go through the passthrough."))
    scheduledDate: str = Field(description="Required: ISO 8601 with an offset.")
    price: float = 0
    mediaFiles: list[int] = []
    previews: list[int] = []
    lockedText: bool = False


@router.post("/mass-messaging", operation_id="massMessaging.create")
def mass_messaging_create(client: Client, body: MassMessage) -> Any:
    return client.schedule_message(
        body.userIds[0], body.text, scheduled_date=body.scheduledDate, price=body.price,
        locked_text=body.lockedText, media_files=body.mediaFiles, previews=body.previews)


@router.get("/mass-messaging/overview", operation_id="massMessaging.overview")
def mass_messaging_overview(
    request: Request, response: Response, client: Client,
    startDate: str,  # 'YYYY-MM-DD HH:MM:SS'
    endDate: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    # yaml: takes startDate/endDate, returns {hasMore, items} with sentCount/viewedCount: OF's stats history.
    page = client.mass_message_history(start_date=startDate, end_date=endDate, limit=limit, offset=offset)
    if isinstance(page, dict):  # OF's `{hasMore, items}` page, read as `{list, hasMore}`
        next_page(request, response, {"list": page.get("items"), "hasMore": page.get("hasMore")}, limit,
                  {"startDate": startDate, "endDate": endDate}, offset=offset + limit)
    return page


@router.delete("/mass-messaging/{mass_messaging}", operation_id="massMessaging.delete")
def mass_messaging_delete(client: Client, mass_messaging: int) -> Any:
    return client.cancel_scheduled(mass_messaging)


# ─── queue ─────────────────────────────────────────────────────────

@router.get("/queue", operation_id="queue.list")
def queue_list(
    client: Client,
    publishDateStart: str,  # yyyy-mm-dd
    publishDateEnd: str,
    timezone: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Any:
    return client.schedules(publish_date=publishDateStart, publish_date_end=publishDateEnd,
                            time_zone=timezone, limit=limit)


@router.get("/queue/counts", operation_id="queue.counts")
def queue_counts(client: Client, publishDateStart: str, publishDateEnd: str, timezone: str) -> Any:
    return client.schedule_counters(publish_date=publishDateStart, publish_date_end=publishDateEnd,
                                    time_zone=timezone)


# ─── giphy ─────────────────────────────────────────────────────────

@router.get("/giphy/search", operation_id="giphy.search")
def giphy_search(
    client: Client,
    q: Annotated[str, Query(min_length=1)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    return client.gif_search(q, limit=limit, offset=offset)


@router.get("/giphy/trending", operation_id="giphy.trending")
def giphy_trending(
    client: Client,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    return client.gif_trending(limit=limit, offset=offset)

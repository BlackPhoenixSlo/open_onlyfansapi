"""Chats and chat messages (plan-v5 Phase 2, `chats.py`). Paths and parameter names are the reference
product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel

from deps import Client
from routes.shape import next_page, page_items

router = APIRouter(prefix="/of", tags=["of-api"])


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

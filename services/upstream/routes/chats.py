"""Chats and chat messages (plan-v5 Phase 2, `chats.py`). Paths and parameter names are the reference
product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from deps import Client
from routes.shape import next_page

router = APIRouter(prefix="/of", tags=["of-api"])


@router.get("/chats", operation_id="chats.list")
def chats_list(
    request: Request, response: Response, client: Client,
    limit: int = 10,
    offset: int = 0,
    order: Literal["recent", "old"] = "recent",
    skip_users: Literal["all", "none"] = "all",
    filter: str = "",  # "" = every chat
    query: str = "",
) -> Any:
    page = client.list_chats(limit=limit, offset=offset, order=order, filter=filter or None,
                             query=query or None, skip_users=None if skip_users == "none" else "all")
    next_page(request, response, page, limit, limit=limit, offset=offset + limit)
    return page


@router.get("/chats/{chat_id}/messages", operation_id="chats.messages.list")
def chats_messages_list(
    request: Request, response: Response, client: Client, chat_id: int,
    limit: int = 10,
    order: Literal["desc", "asc"] = "desc",
    first_id: int = 0,  # order=desc: messages older than this id (OF's `id`); 0 = newest
) -> Any:
    page = client.get_messages(chat_id, limit=limit, order=order, before_id=first_id or None)
    items = page.get("list") if isinstance(page, dict) else None
    oldest = items[-1].get("id") if order == "desc" and items and isinstance(items[-1], dict) else None
    if isinstance(oldest, int):  # an asc cursor is not known: asc pages set no next page
        next_page(request, response, page, limit, limit=limit, first_id=oldest)
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

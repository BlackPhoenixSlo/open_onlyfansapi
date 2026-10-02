"""Posts and the media vault (the v4 routes; the rest of the group is plan-v6). Paths and parameter
names are the reference product's; each handler maps them to OF's wire names."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response

from deps import Client
from routes.shape import next_page

router = APIRouter(prefix="/of", tags=["of-api"])


@router.get("/posts", operation_id="posts.list")
def posts_list(request: Request, response: Response, client: Client, limit: int = 10, offset: int = 0) -> Any:
    page = client.list_posts(limit=limit, offset=offset)
    next_page(request, response, page, limit, limit=limit, offset=offset + limit)
    return page


@router.get("/posts/{post_id}", operation_id="posts.get")
def posts_get(client: Client, post_id: int) -> Any:
    return client.get_post(post_id)


@router.get("/media/vault", operation_id="media.vault.list")
def media_vault_list(
    request: Request, response: Response, client: Client,
    limit: int = 24,
    offset: int = 0,
    query: str = "",
    field: Literal["recent", "most-liked", "highest-tips"] = "recent",
    sort: Literal["desc", "asc"] = "desc",
    media_type: Annotated[Literal["", "photo", "gif", "video", "audio"], Query(alias="type")] = "",
    list_id: Annotated[int, Query(alias="list")] = 0,  # 0 = every list
) -> Any:
    page = client.vault_media(limit=limit, offset=offset, type=media_type or "all", list_id=list_id or None,
                              sort=sort, field=field, query=query or None)
    next_page(request, response, page, limit, limit=limit, offset=offset + limit)
    return page


@router.get("/media/vault/{media_id}", operation_id="media.vault.get")
def media_vault_get(client: Client, media_id: int) -> Any:
    return client.vault_media_by_id(media_id)

"""Posts, the media vault, stories and saved-for-later (plan-v6, `content.py`). Paths and parameter names
are the reference product's; each handler maps them to OF's wire names. Write bodies follow plan-v6 §1.2:
a reference field with no verified OF mapping is declared and answers `422 unsupported_field` when set."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from deps import Client
from of_client import API_BASE
from routes.shape import is_noop, next_page, one_page, unsupported

router = APIRouter(prefix="/of", tags=["of-api"])

# OF caps for the paged lists below (plan-v6 §2.3). A larger `limit` is clamped, not refused, so a full page
# still yields `x-next-page`.
LABELS_CAP = VAULT_LISTS_CAP = SAVED_POSTS_CAP = 10


# ─── posts ─────────────────────────────────────────────────────────

@router.get("/posts", operation_id="posts.list")
def posts_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    page = client.list_posts(limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


class CreatePost(BaseModel):
    """The reference body. `text` and `mediaFiles` (vault ids) are sent; posts are free (the reference has
    no price). Every other field has no verified OF mapping (plan-v6 §1.2): it answers 422 unless it is a
    no-op (null, "", [] or false), because dropping `scheduledDate` or `saveForLater` would publish the post
    now. Those fields are untyped so the no-op check sees the raw JSON value: `saveForLater: 0` is a 422,
    never coerced to false. `previews` are confirmed on paid posts only, and posts here are free."""
    model_config = ConfigDict(extra="forbid")

    text: StrictStr
    mediaFiles: list[StrictInt] = []
    previews: Any = None
    scheduledDate: Any = None
    expireDays: Any = None
    fundRaisingTargetAmount: Any = None
    fundRaisingTipsPresets: Any = None
    labelIds: Any = None
    rfTag: Any = None
    saveForLater: Any = None
    votingType: Any = None
    votingOptions: Any = None
    votingDue: Any = None
    votingCorrectIndex: Any = None
    blockBannedWords: Any = None


@router.post("/posts", operation_id="posts.create")
def posts_create(client: Client, body: CreatePost) -> Any:
    for field, value in body:
        if field not in ("text", "mediaFiles") and not is_noop(value):
            raise unsupported(field)
    return client.create_post(body.text, media_files=body.mediaFiles)


@router.get("/posts/labels", operation_id="posts.labels.list")
def posts_labels(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    limit = min(limit, LABELS_CAP)
    page = client.request_json("GET", f"{API_BASE}/labels", params={"limit": limit, "offset": offset})
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


@router.get("/posts/{post_id}", operation_id="posts.get")
def posts_get(client: Client, post_id: int) -> Any:
    return client.get_post(post_id)


@router.delete("/posts/{post_id}", operation_id="posts.delete")
def posts_delete(client: Client, post_id: int) -> Any:
    return client.delete_post(post_id)


@router.get("/posts/{post_id}/comments", operation_id="posts.comments.list")
def posts_comments(
    client: Client, post_id: int,
    limit: Annotated[int, Query(ge=1, le=20)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    sort: Literal["desc", "asc"] = "desc",
) -> Any:
    """One page, newest first: OF's paging and oldest-first order on this call are unverified."""
    one_page(offset)
    if sort == "asc":
        raise unsupported("sort", "only desc is supported")
    return client.post_comments(post_id, limit=limit)


# ─── media vault ───────────────────────────────────────────────────

@router.get("/media/vault", operation_id="media.vault.list")
def media_vault_list(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
    offset: Annotated[int, Query(ge=0)] = 0,
    query: str = "",
    field: Literal["recent", "most-liked", "highest-tips"] = "recent",
    sort: Literal["desc", "asc"] = "desc",
    media_type: Annotated[Literal["all", "photo", "gif", "video", "audio"], Query(alias="type")] = "all",
    list_id: Annotated[int, Query(alias="list", ge=0)] = 0,  # 0 = every list
) -> Any:
    page = client.vault_media(limit=limit, offset=offset, type=media_type, list_id=list_id or None,
                              sort=sort, field=field, query=query or None)
    next_page(request, response, page, limit,
              {"query": query, "field": field, "sort": sort, "type": media_type, "list": list_id or None},
              offset=offset + limit)
    return page


class VaultListName(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1)]


class VaultListMedia(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mediaIds: Annotated[list[int], Field(min_length=1)]  # vault media ids


@router.get("/media/vault/lists", operation_id="media.vault.lists.list")
def media_vault_lists(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
    query: str = "",
) -> Any:
    """OF's folder list takes no search: the reference's `query` is a 422 when set. Its `lightweight`
    (response size only) is not supported and is ignored."""
    if query:
        raise unsupported("query")
    limit = min(limit, VAULT_LISTS_CAP)
    page = client.vault_lists(view="main", limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


@router.post("/media/vault/lists", operation_id="media.vault.lists.create")
def media_vault_lists_create(client: Client, body: VaultListName) -> Any:
    return client.create_vault_list(body.name)


@router.get("/media/vault/lists/{list_id}", operation_id="media.vault.lists.get")
def media_vault_lists_get(client: Client, list_id: int) -> Any:
    return client.request_json("GET", f"{API_BASE}/vault/lists/{list_id}")


@router.put("/media/vault/lists/{list_id}", operation_id="media.vault.lists.update.put")
@router.patch("/media/vault/lists/{list_id}", operation_id="media.vault.lists.update")
def media_vault_lists_update(client: Client, list_id: int, body: VaultListName) -> Any:
    return client.rename_vault_list(list_id, body.name)


@router.delete("/media/vault/lists/{list_id}", operation_id="media.vault.lists.delete")
def media_vault_lists_delete(client: Client, list_id: int) -> Any:
    return client.delete_vault_list(list_id, clear_media=False)  # the media stay in the vault


@router.post("/media/vault/lists/{list_id}/media", operation_id="media.vault.lists.media.add")
def media_vault_lists_media_add(client: Client, list_id: int, body: VaultListMedia) -> Any:
    return client.add_media_to_vault_list(list_id, body.mediaIds)


@router.get("/media/vault/{media_id}", operation_id="media.vault.get")
def media_vault_get(client: Client, media_id: int) -> Any:
    return client.vault_media_by_id(media_id)


# ─── stories ───────────────────────────────────────────────────────

@router.get("/stories", operation_id="stories.list")
def stories_list(client: Client) -> Any:
    return client.my_stories()


@router.get("/stories/archive", operation_id="stories.archive.list")
def stories_archive(
    client: Client,
    limit: Annotated[int, Query(ge=1, le=20)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    marker: str = "",
) -> Any:
    """One page: OF ignores `offset` here (a 422 above 0), and the reference's `marker` cursor is a 422 too."""
    one_page(offset)
    if marker:
        raise unsupported("marker", "this route returns one page only")
    return client.my_stories_archive(limit=limit)


@router.get("/stories/highlights", operation_id="stories.highlights.list")
def stories_highlights(
    client: Client,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """OF's answer as is: its highlights call takes no paging (unprobed whether one answer holds every
    highlight). The reference's `limit` is not supported and is ignored; `offset` above 0 is a 422."""
    one_page(offset)
    return client.user_highlights(client.user_id)


@router.get("/stories/{story_id}", operation_id="stories.get")
def stories_get(client: Client, story_id: int) -> Any:
    return client.request_json("GET", f"{API_BASE}/stories/{story_id}")


@router.delete("/stories/{story_id}", operation_id="stories.delete")
def stories_delete(client: Client, story_id: int) -> Any:
    return client.delete_story(story_id)


# ─── saved for later ───────────────────────────────────────────────

@router.get("/saved-for-later/messages", operation_id="saved_for_later.messages.list")
def saved_for_later_messages(
    client: Client,
    limit: Annotated[int, Query(ge=1, le=10)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    """One page: OF's paging on this call is unverified."""
    one_page(offset)
    return client.schedules_later_chat(limit=limit)


@router.get("/saved-for-later/messages/settings", operation_id="saved_for_later.messages.settings")
def saved_for_later_messages_settings(client: Client) -> Any:
    return client.settings_chat()


@router.get("/saved-for-later/posts", operation_id="saved_for_later.posts.list")
def saved_for_later_posts(
    request: Request, response: Response, client: Client,
    limit: Annotated[int, Query(ge=1)] = 10,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Any:
    limit = min(limit, SAVED_POSTS_CAP)
    page = client.schedules_later_post(limit=limit, offset=offset)
    next_page(request, response, page, limit, {}, offset=offset + limit)
    return page


@router.get("/saved-for-later/posts/settings", operation_id="saved_for_later.posts.settings")
def saved_for_later_posts_settings(client: Client) -> Any:
    return client.settings_post()

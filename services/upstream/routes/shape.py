"""Response helpers shared by the named-route modules (plan-v5 §2.2)."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from fastapi import Request, Response


def page_items(page: Any) -> list | None:
    """The items of OF's `{list, hasMore}` page; None when OF sent another shape."""
    items = page.get("list") if isinstance(page, dict) else None
    return items if isinstance(items, list) else None


def next_page(request: Request, response: Response, page: Any, limit: int, params: dict[str, Any], /,
              *, full: bool = True, **cursor: Any) -> None:
    """Set `x-next-page: /<tail>?<next query>` when OF's page is non-empty and OF reports `hasMore`.

    `full=True` (offset cursors) also needs `limit` items or more: OF's `hasMore` is unreliable, so a
    short page ends pagination. Use `full=False` only for id cursors on endpoints that ignore `limit`.
    The next query is `params` (the handler's declared parameters, minus `limit` and the cursor),
    then `limit`, then `cursor`; empty values are left out. An unexpected OF shape sets nothing."""
    items = page_items(page)
    if not items or page.get("hasMore") is not True or (full and len(items) < limit):
        return
    query = {k: v for k, v in {**params, "limit": limit, **cursor}.items() if v not in ("", None)}
    response.headers["x-next-page"] = f"{request.url.path.removeprefix('/of')}?{urlencode(query)}"

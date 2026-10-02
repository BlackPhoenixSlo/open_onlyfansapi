"""Response helpers shared by the named-route modules (plan-v5 §2.2)."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from fastapi import Request, Response


def next_page(request: Request, response: Response, page: Any, limit: int, /, **query: Any) -> None:
    """Set `x-next-page: /<tail>?<next query>` when OF's `{list, hasMore}` page is full (`limit` items or
    more) and OF reports `hasMore`. A short or empty page never sets it: OF's `hasMore` is unreliable.

    `query` is the cursor for the next page; it overrides the request's own query parameters."""
    items = page.get("list") if isinstance(page, dict) else None
    if not isinstance(items, list) or limit <= 0 or len(items) < limit or page.get("hasMore") is not True:
        return
    params = {**request.query_params, **{k: str(v) for k, v in query.items()}}
    tail = request.url.path.removeprefix("/of")
    response.headers["x-next-page"] = f"{tail}?{urlencode(params)}"

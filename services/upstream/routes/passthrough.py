"""Raw passthrough `ANY /of/_of/{path}` to OF's `/api2/v2/{path}` (plan-v5 §2.1).

OF's status, body bytes and content-type come back unchanged; no client header reaches OF
and no OF header but content-type comes back. No ledger rows, no events.
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from app import ApiError, Client
from of_client import API_BASE

_PATH = re.compile(r"[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*")

DESCRIPTION = f"""Raw passthrough: sends the request to OnlyFans at `{API_BASE}/{{path}}` with the query string
unchanged, signed with the account's session, and returns OnlyFans' status, body bytes and `content-type` unchanged.
OnlyFans' 4xx and 5xx responses are returned as they are. The body, if any, must be JSON. No client header is
forwarded and no other OnlyFans header is returned.

The reference API does not document what its `_of/{{path}}` maps to. Mapping it to OnlyFans' `/api2/v2/{{path}}` is
this gateway's assumption and may differ from the reference product's mapping."""

router = APIRouter(prefix="/of", tags=["of-api"])


def _check_path(path: str) -> None:
    if (not _PATH.fullmatch(path) or path.startswith("http")
            or any(seg in {".", ".."} for seg in path.split("/"))):
        raise ApiError(400, "invalid_path", "path must be an OnlyFans /api2/v2/ path")


async def _json_body(request: Request) -> object | None:
    raw = await request.body()
    if not raw:
        return None
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise ApiError(415, "unsupported_media_type", "the request body must be application/json")
    try:
        return json.loads(raw)
    except ValueError:  # JSONDecodeError and UnicodeDecodeError
        raise ApiError(400, "invalid_json", "the request body is not valid JSON") from None


async def passthrough(request: Request, client: Client, path: str) -> Response:
    _check_path(path)
    json_body = await _json_body(request)
    # The absolute URL is built here, so `_build_url` never sees the client's string on its own.
    url = f"{API_BASE}/{path}"
    if request.url.query:
        url += f"?{request.url.query}"
    r = await run_in_threadpool(client.request, request.method, url, json_body=json_body)
    content_type = r.headers.get("content-type")
    return Response(r.content, status_code=r.status_code,
                    headers={"content-type": content_type} if content_type else None)


for _method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
    router.add_api_route(
        "/_of/{path:path}", passthrough, methods=[_method],
        operation_id=f"of.passthrough.{_method.lower()}",
        summary=f"Raw OnlyFans {_method}", description=DESCRIPTION,
    )

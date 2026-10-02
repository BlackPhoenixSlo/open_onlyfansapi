"""Upstream service: OF REST under `/of/*`, account rows, session bootstrap and
the `/ws` event stream for the gateway (plan-v4 §2.1, §2.2).

Run exactly one worker: the pumps and the hub live in this process.
    UPSTREAM_TOKEN=... uvicorn app:app --port 8000 --workers 1 --ws websockets-sansio
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
from contextlib import asynccontextmanager, suppress
from pathlib import Path as PathType
from typing import Annotated, Any
from urllib.parse import urlsplit

from curl_cffi.requests import exceptions as curl_errors
from fastapi import APIRouter, Depends, FastAPI, Header, Path, Request, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import accounts
import client_pool
import config
import proxies
import session_bootstrap
from of_client import OFAPIError, OFClient
from pump import Hub, Supervisor

logging.basicConfig(
    level=(os.environ.get("LOG_LEVEL") or "info").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# websockets at DEBUG would log OF's connect token and fans' message text.
logging.getLogger("websockets").setLevel(max(logging.INFO, logging.getLogger().level))
log = logging.getLogger("upstream")

TOKEN = os.environ.get("UPSTREAM_TOKEN") or ""
if len(TOKEN) < 16:
    raise SystemExit("UPSTREAM_TOKEN must be set to at least 16 characters")
_BEARER = f"Bearer {TOKEN}".encode()
_WS_PROTOCOL = f"bearer.{TOKEN}".encode()

hub = Hub()
# `supervisor.require_proxy` is the one OF_REQUIRE_PROXY switch; `supervisor.blocker()` the one gate.
supervisor = Supervisor(hub, require_proxy=(os.environ.get("OF_REQUIRE_PROXY") or "true").strip().lower()
                        not in {"0", "false", "no", "off"})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not os.environ.get("STATIC_PARAM"):
        log.warning("STATIC_PARAM is unset: /session/bootstrap needs a static_param field "
                    "unless a session at the same OF revision already exists")
    if not supervisor.require_proxy:
        log.warning("OF_REQUIRE_PROXY is off: accounts without a proxy reach OF from this host's IP")
    tasks = [asyncio.create_task(supervisor.run()), asyncio.create_task(hub.heartbeat())]
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            with suppress(asyncio.CancelledError):
                await t
        await supervisor.stop()


app = FastAPI(
    title="Gateway upstream",
    version="1.0.0",
    openapi_url="/docs/json",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


# ─── Errors and auth ──────────────────────────────────────────────


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str | None = None) -> None:
        super().__init__(code)
        self.status, self.code, self.message = status, code, message


def _error(http_status: int, code: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": {"code": code, **extra}}, status_code=http_status)


@app.exception_handler(ApiError)
async def _api_error(_req: Request, e: ApiError) -> JSONResponse:
    return _error(e.status, e.code, **({"message": e.message} if e.message else {}))


@app.exception_handler(OFAPIError)
async def _of_error(_req: Request, e: OFAPIError) -> JSONResponse:
    status = getattr(e.response, "status_code", None) or 502
    return _error(status, "of_error", status=status)


@app.exception_handler(curl_errors.RequestException)
async def _of_transport(_req: Request, e: Exception) -> JSONResponse:
    """curl_cffi transport failures: timeout 504, anything else (proxy, DNS, TLS) 502."""
    if isinstance(e, curl_errors.Timeout):
        return _error(504, "of_timeout")
    return _error(502, "proxy_error" if isinstance(e, curl_errors.ProxyError) else "of_unreachable")


@app.middleware("http")
async def bearer_auth(request: Request, call_next):
    if request.url.path != "/healthz":
        given = request.headers.get("authorization", "").encode()
        if not hmac.compare_digest(given, _BEARER):
            return _error(401, "unauthorized")
    return await call_next(request)


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict:
    return {"ok": True}


# ─── /of/* ────────────────────────────────────────────────────────

_ACCOUNT_ID = re.compile(r"[0-9]{1,19}")


def account_client(
    x_of_proxy_account_id: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> OFClient:
    """The pooled OFClient for `x-of-proxy-account-id`. Tests override this."""
    raw = (x_of_proxy_account_id or "").strip()
    if not _ACCOUNT_ID.fullmatch(raw):
        raise ApiError(400, "invalid_account_id", "x-of-proxy-account-id must be an integer")
    aid = str(int(raw))
    if not accounts.is_account(aid):
        raise ApiError(404, "unknown_account")
    blocked = supervisor.blocker(aid)
    if blocked == "no_session":
        raise ApiError(409, "no_session")
    if blocked == "no_proxy":
        raise ApiError(409, "proxy_required")
    # session_expired is not blocked here: OF's own 401 passes through as of_error.
    try:
        client = client_pool.get(aid)
    except FileNotFoundError as e:
        raise ApiError(409, "no_session") from e
    if supervisor.require_proxy and not getattr(client, "proxy_url", None):
        raise ApiError(409, "proxy_required")  # never fall back to this host's IP
    return client


Client = Annotated[OFClient, Depends(account_client)]
of = APIRouter(prefix="/of", tags=["of-api"])


@of.get("/users/me", operation_id="users.me")
def users_me(client: Client) -> Any:
    return client.me()


@of.get("/chats", operation_id="chats.list")
def chats_list(client: Client, limit: int = 10, offset: int = 0, order: str = "recent") -> Any:
    return client.list_chats(limit=limit, offset=offset, order=order)


@of.get("/chats/{chatId}/messages", operation_id="chats.messages.list")
def chats_messages_list(
    client: Client,
    chat_id: Annotated[int, Path(alias="chatId")],
    limit: int = 10,
    order: str = "desc",
    id: int = 0,  # OF's own name: messages older than this id; 0 = newest
) -> Any:
    return client.get_messages(chat_id, limit=limit, order=order, before_id=id or None)


class SendMessage(BaseModel):
    text: str
    price: float = 0
    mediaFiles: list[int] = []  # OF's wire names
    previews: list[int] = []
    lockedText: bool = False


@of.post("/chats/{chatId}/messages", operation_id="chats.messages.send")
def chats_messages_send(
    client: Client, chat_id: Annotated[int, Path(alias="chatId")], body: SendMessage,
) -> Any:
    return client.send_message(
        chat_id, body.text, price=body.price, media_files=body.mediaFiles,
        previews=body.previews, locked_text=body.lockedText)


@of.get("/posts", operation_id="posts.list")
def posts_list(client: Client, limit: int = 10, offset: int = 0) -> Any:
    return client.list_posts(limit=limit, offset=offset)


@of.get("/posts/{postId}", operation_id="posts.get")
def posts_get(client: Client, post_id: Annotated[int, Path(alias="postId")]) -> Any:
    return client.get_post(post_id)


@of.get("/vault/media", operation_id="vault.media.list")
def vault_media_list(client: Client, limit: int = 24, offset: int = 0) -> Any:
    return client.vault_media(limit=limit, offset=offset)


@of.get("/vault/media/{mediaId}", operation_id="vault.media.get")
def vault_media_get(client: Client, media_id: Annotated[int, Path(alias="mediaId")]) -> Any:
    return client.vault_media_by_id(media_id)


app.include_router(of)


# ─── Accounts and bootstrap (operator surface, never forwarded) ──────


@app.get("/of-accounts", tags=["of-accounts"], operation_id="ofAccounts.list")
def of_accounts() -> list[dict]:
    """Connected OF accounts. `status`:
    `active` — a frame has been received since the pump started (not proof of live connectivity);
    `connecting` — runnable, pump starting or no frame yet;
    `session_expired` — OF answered 401 (or a JSON 403); waits for a new session;
    `no_session` — no captured session; `no_proxy` — no proxy while OF_REQUIRE_PROXY is on.
    """
    rows = []
    for meta in accounts.list_accounts():
        aid = str(meta.get("id") or "")
        if not aid.isdigit():
            continue
        rows.append({
            "id": int(aid),
            "label": meta.get("nickname"),
            "ofUsername": meta.get("username"),
            "ofDisplayName": meta.get("name"),
            "ofAvatarUrl": meta.get("avatar"),
            "status": supervisor.status(aid),
        })
    return rows


class Bootstrap(BaseModel):
    curl: str
    nickname: str | None = None
    static_param: str | None = None
    proxy_url: str | None = None


def _proxy_entry(url: str) -> dict:
    u = urlsplit(url.strip())
    try:
        port = u.port
    except ValueError:
        port = None
    if u.scheme not in {"http", "https", "socks5", "socks5h"} or not u.hostname or not port:
        raise ApiError(400, "invalid_proxy_url", "expected scheme://[user:pass@]host:port")
    # "" rather than None, so upsert clears credentials a previous URL had.
    return {"scheme": u.scheme, "host": u.hostname, "port": port,
            "username": u.username or "", "password": u.password or ""}


def _snapshot_latest(uid: str) -> tuple[bytes, int, int] | None:
    """latest.json's bytes and (atime, mtime) in ns, or None when there is none."""
    latest = accounts.account_dir(uid) / "latest.json"
    try:
        st = latest.stat()
        return latest.read_bytes(), st.st_atime_ns, st.st_mtime_ns
    except FileNotFoundError:
        return None


def _restore_latest(uid: str, snapshot: tuple[bytes, int, int] | None, failed: PathType) -> None:
    """Put latest.json back byte- and mtime-exact, so the pump key (and an expired
    session's mark) is unchanged; delete the failed session file and its cookies."""
    latest = accounts.account_dir(uid) / "latest.json"
    if snapshot is None:
        latest.unlink(missing_ok=True)
    else:
        data, atime_ns, mtime_ns = snapshot
        latest.write_bytes(data)
        os.utime(latest, ns=(atime_ns, mtime_ns))
    if accounts.latest_session_path(uid) != failed:
        failed.unlink(missing_ok=True)


def _bootstrap(body: Bootstrap) -> dict:
    """Parse, check the proxy, capture, validate with me() through that proxy, and
    only then commit the proxy binding; a failed validation restores the old session."""
    try:
        parsed = session_bootstrap.parse_curl(body.curl)
    except ValueError as e:
        raise ApiError(400, "invalid_curl", str(e)) from e
    uid = str(parsed["headers"].get("user-id") or "")
    if not uid.isdigit():
        raise ApiError(400, "invalid_curl", "the curl has no numeric user-id header")
    if not parsed["cookies"]:
        raise ApiError(400, "invalid_curl", "the curl has no -b cookies; use DevTools "
                       "'Copy as cURL (bash)' (a -H 'cookie: ...' header is not supported)")

    new_entry = _proxy_entry(body.proxy_url) if body.proxy_url else None
    entry = new_entry or proxies.get_for_account(uid)
    if entry is None and supervisor.require_proxy:
        raise ApiError(409, "proxy_required", "pass proxy_url: OF_REQUIRE_PROXY is on")
    proxy_url = proxies.proxy_url(entry) if entry else None

    snapshot = _snapshot_latest(uid)
    try:
        path = session_bootstrap.from_curl(
            body.curl, static_param_override=body.static_param or None,
            nickname=body.nickname, proxy_url=proxy_url)
    except (ValueError, RuntimeError) as e:
        raise ApiError(400, "bootstrap_failed", str(e)) from e

    try:
        probe = OFClient.from_session_file(
            path, proxies=proxies.proxies_dict_for_requests(entry) if entry else None,
            proxy_label=entry.get("label") if entry else None)
        me = probe.me()
    except Exception:
        log.warning("bootstrap: me() failed for account=%s; previous session restored", uid)
        _restore_latest(uid, snapshot, path)
        raise

    if new_entry is not None:
        label = f"acct-{uid}"
        proxies.upsert({"label": label, **new_entry})
        proxies.assign_account(label, uid)
    client_pool.evict(uid)
    meta = accounts.load_meta(uid) or {"id": uid}
    meta.update(username=me.get("username"), name=me.get("name"), avatar=me.get("avatar"))
    accounts.save_meta(uid, meta)
    return {"accountId": int(uid), "username": me.get("username")}


@app.post("/session/bootstrap", tags=["operator"], operation_id="session.bootstrap")
async def session_bootstrap_route(body: Bootstrap) -> dict:
    result = await run_in_threadpool(_bootstrap, body)
    await supervisor.reconcile()
    return {**result, "status": supervisor.status(str(result["accountId"]))}


# ─── /ws ──────────────────────────────────────────────────────────


@app.websocket("/ws")
async def ws_events(ws: WebSocket) -> None:
    offered = ws.scope.get("subprotocols") or []
    authed = any(hmac.compare_digest(p.encode(), _WS_PROTOCOL) for p in offered)
    if not authed or "bearer" not in offered:
        await ws.close(code=1008)
        return
    await ws.accept(subprotocol="bearer")
    await hub.serve(ws)

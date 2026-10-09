"""Upstream service: OF REST under `/of/*`, account rows, session bootstrap and
the `/ws` event stream for the gateway (plan-v4 §2.1, §2.2).

Run exactly one worker: the pumps and the hub live in this process.
    UPSTREAM_TOKEN=... uvicorn app:app --port 8000 --workers 1 --ws websockets-sansio
"""
from __future__ import annotations

import asyncio
import functools
import hmac
import logging
import os
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from curl_cffi.requests import exceptions as curl_errors
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from starlette.concurrency import run_in_threadpool

import accounts
import client_pool
import config
import events
import mass_poller
import proxies
import proxy_stats
import sent_poller
import session_bootstrap
from deps import (  # noqa: F401  (tests override account_client)
    ApiError,
    account_client,
    note_of_response,
)
from of_client import OFAPIError, OFClient
from pump import Hub, Supervisor
from routes import ROUTERS

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


def _poll_interval(name: str) -> float:
    """A poller's interval variable `name`: 120 when unset, 0 (off) or 10 to 86400 seconds, else SystemExit."""
    raw = os.environ.get(name)
    error = SystemExit(f"{name} must be 0 (off) or 10 to 86400 seconds, got {raw!r}")
    try:
        seconds = float(raw or 120)
    except ValueError:
        raise error from None
    if not (seconds == 0 or 10 <= seconds <= 86400):  # nan and inf fail both
        raise error
    return seconds


pollers = {name: functools.partial(poller, interval=seconds) for name, poller, seconds in (
    ("sent", sent_poller.SentPoller, _poll_interval("SENT_POLL_INTERVAL_S")),
    ("mass", mass_poller.MassPoller, _poll_interval("MASS_POLL_INTERVAL_S"))) if seconds}
hub = Hub()
# `supervisor.require_proxy` is the one OF_REQUIRE_PROXY switch; `supervisor.blocker()` the one gate.
supervisor = Supervisor(hub, require_proxy=(os.environ.get("OF_REQUIRE_PROXY") or "false").strip().lower()
                        not in {"0", "false", "no", "off"}, pollers=pollers)


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
    version="2.1.0",
    openapi_url="/docs/json",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)
app.state.supervisor = supervisor  # read by deps.account_client


# ─── Errors and auth ──────────────────────────────────────────────


def _error(http_status: int, code: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": {"code": code, **extra}}, status_code=http_status)


@app.exception_handler(ApiError)
async def _api_error(_req: Request, e: ApiError) -> JSONResponse:
    return _error(e.status, e.code, **({"message": e.message} if e.message else {}))


@app.exception_handler(OFAPIError)
async def _of_error(req: Request, e: OFAPIError) -> JSONResponse:
    note_of_response(req, e.response)
    status = getattr(e.response, "status_code", None) or 502
    return _error(status, "of_error", status=status)


@app.exception_handler(curl_errors.RequestException)
async def _of_transport(_req: Request, e: Exception) -> JSONResponse:
    """curl_cffi transport failures: timeout 504, anything else (proxy, DNS, TLS) 502."""
    if isinstance(e, curl_errors.Timeout):
        return _error(504, "of_timeout")
    log.warning("of_transport %s: %s", type(e).__name__, str(e)[:300])
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


# ─── /of/* (one module per group in routes/) ─────────────────────

for _router in ROUTERS:
    app.include_router(_router)


# ─── Accounts and bootstrap (operator surface, never forwarded) ──────


@app.get("/of-accounts", tags=["of-accounts"], operation_id="ofAccounts.list")
def of_accounts() -> list[dict]:
    """Connected OF accounts. `status`:
    `active` — a frame has been received since the pump started (not proof of live connectivity);
    `connecting` — runnable, pump starting or no frame yet;
    `session_expired` — OF answered 401 to any call, 400 "Wrong user" (code 301), or a JSON 403
    to /users/me; waits for a new session (re-connect);
    `no_session` — no captured session; `no_proxy` — no proxy while OF_REQUIRE_PROXY is on.
    """
    return [_account_row(meta) for meta in accounts.list_accounts() if str(meta.get("id") or "").isdigit()]


def _account_row(meta: dict) -> dict:
    aid = str(meta["id"])
    proxy = proxies.get_for_account(aid)
    return {
        "id": int(aid),
        "label": meta.get("nickname"),
        "ofUsername": meta.get("username"),
        "ofDisplayName": meta.get("name"),
        "ofAvatarUrl": meta.get("avatar"),
        "status": supervisor.status(aid),
        "proxyLabel": proxy.get("label") if proxy else None,
    }


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


def _bind_own_proxy(uid: str, entry: dict) -> None:
    """Store `entry` (from `_proxy_entry`) as the account's own `acct-<uid>` proxy and move the account onto it."""
    label = f"acct-{uid}"
    proxies.upsert({"label": label, **entry})
    proxies.assign_account(label, uid)


# from_curl rewrites these in place; everything else it writes is a new file.
_REWRITTEN = ("latest.json", "meta.json")


def _snapshot_account(uid: str) -> tuple[set[str], dict[str, tuple[bytes, int, int]]] | None:
    """The account dir's file names, plus latest.json's and meta.json's bytes and
    (atime, mtime) in ns; None when the account has no dir yet."""
    adir = accounts.account_dir(uid)
    try:
        names = {p.name for p in adir.iterdir()}
    except FileNotFoundError:
        return None
    kept = {}
    for name in _REWRITTEN:
        if name in names:
            st = (adir / name).stat()
            kept[name] = (adir / name).read_bytes(), st.st_atime_ns, st.st_mtime_ns
    return names, kept


def _rollback_account(uid: str, snapshot: tuple[set[str], dict[str, tuple[bytes, int, int]]] | None) -> None:
    """Undo a failed bootstrap: a new account is deleted outright; otherwise delete every
    file it created (session, chunk) and put latest.json and meta.json back byte- and
    mtime-exact, so the pump key (and an expired session's mark) and the nickname are
    unchanged."""
    if snapshot is None:
        accounts.delete_account(uid)
        return
    adir = accounts.account_dir(uid)
    names, kept = snapshot
    for p in adir.iterdir():
        if p.name not in names:
            p.unlink(missing_ok=True)
    for name, (data, atime_ns, mtime_ns) in kept.items():
        (adir / name).write_bytes(data)
        os.utime(adir / name, ns=(atime_ns, mtime_ns))


def _bootstrap(body: Bootstrap) -> tuple[dict, dict]:
    """Parse, check the proxy, capture, validate with me() through that proxy, and
    only then commit the proxy binding; a failed validation restores the old session.
    Returns the response body and the `accounts.connected` / `accounts.reconnected` frame:
    `reconnected` when the account already had a session."""
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

    snapshot = _snapshot_account(uid)
    had_session = accounts.latest_session_path(uid) is not None
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
        _rollback_account(uid, snapshot)
        raise

    if new_entry is not None:
        _bind_own_proxy(uid, new_entry)
    client_pool.evict(uid)
    meta = accounts.load_meta(uid) or {"id": uid}
    meta.update(username=me.get("username"), name=me.get("name"), avatar=me.get("avatar"))
    accounts.save_meta(uid, meta)
    key = supervisor.key(uid)
    assert key is not None, "from_curl wrote no session"
    frame = events.account_event("accounts.reconnected" if had_session else "accounts.connected", int(uid),
                                 key[0], "authenticated", events.iso(datetime.now(UTC)))
    return {"accountId": int(uid), "username": me.get("username")}, frame


@app.post("/session/bootstrap", tags=["operator"], operation_id="session.bootstrap")
async def session_bootstrap_route(body: Bootstrap) -> dict:
    result, frame = await run_in_threadpool(_bootstrap, body)
    supervisor.hub.publish(frame)
    await supervisor.reconcile()
    return {**result, "status": supervisor.status(str(result["accountId"]))}


class ProxyRef(BaseModel):
    """Exactly one of: `label`, an existing proxy; `url`, a new one stored as `acct-<id>`."""
    label: str | None = None
    url: str | None = None

    @model_validator(mode="after")
    def _one_of(self) -> ProxyRef:
        if (self.label is None) == (self.url is None):
            raise ValueError("pass exactly one of label, url")
        return self


class AccountPatch(BaseModel):
    nickname: str | None = Field(default=None, min_length=1, max_length=100)
    proxy: ProxyRef | None = None  # null unbinds; absent leaves the binding as is


def _update_account(uid: str, body: AccountPatch) -> bool:
    """Apply `body`; True when the proxy binding changed."""
    if not uid.isdigit() or not accounts.is_account(uid):
        raise ApiError(404, "account_not_found")
    if body.nickname is not None:
        # load/save rather than upsert_account: upsert rebuilds meta and drops username/name/avatar.
        meta = accounts.load_meta(uid) or {"id": uid}
        meta["nickname"] = body.nickname.strip() or meta.get("nickname")
        accounts.save_meta(uid, meta)
    if "proxy" not in body.model_fields_set:
        return False
    ref = body.proxy
    if ref is None:
        current = proxies.get_for_account(uid)
        if current is not None:
            proxies.unbind_account(current["label"], uid)
    elif ref.url is not None:
        _bind_own_proxy(uid, _proxy_entry(ref.url))
    else:
        try:
            proxies.assign_account(ref.label, uid)
        except KeyError:
            raise ApiError(404, "proxy_not_found") from None
    client_pool.evict(uid)
    return True


@app.patch("/of-accounts/{account_id}", tags=["of-accounts"], operation_id="ofAccounts.update")
async def of_account_update(account_id: str, body: AccountPatch) -> dict:
    """Rename an account and/or change its proxy: `proxy` {label} or {url}, or null to unbind."""
    if await run_in_threadpool(_update_account, account_id, body):
        await supervisor.reconcile()
    return _account_row(accounts.load_meta(account_id) or {"id": account_id})


# ─── Proxies (operator surface; never returns a password) ─────────


def _proxy_view(p: dict) -> dict:
    return {
        "label": p["label"],
        "scheme": p.get("scheme") or "http",
        "host": p.get("host"),
        "port": p.get("port"),
        "username": p.get("username") or None,
        "assigned_account_ids": proxies._ids_on(p),
        "verified_ip": p.get("verified_ip"),
        "verified_at": p.get("verified_at"),
        "verified_geo": p.get("verified_geo"),
        "stats": proxy_stats.get(p["label"]),
        "since": proxy_stats.SINCE,
    }


@app.get("/proxies", tags=["operator"], operation_id="proxies.list")
def proxies_list() -> list[dict]:
    """Registered proxies with their bound accounts, last probe and traffic counters
    (`stats` are in-process and reset on restart: counted since `since`)."""
    return [_proxy_view(p) for p in proxies.list_proxies() if p.get("label")]


@app.post("/proxies/{label}/probe", tags=["operator"], operation_id="proxies.probe")
async def proxies_probe(label: str) -> dict:
    """Fetch the proxy's egress IP and geo, store the result, and return the entry; 502 when the proxy fails."""
    p = proxies.get_by_label(label)
    if p is None:
        raise ApiError(404, "proxy_not_found")
    result = await run_in_threadpool(proxies.probe, p)
    proxies.record_verification(label, ip=result["ip"], geo=result["geo"], ok=result["ok"])
    if not result["ok"]:
        message = str(result.get("error") or "probe failed")
        if p.get("password"):
            message = message.replace(p["password"], "***")
        raise ApiError(502, "proxy_error", message[:300])
    return _proxy_view(proxies.get_by_label(label) or p)


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

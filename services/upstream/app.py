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
import re
from contextlib import asynccontextmanager, suppress
from typing import Annotated, Any
from urllib.parse import urlsplit

from curl_cffi.requests import exceptions as curl_errors
from fastapi import FastAPI, Header, Request, WebSocket
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from starlette.concurrency import run_in_threadpool

import accounts
import browser_login
import client_pool
import config
import mass_poller
import proxies
import proxy_stats
import sent_poller
import session_bootstrap
import session_commit
from deps import (  # noqa: F401  (tests override account_client)
    ApiError,
    account_client,
    note_of_response,
)
from of_client import OFAPIError
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
    # An inline proxy line in any of the bulk-paste formats (scheme://user:pass@host:port,
    # user:pass@host:port, host:port:user:pass, host:port@user:pass, host:port) with an optional
    # trailing label. Registered then bound before the OFClient is created, like proxy_url.
    proxy: str | None = None


# `_bind_own_proxy` moved to session_commit; kept as a module alias so `_update_account` and the
# existing tests keep working unchanged.
_bind_own_proxy = session_commit.bind_own_proxy


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


def _resolve_connect_proxy(uid: str, body: Bootstrap) -> tuple[dict | None, dict | None, str | None]:
    """The proxy to mint through for a connect: `(entry, new_entry, bind_label)`.

    `proxy_url` (a URL) and an inline `proxy` line with no trailing label both bind as the account's
    own `acct-<uid>` (`new_entry`). An inline `proxy` line *with* a label registers that named proxy
    now and binds the account to it after the session validates (`bind_label`) — "bind as if a label
    had been passed". With neither, the account's already-assigned proxy is reused."""
    if body.proxy_url:
        entry = _proxy_entry(body.proxy_url)
        return entry, entry, None
    if body.proxy:
        try:
            parsed, label = proxies.parse_line(body.proxy)
        except proxies.ProxyLineError as e:
            raise ApiError(400, "invalid_proxy_url", str(e)) from e
        if label and label != f"{parsed['host']}:{parsed['port']}" and not re.fullmatch(r"acct-\d+", label):
            stored = proxies.upsert({"label": label, **parsed})
            return stored, None, label
        return parsed, parsed, None
    reused = proxies.get_for_account(uid)
    return reused, None, None


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

    entry, new_entry, bind_label = _resolve_connect_proxy(uid, body)
    if entry is None and supervisor.require_proxy:
        raise ApiError(409, "proxy_required", "pass proxy_url: OF_REQUIRE_PROXY is on")
    proxy_url = proxies.proxy_url(entry) if entry else None

    snapshot = session_commit.snapshot_account(uid)
    had_session = accounts.latest_session_path(uid) is not None
    try:
        path = session_bootstrap.from_curl(
            body.curl, static_param_override=body.static_param or None,
            nickname=body.nickname, proxy_url=proxy_url)
    except (ValueError, RuntimeError) as e:
        raise ApiError(400, "bootstrap_failed", str(e)) from e

    result, frame = session_commit.commit_captured_session(
        uid, session_path=path, entry=entry, new_entry=new_entry,
        snapshot=snapshot, had_session=had_session, supervisor=supervisor)
    if bind_label is not None:
        proxies.assign_account(bind_label, uid)
        client_pool.evict(uid)
    return result, frame


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
    """Apply `body`; True when the proxy binding changed. Everything is checked before anything is written,
    so a bad proxy leaves the nickname unchanged too."""
    if not uid.isdigit() or not accounts.is_account(uid):
        raise ApiError(404, "account_not_found")
    ref = body.proxy
    set_proxy = "proxy" in body.model_fields_set
    new_entry = _proxy_entry(ref.url) if set_proxy and ref is not None and ref.url is not None else None
    if set_proxy and ref is not None and ref.label is not None and proxies.get_by_label(ref.label) is None:
        raise ApiError(404, "proxy_not_found")

    if body.nickname is not None:
        # load/save rather than upsert_account: upsert rebuilds meta and drops username/name/avatar.
        meta = accounts.load_meta(uid) or {"id": uid}
        meta["nickname"] = body.nickname.strip() or meta.get("nickname")
        accounts.save_meta(uid, meta)
    if not set_proxy:
        return False
    if ref is None:
        current = proxies.get_for_account(uid)
        if current is not None:
            proxies.unbind_account(current["label"], uid)
    elif new_entry is not None:
        _bind_own_proxy(uid, new_entry)
    else:
        try:
            proxies.assign_account(ref.label, uid)
        except KeyError:  # removed since the check above
            raise ApiError(404, "proxy_not_found") from None
    client_pool.evict(uid)
    return True


@app.patch("/of-accounts/{account_id}", tags=["of-accounts"], operation_id="ofAccounts.update")
async def of_account_update(account_id: str, body: AccountPatch) -> dict:
    """Rename an account and/or change its proxy: `proxy` {label} or {url}, or null to unbind."""
    if await run_in_threadpool(_update_account, account_id, body):
        await supervisor.reconcile()
    return _account_row(accounts.load_meta(account_id) or {"id": account_id})


@app.delete("/of-accounts/{account_id}", tags=["of-accounts"], operation_id="ofAccounts.delete", status_code=204)
async def of_account_delete(account_id: str) -> None:
    """Disconnect an account: delete its session and meta, then stop its pump and pollers. Its proxy binding is
    kept, so a re-connect of the same account goes out through the same egress."""
    if not account_id.isdigit() or not await run_in_threadpool(accounts.delete_account, account_id):
        raise ApiError(404, "account_not_found")
    client_pool.evict(account_id)
    await supervisor.reconcile()


# ─── Proxies (operator surface; never returns a password) ─────────


def _proxy_view(p: dict) -> dict:
    return {
        "label": p["label"],
        "scheme": p.get("scheme") or "http",
        "host": p.get("host"),
        "port": p.get("port"),
        "assigned_account_ids": proxies._ids_on(p),
        "verified_ip": p.get("verified_ip"),
        "verified_at": p.get("verified_at"),
        "verified_geo": p.get("verified_geo"),
        "verified_of_reachable": p.get("verified_of_reachable"),
        "verified_of_error": p.get("verified_of_error"),
        "stats": proxy_stats.get(p["label"]),
        "since": proxy_stats.SINCE,
    }


@app.get("/proxies", tags=["operator"], operation_id="proxies.list")
def proxies_list() -> list[dict]:
    """Registered proxies with their bound accounts, last probe and traffic counters
    (`stats` are in-process and reset on restart: counted since `since`)."""
    return [_proxy_view(p) for p in proxies.list_proxies() if p.get("label")]


class NewProxy(BaseModel):
    # One path segment (the probe route takes it), never `.`/`..`; `acct-<id>` names are per-account.
    label: str = Field(min_length=1, max_length=200, pattern=r"^[^/.][^/]*$")
    url: str


def _create_proxy(body: NewProxy) -> dict:
    if re.fullmatch(r"acct-\d+", body.label):
        raise ApiError(400, "invalid_label", "acct-<id> labels are reserved for per-account proxies")
    entry = _proxy_entry(body.url)
    if proxies.get_by_label(body.label) is not None:
        raise ApiError(409, "proxy_exists", f"a proxy named {body.label!r} already exists")
    return _proxy_view(proxies.upsert({"label": body.label, **entry}))


@app.post("/proxies", tags=["operator"], operation_id="proxies.create")
async def proxies_create(body: NewProxy) -> dict:
    """Register a proxy bound to no account (bind it with PATCH /of-accounts/{id}); 409 when the label is taken."""
    return await asyncio.to_thread(_create_proxy, body)


class BulkProxies(BaseModel):
    text: str = Field(max_length=200_000)
    scheme: str = "http"


def _bulk_proxies(body: BulkProxies) -> dict:
    """Register many pasted proxies, one per line. Blank lines and `#` comments are skipped. Each good
    line is upserted (unbound, bind it with PATCH /of-accounts/{id}); a `acct-<id>` label is reserved.
    Returns per-line results with 1-based line numbers; a failed line's echo is password-redacted."""
    scheme = body.scheme.strip().lower() or "http"
    if scheme not in proxies.SCHEMES:
        raise ApiError(400, "invalid_proxy_url", f"unsupported scheme {scheme!r}")
    added: list[dict] = []
    errors: list[dict] = []
    seen: set[str] = set()
    for n, raw in enumerate(body.text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            entry, label = proxies.parse_line(line, scheme_default=scheme)
        except proxies.ProxyLineError as e:
            errors.append({"line": n, "text_redacted": proxies.redact_line(line), "reason": str(e)})
            continue
        if re.fullmatch(r"acct-\d+", label or ""):
            errors.append({"line": n, "text_redacted": proxies.redact_line(line),
                           "reason": "acct-<id> labels are reserved for per-account proxies"})
            continue
        if label in seen:
            errors.append({"line": n, "text_redacted": proxies.redact_line(line),
                           "reason": f"duplicate label {label!r} in this paste"})
            continue
        seen.add(label)
        stored = proxies.upsert({"label": label, **entry})
        added.append({"label": stored["label"], "host": stored["host"], "port": stored["port"],
                      "scheme": stored.get("scheme") or "http", "username": stored.get("username") or None})
    return {"added": added, "errors": errors}


@app.post("/proxies/bulk", tags=["operator"], operation_id="proxies.bulk")
async def proxies_bulk(body: BulkProxies) -> dict:
    """Bulk-register pasted proxies, one per line; returns `{added, errors}` with 1-based line numbers."""
    return await asyncio.to_thread(_bulk_proxies, body)


def _probe(label: str) -> dict:
    """Probe and store the result (network and an fsync: run it in a thread)."""
    p = proxies.get_by_label(label)
    if p is None:
        raise ApiError(404, "proxy_not_found")
    result = proxies.probe(p)
    proxies.record_verification(label, ip=result["ip"], geo=result["geo"], ok=result["ok"],
                                of_reachable=result["of_reachable"], of_error=result["of_error"])
    if not result["ok"]:
        raise ApiError(502, "proxy_error", proxies._redact(str(result.get("error") or "probe failed"), p)[:300])
    return _proxy_view(proxies.get_by_label(label) or p)


@app.post("/proxies/{label}/probe", tags=["operator"], operation_id="proxies.probe")
async def proxies_probe(label: str) -> dict:
    """Fetch the proxy's egress IP (through it, as OF traffic goes) and geo, and check that it tunnels to
    onlyfans.com (`verified_of_reachable`); store the result and return the entry. 502 when no IP comes back."""
    return await asyncio.to_thread(_probe, label)


# ─── Remote-browser login (plan direct-login §C) ─────────────────────
#
# A real browser logs the creator in through its proxy; a human solves any Cloudflare/Turnstile/
# captcha challenge or enters 2FA over the screencast + input channel. On success the captured
# cookies + signed request flow through the SAME pipeline a pasted cURL uses. Never logs the
# password or cookies; the challenge is surfaced, never solved here.


def _browser_driver() -> browser_login.LoginDriver:
    # Lazy: only the remote-browser login needs Playwright + Chromium; keep them off the import path.
    from browser_login_playwright import PlaywrightDriver
    return PlaywrightDriver()


def _finish_browser_login(captured: browser_login.CapturedLogin, proxy_url: str | None) -> tuple[dict, dict]:
    """Turn a captured browser login into a committed session via the shared capture pipeline — the
    same derivation + record shape + post-capture tail as a pasted cURL. Binds the account to the
    proxy the browser used, so cookies minted through it are used through it."""
    curl = browser_login.build_login_curl(captured)
    try:
        parsed = session_bootstrap.parse_curl(curl)
    except ValueError as e:
        raise ApiError(400, "capture_failed", str(e)) from e
    uid = str(parsed["headers"].get("user-id") or "")
    if not uid.isdigit():
        raise ApiError(400, "capture_failed", "the captured request has no numeric user-id")
    entry = _proxy_entry(proxy_url) if proxy_url else None
    snapshot = session_commit.snapshot_account(uid)
    had_session = accounts.latest_session_path(uid) is not None
    try:
        path = session_bootstrap.from_curl(
            curl, static_param_override=captured.static_param or None, proxy_url=proxy_url)
    except (ValueError, RuntimeError) as e:
        raise ApiError(400, "capture_failed", str(e)) from e
    return session_commit.commit_captured_session(
        uid, session_path=path, entry=entry, new_entry=entry,
        snapshot=snapshot, had_session=had_session, supervisor=supervisor)


async def _finalize_browser_login(captured: browser_login.CapturedLogin, proxy_url: str | None) -> dict:
    result, frame = await run_in_threadpool(_finish_browser_login, captured, proxy_url)
    supervisor.hub.publish(frame)
    await supervisor.reconcile()
    return result


login_manager = browser_login.LoginManager(_browser_driver, _finalize_browser_login)


class BrowserLoginStart(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024)
    # A proxy line in any bulk-paste format; required when OF_REQUIRE_PROXY is on.
    proxy: str | None = None


class BrowserLoginInput(BaseModel):
    type: str = Field(pattern=r"^(click|text|otp|cancel)$")
    x: int | None = None
    y: int | None = None
    text: str | None = None
    code: str | None = None


def _principal(x_login_principal: str | None) -> str:
    principal = (x_login_principal or "").strip()
    if not principal:
        raise ApiError(400, "missing_principal", "x-login-principal header is required")
    return principal


@app.post("/login/browser/start", tags=["operator"], operation_id="login.browser.start")
async def browser_login_start(
    body: BrowserLoginStart,
    x_login_principal: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> dict:
    """Start a remote-browser login. Returns the job id and the per-job SSE stream token."""
    principal = _principal(x_login_principal)
    proxy_url: str | None = None
    if body.proxy and body.proxy.strip():
        try:
            entry, _label = proxies.parse_line(body.proxy)
        except proxies.ProxyLineError as e:
            raise ApiError(400, "invalid_proxy_url", str(e)) from e
        proxy_url = proxies.proxy_url(entry)
    elif supervisor.require_proxy:
        raise ApiError(409, "proxy_required", "pass proxy: OF_REQUIRE_PROXY is on")
    job = login_manager.start(principal=principal, email=body.email, password=body.password,
                              proxy_url=proxy_url)
    return {"jobId": job.id, "streamToken": job.stream_token, **job.snapshot()}


@app.get("/login/browser/{job_id}", tags=["operator"], operation_id="login.browser.status")
async def browser_login_status(
    job_id: str, x_login_principal: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> dict:
    try:
        return login_manager.get(job_id, _principal(x_login_principal)).snapshot()
    except KeyError:
        raise ApiError(404, "job_not_found") from None


@app.post("/login/browser/{job_id}/input", tags=["operator"], operation_id="login.browser.input")
async def browser_login_input(
    job_id: str, body: BrowserLoginInput,
    x_login_principal: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> dict:
    try:
        job = login_manager.get(job_id, _principal(x_login_principal))
    except KeyError:
        raise ApiError(404, "job_not_found") from None
    try:
        job.submit_input(body.model_dump(exclude_none=True))
    except ValueError as e:
        raise ApiError(409, "job_not_live", str(e)) from e
    return job.snapshot()


@app.post("/login/browser/{job_id}/cancel", tags=["operator"], operation_id="login.browser.cancel")
async def browser_login_cancel(
    job_id: str, x_login_principal: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> dict:
    try:
        job = login_manager.get(job_id, _principal(x_login_principal))
    except KeyError:
        raise ApiError(404, "job_not_found") from None
    if not job.terminal:
        job.submit_input({"type": "cancel"})
    return job.snapshot()


async def _event_stream(job: browser_login.LoginJob):
    import base64
    import json

    def render() -> str:
        snap = job.snapshot()
        frame = None
        if job.frame is not None:
            png, w, h = job.frame
            frame = {"w": w, "h": h, "png": base64.b64encode(png).decode()}
        return f"data: {json.dumps({**snap, 'frame': frame})}\n\n"

    version = job.version
    yield render()
    while not job.terminal:
        version = await job.wait_update(version)
        yield render()
    yield render()


@app.get("/login/browser/{job_id}/stream", tags=["operator"], operation_id="login.browser.stream")
async def browser_login_stream(job_id: str, token: str = "") -> StreamingResponse:
    """SSE screencast + state. EventSource cannot set headers, so it authenticates with the per-job
    stream token in the query string."""
    try:
        job = login_manager.get_for_stream(job_id, token)
    except KeyError:
        raise ApiError(404, "job_not_found") from None
    return StreamingResponse(_event_stream(job), media_type="text/event-stream",
                             headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


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

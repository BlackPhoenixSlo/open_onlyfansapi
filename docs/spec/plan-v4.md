# Plan v4: our own upstream — REST, client WebSocket, stats groundwork

Build plan after plan-v3 (webhook engine shipped, ee84743), for Opus implementer agents in parallel git worktrees.
Goal: (A) the OF v2 REST surface served by **our own upstream** (`services/upstream/`), (B) a **client WebSocket** on
the gateway authed by the same `gk_` key, (C) an **event ledger + `/v1/stats`** as groundwork for a per-workspace stats
page. Principle: **YAGNI** — cuts and reasons in §8.

**Overrides** plan-v3 §2.5 (no new deps), plan-v3 P1b's file layout and `event-map.json`, handoff-of-serving.md
Phase 1 (an upstream socket per client; revoke "on the next frame"), the handoff's `/of/v2/*` paths, and FUTURE.md's
"separate service, not in this repo". Where this plan is silent, plan-v3 and the handoff still apply.

## 0. Baseline (2026-10-02)

- Gateway: P1a webhooks shipped — `modules/webhooks/{routes,service,worker}.ts`, `emit(teamId,type,accountId,data)`,
  `lib/signature.ts` `envelope()`, catalogue `message.received | account.session_expired | webhook.test | upstream.*`.
  No event source, no client socket, no `ws` dependency. Migrations `0000`–`0003`.
- `services/upstream/`: 18 lifted modules, ~10.5k lines, **untracked**; no `app.py`, requirements or Dockerfile.
  Breakage: `session_bootstrap.py:82,84,147,164` import `capture_session` / `extract_rules` / `capture_session_proxy`
  (not lifted); `of_client.py:698` calls undefined `_t.sleep`; `db/engine.py` needs `python-dotenv`, `db/repo.py`
  imports a missing `.import_legacy`. Deploy-specific: a real proxy host in the `proxies.py` docstring, a hardcoded
  `Accept-Language: sl-SI` in `of_ws.py`, every state path (`sessions/`, `proxies.json`) derived from the source dir.
- Repo is **PRIVATE** (`gh repo view`). `scripts/prepublish-check.sh` has an uncommitted hunk (2b) that fails once
  `services/` is tracked.

**Never commit the verbatim lift.** The first commit containing `services/` is P0a's scrubbed tree, so the proxy host
never enters history.

## 1. Decisions

1. **One repo** (owner, 2026-10-02): `services/upstream/` is tracked. Prepublish 2b stays as the guard for a future
   public publish, reworded (P0a).
2. **`@fastify/websocket`** (v11 for Fastify 5; brings `ws`) serves the client socket — overrides plan-v3 §2.5. No
   other new gateway dependency; the upstream consumer keeps Node's global `WebSocket`.
3. **One upstream socket, in-process fan-out.** The plan-v3 P1b singleton (`RUN_JOBS` + `UPSTREAM_WS_URL`) feeds the
   event ledger, webhooks (`emit` per linked workspace) and client sockets (in-process bus). One gateway process.
4. **The upstream normalises.** OF frame → catalogue type happens in `services/upstream/events.py`, the only code that
   knows OF shapes. The gateway accepts `type` verbatim if it is in the catalogue or starts with `upstream.`.
5. **Event ledger is gateway-side Postgres** (`event`, Drizzle), written by the P1 consumer. No payload, no team id:
   a metrics ledger, not an archive. The upstream's `db/` package is deleted.
6. **Paths drop OF's `v2`:** upstream `/of/<tail>` mirrors OF `/api2/v2/<tail>`; clients call `/v1/{account}/chats`,
   matching README and the fake upstream (Q7).
7. **One socket auth scheme, both hops.** The client offers `bearer` **and** `bearer.<secret>`; the server selects
   `bearer`. RFC 6455 only lets a server select a protocol the client offered — offering `bearer` is what lets the
   response omit the secret.
8. **Revocation by a 15 s sweep**, not a broadcast: revokes, allowlist edits and `link-team` can happen in another
   process (CLI); one sweep covers all of them, idle sockets included.
9. **Paused webhook endpoints keep dropping new events** (plan-v3 follow-up resolved: paused means off; the ledger
   still counts them).

## 2. Contracts (every phase codes against these)

### 2.1 Upstream HTTP
Every route but `GET /healthz` requires `Authorization: Bearer $UPSTREAM_TOKEN`. `/of/*` requires
`x-of-proxy-account-id: <int>` → 400 missing, 404 `unknown_account`, 409 `no_session` / `proxy_required`.

| Route | `OFClient` | operationId |
|---|---|---|
| `GET /of/users/me` | `me` | `users.me` |
| `GET /of/chats?limit&offset&order` | `list_chats` | `chats.list` |
| `GET /of/chats/{chatId}/messages?limit&order&id` | `get_messages` | `chats.messages.list` |
| `POST /of/chats/{chatId}/messages` `{text, price?, mediaFiles?, previews?, lockedText?}` | `send_message` | `chats.messages.send` |
| `GET /of/posts?limit&offset` · `GET /of/posts/{postId}` | `list_posts` · `get_post` | `posts.list` · `posts.get` |
| `GET /of/vault/media?limit&offset` · `/of/vault/media/{mediaId}` | `vault_media` · `vault_media_by_id` | `vault.media.list` · `vault.media.get` |

All tagged `of-api`; spec at `GET /docs/json`. Declare query params as plain typed values with defaults (no
`Optional`) so FastAPI's OpenAPI 3.1 output has no `type: null` for the gateway merge and the playground.
`GET /of-accounts` → `[{id, label, ofUsername, ofDisplayName, ofAvatarUrl, status}]`,
`status ∈ active|connecting|session_expired|no_session|no_proxy`. OF errors keep OF's status
(`{"error":{"code":"of_error","status":N}}`); proxy failure → 502, timeout → 504. `POST /session/bootstrap` is
operator-only and not under `/of/`, so the gateway can never forward to it.

### 2.2 Upstream `/ws` frame (one JSON object per text frame)
```
{"id":"message.received:117183:5551234","type":"message.received","account_id":117183,
 "ts":"2026-10-02T12:00:00.000Z","payload":{...}}
{"type":"heartbeat","ts":"2026-10-02T12:00:30.000Z"}        # every 30 s; never forwarded
```
`id`: stable per (type, account, OF object) or `null`; becomes `event.dedup_key`. `account_id`: the OF user id, the
int `/of-accounts` lists. `ts`: ISO-8601 UTC, the event's time. Delivery is at-most-once; no replay.

### 2.3 Event taxonomy (`contracts.ts`; **TBC** = emitted only once Q1 supplies the OF frame)
| Type | OF source (`events.py`) | `data` | ledger `amount_cents` |
|---|---|---|---|
| `message.received` | `api2_chat_message`, `fromUser.id ≠ account` | `{messageId, fanId, text, price, mediaCount}` | — |
| `message.sent` | same, `fromUser.id = account` | same | — |
| `tip.received` | TBC | `{fanId, amountCents, messageId?, postId?}` | amount |
| `ppv.unlocked` | TBC | `{fanId, amountCents, messageId?, postId?}` | amount |
| `subscription.new` · `subscription.renewed` | TBC | `{fanId, amountCents?}` | amount |
| `subscription.expired` | TBC (may have no frame → stays unemitted) | `{fanId}` | — |
| `post.expired` | `post_expire` | `{postId}` | — |
| `account.session_expired` | pump: `/users/me` → 401/403 | `{}` | — |
| `upstream.<key>` | any other key, minus noise | raw value | not stored |
| `webhook.test` | gateway `/test` | unchanged | not stored |

The upstream drops noise: `connected`, `online_status`, counter-only frames (`chat_messages`, `count_priority_chat`,
`unread_tips`, …). Amounts are OF's gross figures in cents.

### 2.4 Bus (`apps/api/src/lib/event-bus.ts`)
```ts
export type GatewayEvent = { id: string; type: string; createdAt: Date; accountId: number | null; data: unknown };
export function publish(e: GatewayEvent): void;                    // sync; listener errors caught + logged
export function subscribe(fn: (e: GatewayEvent) => void): () => void;
```
`id` is `evt_…` (the ledger row id, or a fresh one for unstored `upstream.*`). Client frames are `envelope(e)` from
`lib/signature.ts` — the same shape as a webhook body.

### 2.5 Client socket `GET /v1/ws[?accountId=<id>]`
- Browser: `new WebSocket(url, ['bearer', 'bearer.' + key])` → `Sec-WebSocket-Protocol: bearer` (never the key).
  Server-side clients may send `Authorization: Bearer <key>` and no subprotocol. Dashboard sessions are refused.
- Refused before upgrade (normal error body; logged by `captureRequestLogs`): 401 `invalid_api_key`/`unauthorized`,
  400 `invalid_subprotocol` (`bearer.<key>` offered without `bearer`), 403 `account_not_allowed`,
  409 `team_not_linked`, 429 `rate_limited`/`too_many_sockets` (5 per key), 503 `realtime_unavailable`.
- Open: `{"type":"ready","accountIds":[…]|null}`, then envelopes for allowed accounts. Client messages are ignored
  (`maxPayload` 4 KiB). Close: 1001 shutdown · 1013 slow consumer (>1 MiB buffered) · 4401 key revoked or workspace
  unlinked · 4403 account no longer allowed.

### 2.6 `event` table
`id` text pk (`evt_…`), `account_id` int not null, `type` text not null, `amount_cents` int null, `dedup_key` text
null, `created_at` timestamptz(3) not null default now() — **the event's time** (frame `ts`). Indexes:
`event_created_idx (created_at)`; unique `event_dedup_idx (dedup_key) where dedup_key is not null`. Retention:
`EVENT_RETENTION_DAYS` via `deleteExpired('event', …)`. Stored: the catalogue minus `webhook.test` and `upstream.*`.

---

## Phase 0 — Upstream service (`services/upstream/`)

Python 3.12, flat modules, run from `services/upstream/`. Two agents in parallel: P0a edits the lifted modules, P0b
only adds files. **Lifted code is edited only to fix breakage, remove deploy-specific values, or delete dead code that
drags dependencies.**

### P0a — lift hygiene
**Owns.** Every existing file under `services/upstream/`; new `config.py`; root `.gitignore`
(+`services/upstream/data/`, `.claude/worktrees/`); root `.dockerignore` (+`services`, keeps upstream source out of
the gateway image); `scripts/prepublish-check.sh` (2b message: "services/ is tracked: private-only tree; filter it out
before any public publish").

- `config.py`: `STATE_DIR = Path(os.environ.get("UPSTREAM_STATE_DIR") or HERE / "data")`,
  `SESSIONS_DIR = STATE_DIR / "sessions"`, `PROXIES_PATH = STATE_DIR / "proxies.json"`. `accounts.py`,
  `session_bootstrap.py`, `proxies.py` take paths only from here. Dirs 0700; `proxies.json` 0600 (proxy passwords).
- **Delete** `db/`, `relay_cache.py`, `relay_coalesce.py`, `lane_config.py`, `atomic_json.py`, `jsonsafe.py`,
  `of_shapes.py` — unused by the slim app once the cuts below land.
- `of_client.py` (3.5k → ≈2k): `_t.sleep` → `time.sleep` (:698). Delete **by name** (lines drift): upload constants
  and helpers (`_PART_SIZE` … `CARRIER_DAYS`, `convert_rejected`, `post_is_gone`, `s3_etag_and_md5`), co-tagging
  (`_CoTagRetry`, `_write_tag_block`, `_apply_cotags`, `_post_dropping_auto_cotag`), vault upload
  (`vault_media_lookup_hash` … `upload_to_vault`), story upload (`create_story`, `post_story`,
  `post_story_from_url`), mass send (`schedule_mass_message`, `send_mass_message`), `send_tip`, the `lane_config`
  import. `send_message` drops `tagged_users`/`auto_tag` and posts with `post_json`. **Keep** every other single-call
  method (the menu for later handlers). `__init__` reads `headers.accept_language` into `self.accept_language`.
- `session_bootstrap.py`: delete `run_incogniton`, `run_playwright_proxy`, `_adopt_into_account` and the
  `incogniton-*` CLI modes (removes the dead imports). `from_curl` gains `proxy_url` and fetches `2313.js` through it
  with curl_cffi (today `urllib` fetches it direct from the VPS); stores the curl's `accept-language` in
  `headers.accept_language`; its missing-`static_param` error names the `static_param` field, not the unlifted extension.
- `proxies.py`: docstring host → `203.0.113.10`, neutral notes, `session_<ts>.json`.
- `of_ws.py`: `Accept-Language` from `client.accept_language`, fallback `en-US,en;q=0.9`. Add
  `class SessionExpired(Exception)`, raised from `events()` when `_refresh_auth` gets OFAPIError 401/403 (today it
  retries forever). Delete `send_typing`, `_LIVE_PUMPS`, `register_pump`, `unregister_pump`, `emit_typing`; keep `_tail`
  (fixture capture).

**Acceptance.**
```
cd services/upstream && ruff check --select F,E9 .          # no undefined names, no dead imports
python -c "import of_client, of_ws, session_bootstrap, client_pool, proxies, accounts"
! grep -rnE 'sl-SI|Chatterly|capture_session|extract_rules' .
! grep -rn '<the original proxy host from the pre-scrub proxies.py docstring>' .
```

### P0b — serve
**Owns.** New `app.py`, `pump.py`, `events.py`, `connect.py`, `requirements.txt`, `requirements-dev.txt` (pytest,
httpx, ruff), `Dockerfile`, `services/upstream/.dockerignore`, `tests/**`; root `docker-compose.yml` (dev profile
`upstream`: build, `127.0.0.1:3001:8000`, volume, `UPSTREAM_TOKEN` default `dev-upstream-token`);
`.github/workflows/ci.yml` (new `upstream` job: ruff, pytest, image build). Codes against P0a's `config.py` and
`SessionExpired` as specified above.

- `app.py`: `FastAPI(openapi_url="/docs/json", docs_url=None, redoc_url=None, lifespan=…)`; refuses to boot if
  `UPSTREAM_TOKEN` < 16 chars; HTTP middleware checks the bearer (`hmac.compare_digest`) on every path but `/healthz`.
  `/of/*` handlers are sync `def` (threadpool) behind one dependency `account_client(x_of_proxy_account_id)` →
  `client_pool.get(aid)`; tests override it.
- `POST /session/bootstrap {curl, nickname?, static_param?, proxy_url?}`: `from_curl` in the threadpool; with
  `proxy_url`, upsert proxy `acct-<uid>` and assign it; `client_pool.evict(uid)`; `me()` → store
  `username`/`name`/`avatar` in meta; `supervisor.reconcile()`; return `{accountId, username, status}`. Never returns
  cookies. `connect.py` (~25 lines) posts stdin to it on `127.0.0.1:$PORT`:
  `docker compose exec -T upstream python connect.py --nickname Main --proxy-url … < curl.txt`.
- `WS /ws`: bad or missing `bearer.<token>` → close 1008 before accept; else `accept(subprotocol="bearer")`, join hub.
- `pump.py` — **Supervisor**: reconciles every 30 s and on bootstrap; one task per account with a session (and a
  proxy while `OF_REQUIRE_PROXY=true`) running `OFWebSocket(client).events()` → `events.classify` → hub; restarts
  (evict + rebuild) when the account's `latest.json` mtime changes; `SessionExpired` → publish
  `account.session_expired` once, status `session_expired`, stop until a new session lands. **Hub**: an
  `asyncio.Queue(1000)` per socket; full → close 1013 (the gateway reconnects); heartbeat every 30 s.
- `events.py`: pure `classify(account_id: int, frame: dict) -> list[dict]` producing §2.2 frames per §2.3.
- `requirements.txt` exact pins: `fastapi`, `uvicorn[standard]`, `curl_cffi==0.15.0`, `websockets==16.0`,
  `python-socks==2.5.1` (without it the OF socket bypasses the proxy). No sqlalchemy, no python-multipart. Confirm
  uvicorn's `--ws` backend works with websockets 16 (else `--ws websockets-sansio`).
- `Dockerfile`: `python:3.12-slim`, non-root user owning `/data`, `UPSTREAM_STATE_DIR=/data`, HEALTHCHECK (python
  urllib → `/healthz`), `CMD uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1` — pumps and hub are
  in-process, so **exactly one worker**.

**Acceptance.**
```
cd services/upstream && pip install -r requirements.txt -r requirements-dev.txt && ruff check . && pytest -q
docker build -t gateway-upstream:ci services/upstream
UPSTREAM_TOKEN=dev-upstream-token uvicorn app:app --port 3001 &   # drop-in for test/fake-upstream.ts on :3001
pnpm --filter @gateway/api dev    # /v1/accounts → []; /openapi.json lists 8 /v1/{account}/… operations
# owner, real account (P0a+P0b merged): connect.py < curl.txt → /v1/<id>/chats 200; message yourself →
# message.received on /ws; kill the cookie → account.session_expired + status session_expired
```
Tests: bearer on HTTP and `/ws` (accepted subprotocol `bearer`); header routing 400/404/409; each handler on a
`FakeOFClient`; OF error pass-through; `/of-accounts` shape; `/docs/json` has the 8 `of-api` ops; `classify` on
redacted real frames in `tests/fixtures/of_frames/`; supervisor with a fake frame source (restart on session change,
expiry stops the pump); hub overflow closes 1013.

---

## Phase G — Gateway seams (lands first; sole writer of shared gateway files)

**Objective.** Land every shared-file change once, so P1/P2/P3 are file-disjoint.

**Owns.** `apps/api/package.json` + `pnpm-lock.yaml` (+`@fastify/websocket`); `db/schema.ts` + generated
`drizzle/0004_*` (§2.6); `contracts.ts` (§2.3 catalogue + `WEBHOOK_EVENTS` text; `statsQuery`/`stats` zod per P3);
`env.ts` + `.env.example` (§5; add `upstream` to the plain-http allowlist, warn on `ws://` to a remote host, empty
`UPSTREAM_WS_URL` = unset); `lib/event-bus.ts` (complete, §2.4); `app.ts` (register `@fastify/websocket` with
`options: { maxPayload: 4096, handleProtocols: (p) => (p.has('bearer') ? 'bearer' : false) }`; mount `realtimeRoutes`
and `statsRoutes` in `/v1` before `proxyRoutes`); `jobs/index.ts` (`event-retention` job; when `UPSTREAM_WS_URL` is
set, `startEventSource(app.log)` and await its `stop()` on close); `jobs/retention.ts` (`KEEP.event`). Stubs handed to
their phase: `modules/events/source.ts` (no-op `stop`), `modules/realtime/routes.ts`, `modules/stats/routes.ts`.

**Acceptance.**
```
pnpm db:generate && test -z "$(git status --porcelain apps/api/drizzle)"
pnpm -r typecheck && pnpm -r test                        # hygiene: .env.example matches env.ts
curl -H "Authorization: Bearer $K" :4000/v1/webhooks/events | jq '.items|length'   # 11
```

---

## Phase 1 — Event source (plan-v3 P1b)

**Owns.** `modules/events/source.ts` (replaces the stub), `modules/events/ingest.ts`, `test/fake-upstream.ts` (+`/ws`
on the same fake: bearer subprotocol check, `pushFrame()`, `dropSockets()`), `test/events.test.ts`,
`docs/webhooks.md` (event list + at-most-once note).

- **Lifecycle:** one in-process singleton under `RUN_JOBS` when `UPSTREAM_WS_URL` is set;
  `new WebSocket(url, ['bearer', 'bearer.' + UPSTREAM_TOKEN])`; reconnect 1 s → 60 s with jitter, reset on the first
  frame; no frame for 90 s → close and reconnect; `stop()` closes the socket and clears every timer.
- **Ingest** (sequential; bounded queue of 1000, overflow drops + warns): zod-validate §2.2; `heartbeat` only feeds
  the stale timer; unknown `type` → drop + warn. Ledger types:
  `insert … on conflict (dedup_key) where dedup_key is not null do nothing returning id` — no row = duplicate → stop.
  Then `publish()`, then `emit()` for every `team_backend` row. A failed insert is logged; the event is still
  published, not emitted.

**Acceptance (tests).** One pushed frame → one `event` row, one bus event, a pending delivery per linked workspace
with a matching endpoint; same `id` twice → one row, one delivery; `upstream.foo` → delivery, no row; malformed frame
dropped, socket stays up; `dropSockets()` → exactly one reconnect, never two sockets; silent upstream → reconnect after
the stale window; unset `UPSTREAM_WS_URL` → no socket.

---

## Phase 2 — Client WebSocket

**Owns.** `modules/realtime/routes.ts` (replaces the stub), `modules/realtime/hub.ts`, `plugins/actor.ts`,
`modules/logs/redact.ts`, `modules/logs/capture.ts` (only if the upgrade turns out to reach `onResponse`),
`test/realtime.test.ts`, `docs/realtime.md` (browser + Node examples, frames, close codes, at-most-once, resync via REST).

- **Auth** (`actor.ts`): `authenticate` takes the secret from `Authorization: Bearer` or — only on an
  `upgrade: websocket` request — the `bearer.`-prefixed `sec-websocket-protocol` entry; lookup, revocation check and
  `last_used_at` stay the one existing path. `redact.ts`: `sec-websocket-protocol` joins `DROPPED_HEADERS`.
- **Route** `GET /v1/ws` (`websocket: true`): a `preHandler` applies every §2.5 refusal (session actor, no `bearer`
  offer, disallowed `accountId`, unlinked team, 6th socket of a key, `!(RUN_JOBS && UPSTREAM_WS_URL)`); on open,
  register with the hub and send `ready`.
- **Hub:** one `subscribe()`; serialise each event once; send where the key's allowlist (and optional `accountId`)
  admits `accountId`; `bufferedAmount` > 1 MiB → close 1013. **Sweep every 15 s** (exported `sweep()` for tests): one
  query for all open key ids → revoked/missing, `allowed_account_ids`, linked → close 4401/4403 or narrow in place;
  ping each socket, terminate those that missed the last pong. Close all with 1001 on app close.
- **request_log:** one row per session: insert at open (`GET /v1/ws`, status 101, handshake ms, redacted
  headers/query, `accountId` filter); on close update `resp_bytes` (bytes sent) and `error_code` (close reason, null
  if normal). Session length is not stored (§8).

**Acceptance (tests; real `listen(0)` + global `WebSocket`).** Response subprotocol is `bearer` and no response
header carries the key; key A (allowlist [1]) and key B (all): an account-2 event reaches only B; A with
`?accountId=2` → 403 pre-upgrade; revoke idle A → `sweep()` closes 4401; allowlist edit → 4403 or narrowed delivery;
exactly one `request_log` row per session, no key material in it; 6th socket → 429; only `bearer.<key>` offered → 400;
dashboard cookie → 401; the whole existing suite stays green (auth refactor).

---

## Phase 3 — Stats groundwork

**Owns.** `modules/stats/routes.ts` (replaces the stub), `test/stats.test.ts`. Seeds `event` rows directly — no
dependency on P1/P2.

`GET /v1/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=&types=a,b` (key or dashboard session; read scope; tag
`gateway`). UTC days, `to` inclusive, default last 30 days, max 366; `accountId` outside the allowlist → 403;
unlinked → 409.
```sql
select to_char(created_at at time zone 'UTC','YYYY-MM-DD') as day, account_id, type,
       count(*)::int as count, coalesce(sum(amount_cents),0)::bigint as amount_cents
from event where created_at >= $from and created_at < $to + interval '1 day'
  and ($ids::int[] is null or account_id = any($ids)) [and type = any($types)]
group by 1,2,3 order by 1,2,3
```
→ `{"rows":[{"day","accountId","type","count","amountCents"}]}` — sparse; the future widget builder zero-fills and
reduces client-side.
**Acceptance (tests).** Allowlist scoping; range validation; `types` filter; `amountCents` beyond int4; a UTC-midnight
boundary.

---

## Phase 4 — Hostinger compose

**Owns.** `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/hostinger.md`, `README.md` ("How it fits" and
the "this repo does not include one" paragraph), `docs/getting-started.md` (upstream section).

```yaml
upstream:
  build: { context: ../services/upstream }
  image: gateway-upstream:local
  profiles: [upstream]
  expose: ["8000"]                        # never published
  environment:                            # per service; no env_file
    UPSTREAM_TOKEN: ${UPSTREAM_TOKEN:?}
    UPSTREAM_STATE_DIR: /data
    OF_REQUIRE_PROXY: ${OF_REQUIRE_PROXY:-true}
  volumes: [upstream_data:/data]          # sessions + proxies.json = credentials
  restart: unless-stopped
  logging: *logging
```
Gateway gains `UPSTREAM_WS_URL: ${UPSTREAM_WS_URL:-}`, `EVENT_RETENTION_DAYS`, and
`depends_on: { upstream: { condition: service_healthy, required: false } }` (Compose ≥ 2.20). `.env.example`:
`COMPOSE_PROFILES=caddy,upstream`, `UPSTREAM_URL=http://upstream:8000`, `UPSTREAM_WS_URL=ws://upstream:8000/ws`.
Keep `extra_hosts` for an upstream outside compose. hostinger.md: connect an account with `connect.py`; back up
`upstream_data` encrypted (cookies, proxy passwords); rotating `UPSTREAM_TOKEN` restarts both services.

**Acceptance.**
```
sh scripts/compose-smoke.sh                                    # default profiles: still green
cd deploy && COMPOSE_PROFILES=caddy,upstream docker compose up -d --build --wait
docker compose exec gateway node -e '<fetch $UPSTREAM_URL/of-accounts with the bearer>'   # 200
docker compose port upstream 8000                               # nothing published
docker compose exec upstream env | grep -E 'PGPASSWORD|POSTGRES|BETTER_AUTH'              # empty
docker compose restart upstream                                 # accounts and sessions survive
```

---

## 5. Env additions

Gateway (`env.ts` + `.env.example`, Phase G only; `hygiene.test.ts` checks they match):

| Var | Default | Phase |
|---|---|---|
| `UPSTREAM_WS_URL` | unset/empty = no event source; `/v1/ws` answers 503 | 1, 2 |
| `EVENT_RETENTION_DAYS` | `365` | 1, 3 |

Upstream (Python only; not in `env.ts`): `UPSTREAM_TOKEN` (required, ≥16), `UPSTREAM_STATE_DIR` (`/data` in the image,
`./data` in dev), `OF_REQUIRE_PROXY` (`true`), `PORT` (`8000`), `LOG_LEVEL` (`info`). Realtime tunables (15 s sweep,
5 sockets/key, 1 MiB buffer, 90 s stale, 30 s heartbeat) are constants.

## 6. Workstreams & merge order

| Wave | Branch (worktree) | Owns |
|---|---|---|
| 1 | `v4/g-seams` | Phase G list |
| 1 | `v4/p0a-upstream-lift` | P0a list |
| 1 | `v4/p0b-upstream-serve` | P0b list |
| 2 | `v4/p1-event-source` | P1 list |
| 2 | `v4/p2-client-ws` | P2 list |
| 2 | `v4/p3-stats` | P3 list |
| 3 | `v4/p4-deploy` | P4 list |

One implementer (opus/high) per branch; reviewer → fix loop per branch before merge.
**Merge order: G → P0a → P0b → P1 → P2 → P3 → P4.** Wave 1 is fully parallel (G touches only `apps/`, P0a/P0b only
their lists). Wave 2 branches from master **after G merges** and is file-disjoint. P4 needs P0b's Dockerfile and runs
its end-to-end check after P1 and P2.

**Single-writer files.** G alone: `apps/api/package.json`, `pnpm-lock.yaml`, `schema.ts`, `drizzle/**`,
`contracts.ts`, `env.ts`, `.env.example`, `app.ts`, `jobs/{index,retention}.ts`, `lib/event-bus.ts`. P2 alone:
`plugins/actor.ts`, `modules/logs/{redact,capture}.ts`. P1 alone: `test/fake-upstream.ts`. P0a alone: `.gitignore`,
`.dockerignore`, `scripts/prepublish-check.sh`. P0b alone: root `docker-compose.yml`, `.github/workflows/ci.yml`.
P4 alone: `deploy/**`, `README.md`. A phase that needs a shared-file change **stops and reports**; the orchestrator
lands it on master as a serialised follow-up and the phase rebases.

**Generated files are never merged.** Only G generates (`drizzle/0004_*`, `meta/_journal.json`, snapshots,
`pnpm-lock.yaml`); any later regenerate is done by the last lander after deleting the artifacts, and the no-drift
check runs after it. No web routes are added, so `routeTree.gen.ts` is untouched.

## 7. Test strategy

- **No fake OF server.** OF is faked at the object seam: `FakeOFClient` through the `account_client` override, a fake
  frame source for the supervisor. Signing and curl_cffi are exercised only by the owner's real-account check (P0b).
  `classify` runs on redacted real frames.
- **One gateway fake.** `test/fake-upstream.ts` gains the §2.2 `/ws` (P1) — the executable copy of the contract. A
  P0b test asserts the same shapes from Python (`/of-accounts`, `/docs/json`, `/ws` auth + frame keys).
- P2 drives the hub through `publish()` (no upstream); P3 seeds `event` rows.
- CI: existing `check` + `docker` jobs, plus P0b's `upstream` job.

## 8. Cut (YAGNI)

- Upstream `db/`, `relay_cache`/`relay_coalesce`, `lane_config` — the ledger is gateway-side (§1.5).
- Vault/story upload, mass send, co-tagging, tipping in `of_client.py`; Incogniton/Playwright capture modes.
- More v2 handlers and a generic `/of/*` curl-through — add on demand, one `of-api` route each.
- Widget builder, `stats_page` table, dashboard stats page; zero-filled series; non-UTC buckets.
- Client replay/resume (`since` cursor) and a "gap" frame — at-most-once; clients resync via REST.
- Home realtime-status indicator (plan-v3 P1b) — the pump's per-account `status` on the Accounts page covers it.
- Multi-process fan-out (Postgres `LISTEN/NOTIFY`), WS session-length column, `event-map.json`, per-workspace tenancy.

## 9. Owner questions

1. **Frame mapping for tips, PPV unlocks, subscriptions, posts.** The lifted code knows only `api2_chat_message` and
   `post_expire`. Lift the relay's `event_transcoder.py` + `purchase_notifications.py` (they hold the mapping), or
   approve a 24 h raw capture on your account (`python of_ws.py`; redacted frames committed as fixtures)? Until then
   those types stay unemitted and arrive as `upstream.<key>`.
2. **`static_param` on a fresh install.** paste-curl gets it from the relay's login extension (not lifted) or by hand
   per OF revision. Lift the extension, or is the manual field enough?
3. **Proxies.** Refuse to run an account without a proxy (`OF_REQUIRE_PROXY=true`) so the VPS IP never reaches OF?
   Which provider/scheme on Hostinger?
4. **Tenancy.** Still one operator? Under one `UPSTREAM_TOKEN` every linked workspace sees every account's REST,
   events, webhooks and stats; separate collaborator workspaces need an account→workspace table before the stats page.
5. **Message text.** Webhooks and sockets carry fan message text to every linked workspace (the ledger stores none). OK?
6. **Stats defaults.** UTC day buckets and 365-day ledger retention?
7. **Paths.** Confirm `/v1/{account}/chats` (OF's `v2` dropped), not the handoff's `/v1/{account}/v2/chats`.

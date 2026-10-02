# Handoff: serve the OnlyFans upstream — REST v2 + client WebSocket

Status: planned, not built. Owner: project maintainer. Written 2026-10-02.

This is the build handoff for turning the gateway from a proxy-only shell into a
service that actually talks to OnlyFans and serves both a REST API and a live
WebSocket to API clients, with bearer auth, and deploys on Hostinger.

## 1. Goal (what "done" means)

1. **Serve both.** API clients get the OnlyFans v2 REST surface *and* a
   client-facing WebSocket of live events. (onlyfansapi.com ships webhooks only;
   we deliberately also serve a socket.)
2. **Bearer auth, stored.** One credential model for REST and WS. Clients send a
   bearer key; we store only its hash and scope every call to the key's account
   allowlist. Reuse the gateway's existing `gk_` key store — do not invent a
   second one.
3. **v2 endpoint coverage.** After the core serve path works, fill out the v2
   endpoint surface (chats, messages, posts, media/vault, fans, transactions).
4. **User-designable statistics page.** Each workspace can build its own stats
   page over the data we serve: pick metrics, arrange widgets, save the layout.
5. **Hostinger deploy.** The whole stack (gateway + Postgres + the OnlyFans
   upstream + Caddy) comes up with one compose file on a Hostinger VPS.

## 2. What exists today

- **Gateway shell (this repo).** API keys/scopes/allowlists, `/v1/{account}/*`
  passthrough to an upstream's `/of/*`, accounts list, request logs, usage,
  OpenAPI merge, dashboard, Caddy + Hostinger deploy. Fastify 5 + Drizzle +
  Postgres 17; dashboard is Vite + React + better-auth.
- **The upstream contract** (apps/api/src/lib/upstream.ts): three calls, all with
  `Authorization: Bearer $UPSTREAM_TOKEN` — `GET /of-accounts`,
  `{METHOD} /of/<rest>` with header `x-of-proxy-account-id`, and `GET /docs/json`.
- **Nothing that talks to OnlyFans.** No OF client, no signing, no socket. The
  repo delegates all of that to the upstream and was written to point at the
  onlystack-mono Fastify backend.

## 3. The upstream we are supplying

The OnlyFans-serving core is lifted from the private ChatterlyExtension relay
(`service/`), automations stripped. It is a slim FastAPI app around 18 modules:

- **WebSocket:** `of_ws.py` — one socket per account to OnlyFans, reconnect,
  typing frames.
- **Client + signing:** `of_client.py`, `of_signer.py` — pure-Python request
  signing (no Node), curl_cffi TLS impersonation, proxy-routed.
- **Session connect:** `session_bootstrap.py` (paste-curl path only).
- **Accounts/infra:** `accounts.py`, `proxies.py`, `lane_config.py`,
  `live_rev.py`, `client_pool.py`.
- **Shared util:** `atomic_json.py`, `of_shapes.py`, `jsonsafe.py`; optional
  `relay_cache.py`, `relay_coalesce.py`.
- **Optional persistence:** `db/{__init__,engine,models,repo}.py`.

The relay's 10.5k-line `server.py` is NOT lifted. Re-author a slim app carrying
only: the pump supervisor + a `/ws` fan-out, the session-bootstrap route, and the
handful of v2 handlers below.

### Must-replace when lifting (three monolith bindings)

1. **Auth gate.** The relay guards everything with a `SHARE_TOKEN` cookie/query
   gate and has a hardcoded default token in `server.py`. Drop it. The upstream
   trusts only `Authorization: Bearer $UPSTREAM_TOKEN` from the gateway.
2. **Account multiplexing.** The relay resolves the account from `X-Account-Id`
   through a chokepoint tied to its ownership tables. Keep only
   header/query → client routing; the gateway already did the ownership check.
   Map the gateway's `x-of-proxy-account-id` onto this.
3. **send_message decoration.** Strip the employee/attribution/resale hooks down
   to the bare client call.

### Runtime deps (upstream)

`fastapi`, `uvicorn[standard]`, `pydantic`, `python-multipart`,
`curl_cffi==0.15.0`, `websockets==16.0`, `python-socks==2.5.1` (required — without
it the OF socket connects outside the proxy and leaks the server IP). Add
`sqlalchemy[asyncio]`, `sqlmodel`, `aiosqlite` only if you keep persistence.

## 4. Build phases

### Phase 0 — stand up the upstream
Lift the 18 modules into `services/upstream/` in this repo (private, see §6.1),
re-author the slim app, apply the three replacements, add `requirements.txt` and
a `Dockerfile`. Acceptance: it answers the three contract calls plus a `/ws`, and
the gateway's existing fake-upstream tests pass against it when swapped in.
Connect one real account via the paste-curl bootstrap and confirm a live chat
list and a socket event.

### Phase 1 — serve both (REST + client WebSocket)
REST passthrough already works. Add a client-facing WebSocket to the gateway:
- Auth it with the same `gk_` key, via `Sec-WebSocket-Protocol: bearer.<key>`
  (matches the connect pattern already specced in plan-v3).
- On connect, the gateway opens/relays the upstream `/ws`, filters events to the
  key's account allowlist, and streams JSON frames. Optional `?account_id=`.
- Log connect/disconnect into the existing request-log table.
Acceptance: two keys with different allowlists see only their own accounts'
events; revoking a key drops its socket on the next frame.

### Phase 2 — v2 endpoint coverage
Fill the v2 surface. Core handlers already identified in the relay:

| Route | Client method |
|---|---|
| `GET /of/v2/users/me` | `me` |
| `GET /of/v2/chats` | `list_chats` |
| `GET /of/v2/chats/{id}/messages` | `get_messages` |
| `POST /of/v2/chats/{id}/messages` | `send_message` (stripped) |
| `GET /of/v2/posts`, `/posts/{id}` | `list_posts` / `get_post` |
| `GET /of/v2/vault/media`, `/vault/media/{id}` | `vault_media` / `vault_media_by_id` |

The rest are thin curl-throughs over the client's generic JSON GET; add on
demand. Keep each new op tagged `of-api` so it merges into `/openapi.json`.
Acceptance: `/openapi.json` lists the v2 ops; the playground can call each.

### Phase 3 — user-designable statistics page
A per-workspace custom stats page over the data we serve.
- **Data:** a stats API in the gateway that aggregates stored events and
  transactions (daily sends/received, PPV unlocks, new/renewed/expired subs,
  tips, revenue) per account, time-bucketed, scoped to the workspace.
- **Builder:** a dashboard page where the user adds widgets (counter, line,
  bar, table), binds each to a metric + account + range, arranges them, and
  saves a layout. Persist the layout as JSON per workspace (new table
  `stats_page`). Render read-only for viewers.
- Keep it YAGNI: ship a fixed widget set first, not a plugin system.
Acceptance: a user builds a two-widget page, reloads, and it persists; a second
workspace cannot see the first's layout or data.

## 5. Hostinger deploy
Extend `deploy/docker-compose.yml`: add an `upstream` service on the default
network, give it a volume for its session/state dir, set the gateway's
`UPSTREAM_URL=http://upstream:<port>` (removes the host.docker.internal hop), and
add its secrets per-service (never via env_file). Put it behind a compose profile
if it should be optional so `scripts/compose-smoke.sh` stays green. Update
`deploy/hostinger.md` and the README "How it fits" diagram.

## 6. Open decisions (resolve before coding)
1. **Repo boundary.** This repo's own plan (plan-v2 §non-goals, plan-v3 §P5)
   said the OF client, session capture and signing live in a PRIVATE repo.
   Decided 2026-10-02 (owner): **one repo holds everything**, so a single access
   grant lets a collaborator deploy the whole stack. Precondition: the GitHub
   repo must be switched to PRIVATE before `services/upstream/` is committed
   (it is public today). The public-publish plan (filter-repo, AGPL, brand
   scrub) is deferred. Before committing the lift, move deploy-specific values
   (proxy host/creds in `proxies.py`, session file names) into env vars so a
   collaborator's deploy does not inherit yours. The compose file references the image; the source stays
   private. This also avoids publishing the reverse-engineered signing.
2. **Realtime shape.** We serve a socket (user's call). Webhooks already
   shipped (plan-v3 P1a); the upstream socket (P1b) is the shared event source
   for both webhooks and the client socket.
3. **Persistence.** The custom stats page (Phase 3) needs stored events, so adopt
   the upstream's optional `db/` persistence or persist events gateway-side.
   Decide where the aggregate store lives.

## 7. First concrete step
Switch the repo to private. Then create `services/upstream/` with the 18
modules and a slim `app.py`, add its `requirements.txt` and `Dockerfile`, and
wire it into a local compose profile so the gateway can point `UPSTREAM_URL` at
it. Then Phase 0 acceptance.

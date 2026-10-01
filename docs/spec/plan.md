# MVP implementation plan

- **Date:** 2026-10-01. **Working name:** Fanrelay (see §9). **Inputs:** `pages.md`, `endpoints.md`, `mapping.md`, and the backend `onlystack-mono/fastify` (read-only).
- **Principle:** YAGNI. Build the smallest thing that ships the MVP pages. One process, one database, no queue service.
- **MVP covers:** auth and teams, API keys, proxy, read-only accounts list, request logs, usage, Home, playground and webhooks.
- **Out of the MVP (§8):**
  - credits, billing and the credit ledger (Usage counts requests, not credits)
  - the in-dashboard connect-account wizard
  - roles beyond owner and member, and 2FA
  - per-team timezones (everything is in UTC)
  - reference-shaped routes (they come later, from `mapping.md`)

## 1. Backend facts that shape the design (checked in code)

| Fact | Source | Consequence |
|---|---|---|
| `/of/*` requires a **user JWT** (`onRequest: fastify.authenticate` + `isAgencyMember`). `X-Internal-Key` is accepted only on `/users/internal*`, `/plans/internal/change` and `/internal/email`. | `modules/of-api/of-api.routes.ts`, `plugins/internal-auth.ts` | The gateway mints a 5-min HS256 JWT `{ sub: <backend owner user id> }` with the backend's `JWT_SECRET`. The backend's e2e script does the same, so no backend change is needed. |
| The account is chosen with `x-of-proxy-account-id: <of_accounts.id int>`. `requireAccessibleAccount` enforces agency scope. | same | `{account}` = the backend integer id. The backend stays the scope check. |
| Mount path = SDK `pathTemplate` minus `/api2/v2` (e.g. `/of/users/me`). Inputs are JSON-schema validated; responses pass through. | `of-sdk/src/runtime/sdk.ts` | `/v1/{account}/<rest>` is a raw passthrough to `/of/<rest>`. |
| The OpenAPI document is public at `GET /docs/json`, tag `of-api`, ~270 operations. | `app.ts` (swagger-ui) | The gateway merges it into its own `/openapi.json`. |
| Realtime: `GET /ws` with the JWT in `Sec-WebSocket-Protocol: bearer.<jwt>`. The client sends `{type:"v2.subscribe",accountId}` and receives `v2.realtime.event {accountId,eventType,data}` and `v2.realtime.status {accountId,state}`. | `modules/realtime/ws.routes.ts`, `v2/v2-realtime-manager.ts` | The webhook event source is one WebSocket per linked team. |
| `GET /of-accounts` (JWT) returns id, label, ofUsername, ofDisplayName, ofAvatarUrl and status. | `modules/of-accounts` | Feeds `GET /v1/accounts` and the Accounts page. |
| `@fastify/rate-limit` allows 300 req/min, keyed by IP. | `app.ts` | All gateway traffic shares one bucket (R3). |

## 2. Decisions

1. **Repo shape:** pnpm workspace with `apps/api`, `apps/web`, `packages/shared` and `docs/`. **Dropped `packages/db`**: only the api uses Postgres, so the schema lives in `apps/api/src/db`. No Turborepo; `pnpm -r` is enough.
2. **Gateway:** Fastify 5 + TS + Drizzle (node-postgres) + Postgres 17 + `fastify-type-provider-zod` (zod 4, like the backend). One zod schema validates, types and documents each route. The stack matches the backend, so modules can move there later.
   - **One surface, two credentials.** `/v1/*` accepts `Authorization: Bearer <key>` *or* the dashboard session cookie plus an `x-dashboard: 1` header (a CSRF guard). Dashboard-only management lives under `/api/*` (session only). No tRPC: the dashboard reuses the `/v1` handlers.
   - **Webhook jobs: a Postgres-polling worker (`FOR UPDATE SKIP LOCKED`), not BullMQ.** No Redis to run. Retry state lives in rows, so it survives restarts and is safe with several instances.
   - **Proxy:** native `fetch` with buffered bodies. The `/of` surface is JSON, and we need the body for logs. `/of-media` and `/of-upload` are not proxied in the MVP.
   - **Background jobs run in the api process** (log flush, rollup, retention, delivery worker, event source). Only the event source takes a Postgres advisory lock, so a single instance subscribes.
3. **Dashboard:** Vite + React + TanStack Router (file routes) + TanStack Query, Tailwind v4 + shadcn/ui, recharts. It's a pure SPA because all server logic already lives in Fastify, and you use TanStack daily; Next.js would add a second server runtime.
   - **Production:** the api serves `apps/web/dist` from the same origin, so no CORS is needed.
   - **Dev:** Vite proxies `/api` and `/v1` to :4000.
   - **Dashboard auth:** better-auth (email + password, Drizzle adapter) with the `organization` plugin's model renamed to `team`. That provides users, sessions, teams, members, invitations and active-team switching. Only the owner and member roles are used. Invitations are copyable links; there's no email provider in the MVP.
4. **Playground:** a small custom request builder in `apps/web`, driven by `/openapi.json`. It needs an account picker, sending with the session (no raw key in the browser) and URL prefill from log rows. Scalar can't do all three.
5. **Docs:** `docs/*.md` (getting started, auth, webhook signature checks). The gateway serves `/openapi.json` and a Scalar reference at `/docs` (`@scalar/fastify-api-reference`, about 5 lines). No separate docs site.

## 3. Layout

```
apps/api/    src/{server.ts,app.ts,env.ts,auth.ts}  src/db/{index.ts,schema.ts}  drizzle/
             src/plugins/{session.ts,actor.ts,web-static.ts}  src/lib/{backend.ts,ids.ts,errors.ts,signature.ts}
             src/modules/{keys,accounts,proxy,logs,usage,openapi,webhooks}/  src/jobs/  scripts/  test/
apps/web/    src/{main.tsx,lib/{api.ts,auth-client.ts}}  src/routes/  src/features/playground/  src/components/ui/
packages/shared/src/{index.ts,events.ts}       docs/{getting-started.md,authentication.md,webhooks.md,spec/}
docker-compose.yml  docker/initdb/test-db.sql  .env.example  pnpm-workspace.yaml  tsconfig.base.json  LICENSE
```

## 4. Gateway surface

| Prefix | Auth | Purpose |
|---|---|---|
| `/api/auth/*` | none or session | better-auth (sign-up, sign-in, session, teams, invitations) |
| `/api/*` | session | Dashboard management: keys, logs, usage, overview |
| `/v1/*` | key or session | Public API: whoami, accounts, webhooks, `/{account}/*` proxy |
| `/openapi.json`, `/docs`, `/healthz` | none | Spec, reference and health check |
| `/*` (production) | none | Dashboard SPA (`index.html` fallback) |

Error shape for gateway-generated errors: `{ "error": { "code", "message", "requestId" } }`. Upstream errors pass through unchanged.

## 5. Build order (each slice runs and is tested on its own)

### Slice 1: scaffold, database, auth, teams

- **Files:**
  - Root: `package.json` (dev, test, typecheck, db:generate, db:migrate), `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `docker/initdb/test-db.sql`, `.env.example`, `README.md`, `LICENSE`, `.github/workflows/ci.yml` (typecheck + test against a Postgres service).
  - api: `env.ts` (zod-parsed, fails fast), `db/index.ts`, `db/schema.ts` (one file until it hurts), `auth.ts`, `plugins/session.ts` (mounts `/api/auth/*`; a `requireSession` hook sets `request.session {userId, teamId, role}`), `plugins/web-static.ts` (production only), `lib/ids.ts` (`newId('key')` → `key_<20 base62>`), `scripts/link-team.ts`.
  - web: `routes/{__root,login,register,invite.$invitationId,_app,_app/index,_app/team,_app/settings}.tsx`, `lib/auth-client.ts`, `lib/api.ts` (sends credentials and `x-dashboard: 1`), shadcn components (button, input, dialog, table, badge, card, tabs, select, dropdown, sonner).
- **Tables:**
  - better-auth generated: `user`, `session` (+ `active_organization_id`), `account`, `verification`, `team` (id, name, slug unique, logo?, metadata?, created_at), `member` (id, team_id, user_id, role, created_at), `invitation` (id, team_id, email, role, status, expires_at, inviter_id).
  - Ours: `team_backend` (team_id PK FK→team, backend_user_id int not null, linked_at). This is a separate table rather than org `additionalFields`, which has open better-auth bugs. It also can't be edited through the auth API: it's set only by `pnpm --filter api link-team <slug> <backendUserId>`.
- **Endpoints:** `/api/auth/*`, `GET /healthz`.
- **Pages:**
  - `/team`: members, copy invite link, remove member (owner only).
  - `/settings`: rename team; read-only "backend link: user #N"; delete team (owner, typed confirm).
- **Verify:**
  - `docker compose up -d && pnpm i && pnpm db:migrate && pnpm dev`. Register at :5173, create a team, open the invite link in a private window, accept, and both users appear on `/team`.
  - `curl -c jar -H 'content-type: application/json' -d '{"email":"a@x.dev","password":"pw12345678","name":"A"}' :4000/api/auth/sign-up/email`, then `curl -b jar :4000/api/auth/get-session`.

### Slice 2: API keys, key auth, proxy, accounts

- **Files:**
  - `plugins/actor.ts`: the `authenticate` hook on `/v1` (bearer key looked up by sha256, else session + `x-dashboard`) sets `request.actor = {teamId, keyId|null, userId|null, scope, accountIds|null}`.
  - `modules/keys/{routes,service}.ts`.
  - `lib/backend.ts`: `backendToken(teamId)` mints via `fast-jwt` (same library as the backend) and caches for 4 min; `backendFetch()` has a 30 s timeout.
  - `modules/proxy/routes.ts`, `modules/accounts/routes.ts`, `modules/whoami.ts`.
  - web: `_app/keys.tsx`, `_app/accounts.tsx` (read-only; the empty state explains that accounts connect through the backend app).
- **Table `api_key`:** id (`key_…`), team_id FK cascade, name, start (first 12 chars, for display), key_hash unique (sha256 hex), scope (`read`|`write`), allowed_account_ids int[] null (null = all), created_by FK user, last_used_at (written at most once a minute), created_at, revoked_at null. Index on (team_id).
- **Key format:** `frk_` + 32 base62 characters. sha256 is enough for high-entropy secrets; there's no bcrypt on the hot path.

| Endpoint | Auth | Behaviour |
|---|---|---|
| `GET/POST /api/keys`, `PATCH/DELETE /api/keys/:id` | session | List, create (returns `secret` once), edit name/scope/allowlist, revoke (soft) |
| `GET /v1/whoami` | key/session | Team plus key name, scope and allowlist |
| `GET /v1/accounts` | key/session | Backend `GET /of-accounts`, filtered by the allowlist |
| `ALL /v1/:account/*` | key/session | Proxy to `/of/*` |

- **Proxy checks, in order:**
  1. `:account` must match `^\d+$`, else 404.
  2. The team must have a `team_backend` row, else 409 `team_not_linked`.
  3. A read key making a non-GET call gets 403 `insufficient_scope`.
  4. An account outside the allowlist gets 403 `account_not_allowed`.
- **What gets forwarded:** the method, the query string verbatim and the raw JSON body. Headers sent: `authorization: Bearer <minted>`, `x-of-proxy-account-id`, `x-request-id`, `content-type`, `accept`, and `x-of-cache` if present.
- **What comes back:** the upstream status, `content-type`, `x-of-cache` and body. A network error returns 502 `upstream_unavailable`; a timeout returns 504 `upstream_timeout`.
- **Routing:** static `/v1/whoami|accounts|webhooks` routes take priority over `/v1/:account/*` in Fastify's router.
- **Verify:**
  - `curl -H "Authorization: Bearer $KEY" :4000/v1/whoami`, then `.../v1/accounts`, then `.../v1/$ACCT/users/me` (returns the backend JSON).
  - A read key doing `-X POST .../v1/$ACCT/chats/1/mute` gets 403. A revoked key gets 401.
  - vitest `proxy.test.ts` against `test/fake-backend.ts` checks the forwarded path, headers and JWT `sub`.

### Slice 3: request logs

- **Table `request_log`:**
  - Identity: id (`req_…`, also returned as `x-request-id`), team_id, api_key_id null (null = dashboard), user_id null, account_id int null.
  - Request: method, path (as called, without query), endpoint (normalised, e.g. `GET /users/:id/posts`: numeric and uuid segments become `:id`, `/v1/:account` is stripped, gateway routes use their pattern), query null, ip.
  - Result: status_code, duration_ms, req_bytes, resp_bytes, error_code null.
  - Bodies: req_headers jsonb (allow-listed and redacted), req_body text null, resp_body text null (redacted, truncated at `LOG_BODY_MAX_BYTES`).
  - created_at.
  - Indexes: (team_id, created_at desc, id desc) and (team_id, api_key_id, created_at desc).
- **Files:**
  - `modules/logs/capture.ts`: `/v1`-scoped hooks. onRequest assigns the id and start time; onSend captures the payload; onResponse builds the row and pushes it to the buffer.
  - `modules/logs/writer.ts`: flushes every 1 s or 500 rows with one multi-row insert, and flushes on close.
  - `modules/logs/redact.ts`: drops the `authorization`, `cookie`, `set-cookie` and `x-internal-key` headers. In JSON it masks keys matching `/pass(word)?|secret|token|cookie|auth|otp|session|code$/i`. Non-JSON bodies become `[<n> bytes <type>]`.
  - `modules/logs/routes.ts`; `jobs/retention.ts` (hourly; deletes logs older than `LOG_RETENTION_DAYS` in batches of 10k).
  - web: `_app/logs.index.tsx` (filters kept in the URL, cursor-based "load more") and `_app/logs.$id.tsx` (summary, headers/query/body, pretty response, copy as cURL with `$API_KEY`, "Open in playground").
- **Endpoints:**
  - `GET /api/logs?from&to&status=2xx|4xx|5xx|error&keyId&accountId&method&endpoint&q=<req_id>&cursor&limit` returns `{items,nextCursor}` without bodies.
  - `GET /api/logs/:id` returns the full row.
- **Verify:** make a 200, a 403 and a 502 call (backend stopped). Within 2 s, `curl -b jar ':4000/api/logs?limit=3'` lists them newest first with matching `x-request-id` values, and the detail view shows no auth header value. Unit test for `redact`.

### Slice 4: usage rollups, Usage page, Home

- **Table `usage_daily`:** team_id, day (date, UTC), api_key_id text not null (`''` = dashboard), account_id int not null (0 = none), endpoint, requests, errors (status ≥ 400), duration_ms_sum bigint, bytes_out bigint. PK (team_id, day, api_key_id, account_id, endpoint).
- **`jobs/rollup-usage.ts`:** runs every 10 min, or on demand with `pnpm --filter api job:rollup [--from YYYY-MM-DD]`. It does `INSERT … SELECT … FROM request_log WHERE created_at >= yesterday 00:00 UTC GROUP BY … ON CONFLICT (pk) DO UPDATE SET <recomputed>`.
  - Whole days are recomputed, so it's idempotent and safe on several instances.
  - "Today" is at most 10 min stale, so there's no provisional toggle.
  - Log retention (14 d) is longer than the rollup window (2 d), so there are no gaps.
- **Endpoints:**
  - `GET /api/usage?from&to&groupBy=day|key|account|endpoint` returns `{series:[{day,requests,errors}], rows:[{key,label,requests,errors,avgMs,bytes,share}]}`.
  - `GET /api/overview` returns 24 h and 7 d requests, error rate, active keys, accounts by status (from the backend) and paused webhooks (once slice 6 is done).
- **Pages:**
  - `/usage`: range picker, stacked ok/error bars, group-by tabs, table, client-side CSV export.
  - `/` (Home): KPI cards, a 7-day chart, a "needs attention" list (accounts that aren't `active`, paused webhooks) and an onboarding checklist (key created, team linked, first request).
- **Verify:** run 50 calls to `/v1/$ACCT/users/me`, then `job:rollup`. `curl -b jar ':4000/api/usage?groupBy=endpoint'` shows `GET /users/me` = 50. Rerunning the rollup changes nothing (vitest checks this).

### Slice 5: playground, OpenAPI, docs

- **`modules/openapi/routes.ts`:** `GET /openapi.json` = `app.swagger()` (the gateway's own zod routes) plus the backend's `/docs/json` paths tagged `of-api`, rewritten from `/of/x` to `/v1/{account}/x` with an `account` path parameter and bearer security.
  - Cached for 10 min.
  - If the backend is down, it serves the gateway-only spec with an `x-backend-spec: unavailable` header.
  - `GET /docs` serves Scalar.
- **web:**
  - `_app/playground.tsx` reads its state from search params (`op`, `account`, `path`, `query`, `body`).
  - `features/playground/`:
    - `spec.ts`: loads the spec, groups by tag, matches a raw path to its template.
    - `OperationPicker.tsx`: tag groups and search.
    - `RequestForm.tsx`: path and query inputs; a JSON body seeded from the schema.
    - `ResponsePanel.tsx`: status, time, headers, body.
    - `snippet.ts`: curl with `$API_KEY`.
  - Requests are sent with the session, so they're logged with key "Dashboard".
- **Verify:** `curl -s :4000/openapi.json | jq '.paths|keys|length'` gives ≥ 270 with the backend up. In the UI, `GET /v1/{account}/users/me` → Send returns 200 and a new row appears in `/logs`. "Open in playground" from that row prefills the same operation.

### Slice 6: webhooks (6a delivery engine without the backend, 6b backend event source)

- **Table `webhook_endpoint`:**
  - id (`whe_…`), team_id FK cascade.
  - url: https only, unless `ALLOW_HTTP_WEBHOOKS=true`.
  - description null, events text[] (empty = all).
  - secret: `frwh_…`, generated server-side and revealable in the dashboard. Stored in plain text because signing needs it; encryption is parked.
  - enabled bool, paused_reason null (`failures`|`manual`), consecutive_failures int, created_at, updated_at.
- **Table `webhook_delivery`:**
  - id (`whd_…`, also the idempotency id), team_id, endpoint_id FK cascade.
  - event_type, account_id null, payload jsonb.
  - status (`pending`|`succeeded`|`failed`), attempts, next_attempt_at.
  - last_status_code null, last_error null, last_attempt_at null.
  - replay_of null, created_at.
  - Indexes: partial (next_attempt_at) WHERE status='pending'; (endpoint_id, created_at desc).
- **Envelope:** `{id,type,createdAt,accountId,data}`.
- **Headers:** `fanrelay-event`, `fanrelay-delivery`, and `fanrelay-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
- **`webhooks/worker.ts` (runs every 1 s):**
  - Claims work with `SELECT d.* … JOIN webhook_endpoint e … WHERE d.status='pending' AND d.next_attempt_at<=now() AND e.enabled ORDER BY d.next_attempt_at LIMIT 20 FOR UPDATE OF d SKIP LOCKED`, then POSTs each (10 s timeout, no redirects).
  - A 2xx marks the delivery `succeeded` and resets `consecutive_failures` to 0.
  - Otherwise attempts goes up by one and the next try waits 30 s, then 2 m, 10 m, 1 h, 6 h. After `WEBHOOK_MAX_ATTEMPTS` (6) the delivery is `failed` and the endpoint's failure count goes up.
  - At `WEBHOOK_PAUSE_AFTER` (20) consecutive failures, the endpoint is disabled with `paused_reason='failures'`.
  - Re-enabling resets the counter, and waiting deliveries resume.
  - Retention deletes deliveries older than 7 d.
- **`webhooks/service.ts#emit(teamId,type,accountId,data)`:** inserts one row per enabled endpoint whose `events` list is empty or contains `type`.
- **6b `webhooks/event-source.ts`:**
  - Holds `pg_try_advisory_lock`.
  - Every 60 s it makes sure each linked team with an enabled endpoint has one WebSocket to `BACKEND_WS_URL/ws` (`bearer.<jwt>`), lists `/of-accounts`, and sends `v2.subscribe` for any new account.
  - Event mapping:
    - `realtime.chat_message.received` → `message.received`
    - any other eventType → `realtime.<eventType>`
    - status `auth_failed` → `account.session_expired`
  - Reconnects with backoff from 1 s up to 60 s.
- **Event catalogue (`packages/shared/src/events.ts`):** `message.received`, `account.session_expired`, `webhook.test`, `realtime.*`.

| Endpoint (key or session; writes need write scope) | Behaviour |
|---|---|
| `GET/POST /v1/webhooks` | List; create (returns secret) |
| `GET /v1/webhooks/events` | Catalogue |
| `GET/PATCH/DELETE /v1/webhooks/:id` | Read; update url/events/enabled (enabling clears the breaker); delete |
| `POST /v1/webhooks/:id/test` | Queue a `webhook.test` event |
| `GET /v1/webhooks/:id/deliveries?status&event&cursor` | Delivery list |
| `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` | New pending row with the same payload and `replay_of` set |

- **Other files:**
  - `lib/signature.ts`.
  - `scripts/webhook-receiver.ts`: listens on :4100, checks signatures, returns 500 when `FAIL=1`.
  - `docs/webhooks.md`.
  - web: `_app/webhooks.index.tsx` (health badge ok/failing/paused, enable toggle, create/edit dialog) and `_app/webhooks.$id.tsx` (deliveries, payload drawer, Redeliver).
- **Verify 6a:**
  1. Run `pnpm --filter api receiver`, then create an endpoint at `http://localhost:4100/hook` with `ALLOW_HTTP_WEBHOOKS=true`.
  2. `POST /v1/webhooks/$ID/test`: the receiver logs "signature ok".
  3. Restart the receiver with `FAIL=1`: attempts and backoff show up.
  4. Set `WEBHOOK_PAUSE_AFTER=3`: the endpoint pauses.
  5. Redeliver: a new row appears with `replay_of` set.
  6. vitest covers signature round-trip, the backoff schedule, the breaker, and two workers never sending the same delivery twice.
- **Verify 6b:** with the backend running, send a DM to a connected test account. A `message.received` delivery arrives.

## 6. Local dev

- **docker-compose:** a single `postgres:17-alpine` service on `5434:5432` (avoids a local 5432) with a volume. `docker/initdb` creates `gateway_test`. **No Redis.**
- **Ports:** api 4000, web 5173, webhook receiver 4100, backend 3001. Start the backend separately (`onlystack-mono/fastify: npm run dev`).
- **`.env.example`:**
```
DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway
TEST_DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway_test
PORT=4000
APP_URL=http://localhost:5173          # better-auth trusted origin + invite links
BETTER_AUTH_SECRET=
BACKEND_URL=http://localhost:3001
BACKEND_WS_URL=ws://localhost:3001
BACKEND_JWT_SECRET=                    # same value as the backend's JWT_SECRET
LOG_BODY_MAX_BYTES=16384
LOG_RETENTION_DAYS=14
WEBHOOK_MAX_ATTEMPTS=6
WEBHOOK_PAUSE_AFTER=20
ALLOW_HTTP_WEBHOOKS=false
RUN_JOBS=true
```
- **Linking a team:** `pnpm --filter api link-team <team-slug> <backendUserId>`. Use the backend `users.id` of the agency owner whose accounts the team should see.

## 7. Testing

- vitest in `apps/api` using `app.inject`.
- A real Postgres (`gateway_test`): migrated in globalSetup, tables truncated per file.
- `test/fake-backend.ts` is a Fastify instance on port 0 that serves an echo for `/of/*`, plus `/of-accounts`, `/docs/json` and `/ws`.
- The web app has no unit tests in the MVP; each slice is checked by hand.
- CI runs `pnpm -r typecheck && pnpm -r test`.

## 8. Parked until after the MVP

- Credits, ledger, billing and auto top-up
- Dashboard connect-account wizard and opaque `acct_` ids
- Reference-shaped routes from `mapping.md`
- Per-team rate limits
- Team timezone, 2FA, custom roles and permissions
- Data exports, ads, links, analytics, AI and housekeeping pages
- Per-attempt delivery history
- Encrypting webhook secrets
- Log bodies outside Postgres, and partitioning `request_log`

## 9. Name

| Name | Notes |
|---|---|
| **Fanrelay** (recommended) | Says what it does: it relays API calls and events. A quick web search on 2026-10-01 found no software with this name. Key prefix `frk_`, headers `fanrelay-*`. |
| Fanplane | "Control plane" for creator accounts. The only match found was a video-game item. |
| Creatorport | Neutral across platforms, but the name is already used by small unrelated companies. |

Check the GitHub org, npm scope and domain before publishing.

## 10. Risks and open questions

1. **Which backend?** This plan targets onlystack-mono `fastify`. If the target is the fanempire of-bridge instead, only `lib/backend.ts`, the proxy prefix, the accounts mapping and the event source change.
2. **Backend credential.** The gateway holds the backend's `JWT_SECRET` and can impersonate linked owners. Is that acceptable for the MVP? The cleaner option later is a small backend change so `/of/*`, `/of-accounts` and `/ws` accept `X-Internal-Key` plus an acting user id.
3. **Backend rate limit.** The limit is 300 req/min **per IP**, so all gateway traffic shares one bucket. Before real load, the backend needs an `allowList` or `keyGenerator` entry for the gateway.
4. **Accounts.** `{account}` is the backend integer id, and accounts connect only through the backend's desktop cookie flow, so the dashboard has no connect wizard (pages.md 3.3). Is that OK for the MVP?
5. **Public API shape.** v0.1 exposes the platform's native paths (`/v1/{account}/users/me`) until `mapping.md` defines reference-shaped routes. Is that acceptable to publish, given the platform's terms of service?
6. **Repo and licence.** Keep a separate repo, with the same stack so modules can move into the backend later? MIT (maximum adoption) or AGPL-3.0 (blocks closed hosted forks)?

## 11. Amendments after review (2026-10-01)

Decided after `plan-review.md` (devil's advocate) and `plan-review-codex.md`. These override the sections above where they conflict.

**Scope: the release boundary is slice 5.** Webhooks (slice 6) ship after v0.1.

| Cut from MVP | Replacement |
|---|---|
| Team invitations, members page, team deletion | One workspace (`organization`) auto-created per user at sign-up. `team_id` isolation stays in every table and query so multi-member comes later without a migration. |
| `usage_daily` rollup job | `GET /api/usage` aggregates `request_log` directly over a bounded range (max 31 days) using the `(team_id, created_at)` index. Rollups only when that gets slow. |
| Log write buffer | Direct insert per request, awaited off the response path (`setImmediate`), errors logged not thrown. |
| Response bodies stored by default | `LOG_BODIES=errors` (default): store request+response bodies only for status ≥ 400; `all` / `none` available. Query strings are redacted with the same key regex, and redaction runs before truncation. |
| Home page charts, attention feed, onboarding checklist | Home = three KPI cards (24 h requests, error rate, active keys) and a link to Usage. |
| Schema-driven playground forms | Operation picker (tag + search), account picker, editable path and query, JSON textarea, response panel, curl snippet. Playground state is a log id or in-memory, never request bodies in the URL. |
| `packages/shared` | Dropped. Types that both apps need live in `apps/api/src/contracts.ts` and are imported by path alias. |
| Advisory lock, multi-instance worker guarantees, circuit breaker, `realtime.*` catch-all | Postponed with webhooks. When built: lease-based claim (`UPDATE … SET next_attempt_at = now() + interval '60s' … SKIP LOCKED RETURNING`), SSRF check on URL (resolve host, reject private/loopback/link-local ranges), Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`). |

**Security fixes (slice 2 must include these):**
1. **Proxy path** is built from the raw URL (`request.raw.url`), not the decoded wildcard. Reject any segment that is `.` or `..`, any `%2F`/`%2f`/`%5C`, and any path not starting with `/of/` after joining. Covered by a test with the `..%2fof-accounts` payload.
2. **CSRF on every cookie-authenticated write** (`/api/*` and session-authenticated `/v1/*`): require `x-dashboard: 1` and `Origin` equal to `APP_URL`. Bearer + cookie together: use the bearer, and if the bearer is invalid return 401 (no cookie fallback).
3. **Accounts response whitelist:** `/v1/accounts` returns only `id, label, username, displayName, avatarUrl, status`.
4. **Minted backend JWT:** `{ sub: <int>, iat, exp }` only; never include `employeeId`. Pre-deployment requirement (outside this repo): add a dedicated gateway credential to the backend so the gateway does not hold the backend's signing secret. Tracked as R2.
5. **Tenant tests:** one vitest file that proves cross-team access fails for keys, logs, and accounts, and that a read key cannot write.
6. **Rate limit:** forward upstream `Retry-After` and `x-ratelimit-*` headers; add `@fastify/rate-limit` per API key (default 120 req/min) so one client cannot drain the backend's shared 300 req/min bucket.

**Naming:** "Fanrelay" is taken by a product in the same market. The code does not depend on a name: API key prefix `gk_`, webhook secret prefix `whsec_`, Standard Webhooks headers, npm packages `@gateway/api` and `@gateway/web`. The product name, the GitHub repo name (the current folder name contains a third-party trademark and must change before publishing) and the README title are a single user decision deferred to publish time.

**Publishing:** before the repo goes public, move `docs/spec/pages.md`, `endpoints.md` and `mapping.md` out of the public tree (they are derived from a competitor's product and a reverse-engineered platform API) or reduce them to the gateway's own surface, and add a "not affiliated with or endorsed by any platform" notice to the README.

**Licence:** AGPL-3.0 (reversible until first public release).

**better-auth:** keep the plugin's `organization` naming in the DB and code; the UI says "workspace". Auth schema is generated into `apps/api/src/db/auth-schema.ts`. Env gains `BETTER_AUTH_URL` and `TRUST_PROXY`.

**Testing:** vitest `fileParallelism: false` against `gateway_test`.

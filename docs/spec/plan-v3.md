# Plan v3: the rest of the road to v1.0

Spec for the remaining work after plan-v2 (packaging shipped). Release boundary for this plan is **v1.0**.
Principle: **YAGNI** — build only what makes v1 coherent; speculative features are listed in §7 with the reason.

This plan **overrides** plan.md and plan-v2 where they conflict (see §2). Line refs: plan.md slice 6 (§165-213),
realtime §21/6b, Home §142-145; plan-v2 §4 upstream, §5 env; review-mvp "Open (high)".

What gates the **v1.0 tag**: the webhook **delivery engine** (P1a), dashboard depth (P2), the webhooks dashboard
(P3) and release polish (P4). The upstream WebSocket **event source** (P1b) and the connect contract (P5) are
planned **after** the tag — see "After v1.0". The tag must **not** be gated on an event source proving out against
a real upstream.

## 0. Baseline (what shipped)

- API modules: `accounts`, `keys`, `logs`, `openapi`, `proxy`, `usage`, `whoami`. **No `webhooks` module.**
- `db/schema.ts`: `team_backend` (link gate) + `api_key` + `request_log` + better-auth tables. **No webhook tables.**
- `lib/upstream.ts`: the opaque upstream contract — `listAccounts`, `forward`, `openapi`, one `UPSTREAM_TOKEN`,
  origin-only URL, no JWT minting. `jobs/{index,retention}.ts` (scheduler gated by `RUN_JOBS`; no rollup job).
  The jobs harness is today **run-once-return intervals** — no long-lived tasks (see §6 lifecycle note).
- `db/index.ts` uses **`pg.Pool`** (a connection pool, not a pinned session).
- Web pages: `index` (Home: 3 KPI cards), `accounts`, `keys`, `logs.index`/`logs.$id`, `usage`, `playground`,
  `settings`. **No webhooks page.** Migrations via `pnpm db:generate` + `pnpm db:migrate` (`apps/api/drizzle/`).

## 2. Reconciliations that override the old specs

1. **Naming** (plan.md §9/§11): key prefix `gk_`, webhook secret `whsec_`, **Standard Webhooks** headers
   (`webhook-id`, `webhook-timestamp`, `webhook-signature`) — **not** the old `fanrelay-*`/`frk_`/`frwh_`.
2. **`packages/shared` was dropped.** The event catalogue and shared types live in `apps/api/src/contracts.ts`,
   imported by the web app via its path alias. Do **not** recreate `packages/shared`.
3. **Opaque, single-token upstream.** No per-team JWT minting, no backend signing secret. The event source
   (**P1b**, post-1.0) consumes `UPSTREAM_WS_URL` as an **opaque user-supplied stream**, authenticated via
   `Sec-WebSocket-Protocol: bearer.<UPSTREAM_TOKEN>` (the global `WebSocket` cannot reliably set an `Authorization`
   header — see P1b). The gateway only *consumes* events; it never captures or stores any platform session.
4. **One upstream, one tenant.** Because there is a single `UPSTREAM_TOKEN`, plan.md's "one WebSocket per linked
   workspace" collapses to **one upstream WS** whose events fan out to every linked workspace's endpoints **as
   stored, pushed deliveries**. **Decision:** acceptable for a single-operator self-host (the operator owns all
   workspaces); multi-tenant scoping is **out of scope for v1**. See Q1.
5. **No new runtime deps.** Node ≥22.12 gives a global `WebSocket` client and `crypto` HMAC; use them. (If the real
   upstream rejects the `Sec-WebSocket-Protocol` bearer scheme, P1b may add the `ws` dependency and strike this
   rule — a post-1.0 decision.)

---

## Phase 1a — Webhooks: delivery engine (6a) — **gates the v1.0 tag**

**Objective.** A `webhooks` module that signs, delivers, retries and breaks: the `/v1/webhooks` CRUD, test,
deliveries and redeliver routes, the event catalogue, `emit()`, and a local test receiver. This is the **only**
webhooks work on the v1.0 critical path. The upstream event source is **P1b** (after v1.0); the tag must not wait
on it.

**Owns.** New: `apps/api/src/modules/webhooks/{routes,service,worker}.ts`, `apps/api/src/lib/signature.ts`,
`apps/api/src/db/webhook-receiver.ts` (local test receiver), `docs/webhooks.md`, `apps/api/test/webhooks.test.ts`.
Shared hand-written (**serialised**; each phase rebases on the prior, not disjoint): `db/schema.ts` (+2 tables),
`contracts.ts` (+events), `env.ts` (+`WEBHOOK_*`, `ALLOW_HTTP_WEBHOOKS`), `app.ts` (mount routes),
`jobs/index.ts` (register worker under `RUN_JOBS`). Generated (**never merged** — regenerate, see §6):
`apps/api/drizzle/*` (migration files + `meta/_journal.json` + snapshots). `event-source.ts` and `UPSTREAM_WS_URL`
are **not** here — they are P1b.

**Schema.**
- `webhook_endpoint`: id (`whe_…`), team_id FK cascade, url (https-only unless `ALLOW_HTTP_WEBHOOKS`), description null,
  events text[] (empty = all), secret (`whsec_…`, plaintext, revealable), enabled bool, paused_reason null
  (`failures`|`manual`), consecutive_failures int default 0, created_at, updated_at.
- `webhook_delivery`: id (`whd_…`, also the idempotency id), team_id, endpoint_id FK cascade, event_type,
  account_id int null, payload jsonb, status (`pending`|`succeeded`|`failed`), attempts int default 0,
  next_attempt_at, last_status_code null, last_error null, last_attempt_at null, replay_of null,
  dedup_key null, created_at.
  Indexes: partial `(next_attempt_at)` WHERE status='pending'; `(endpoint_id, created_at desc)`;
  **unique `(endpoint_id, dedup_key)` WHERE dedup_key is not null** (used by P1b's upstream dedup; unused in v1.0).

**Envelope + signature** (`lib/signature.ts`). Body `{id,type,createdAt,accountId,data}`. Standard Webhooks:
`webhook-id: <whd_…>`, `webhook-timestamp: <unix>`, `webhook-signature: v1,<base64 HMAC-SHA256(secretBytes,
"<id>.<timestamp>.<body>")>` where `secretBytes` is the base64 decode of the part after `whsec_`. (Confirm the
encoding interoperates with an off-the-shelf SW verifier — Q3.)

**Worker** (`worker.ts`, ~1 s claim loop under `RUN_JOBS`). Safe for **N workers** via
`SELECT … FOR UPDATE SKIP LOCKED` — **no DB lock** (see §7 and the note below). The claim **leases** rows and
**does not touch `attempts`**:
`UPDATE webhook_delivery SET next_attempt_at = now()+interval '60s' WHERE id IN (SELECT d.id FROM webhook_delivery d
JOIN webhook_endpoint e ON e.id=d.endpoint_id WHERE d.status='pending' AND d.next_attempt_at<=now() AND e.enabled
ORDER BY d.next_attempt_at LIMIT 20 FOR UPDATE OF d SKIP LOCKED) RETURNING *`. The lease only pushes
`next_attempt_at` ~60 s out so a second worker won't re-claim the same row.
POST each (10 s timeout, `redirect:'manual'`, SSRF check: reject private/loopback/link-local resolved hosts).
**Count attempts on completion, not at claim.** The completion write increments `attempts = attempts+1` and
**overwrites** `next_attempt_at` with the real backoff (first retry **30 s** → 2 m → 10 m → 1 h → 6 h), so the first
retry is 30 s, not the ~60 s lease. 2xx → `succeeded`, endpoint `consecutive_failures=0`. Non-2xx/error → stays
`pending` with the backoff until `attempts` reaches `WEBHOOK_MAX_ATTEMPTS` (6) → `failed` and endpoint failures++.
At `WEBHOOK_PAUSE_AFTER` (20) consecutive failures → disable, `paused_reason='failures'`. Re-enable clears the
breaker and resumes pending. Retention deletes deliveries older than `WEBHOOK_RETENTION_DAYS` (7).
*Why completion-counted:* a crash or redeploy mid-delivery on a single-process VPS must not burn an attempt or
falsely pause an endpoint — the lease just delays the next try by ~60 s; nothing is lost.
**Overrun guard:** the ~1 s tick must **not stack** — skip a tick if the previous claim/POST batch is still running
(the jobs harness is otherwise run-once-return intervals; this is the first interval with real in-flight work).

**Service** (`service.ts`). `emit(teamId,type,accountId,data)` resolves the matching enabled endpoints (`events`
empty or contains `type`) and writes **all** their deliveries for one event in a **single multi-row INSERT**. Cap
intake concurrency (a bounded number of in-flight `emit()` inserts) so an upstream burst can't exhaust the shared
`pg.Pool` and starve the live proxy + dashboard.

**Event catalogue** (`contracts.ts`): `message.received`, `account.session_expired`, `webhook.test`, `upstream.*`.
Defined in P1a so the dashboard can list event types; in v1.0 only `webhook.test` is actually emitted (via `/test`),
the rest are emitted once P1b ships.

**Routes** (key or session; writes need write scope):
`GET/POST /v1/webhooks` · `GET /v1/webhooks/events` · `GET/PATCH/DELETE /v1/webhooks/:id` (enable clears breaker) ·
`POST /v1/webhooks/:id/test` (queues `webhook.test`) · `GET /v1/webhooks/:id/deliveries?status&event&cursor` ·
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` (new pending row, `replay_of` set).
(No route-ordering hack needed: `find-my-way` prioritises static routes over parametric ones regardless of
registration order, so `/v1/webhooks` beats `/v1/:account/*` either way.)

**Follow-ups (noted, not built in v1.0).**
- **SSRF DNS-rebinding TOCTOU.** The resolved-host check and the actual connect can resolve differently; pin the
  resolved IP for the real request, or accept the gap knowingly.
- **Breaker reset-on-2xx.** `consecutive_failures` resets on any single 2xx, so a *flapping* dead endpoint may never
  pause. Intended (only sustained failure pauses) — confirm.
- **Redeliver mints a new `webhook-id`** (new `whd_…`); it is **not** idempotent replay. Documented, by design.
- **`emit()` drops events for disabled endpoints** (nothing is queued while paused). Decide before P1b whether
  paused endpoints should queue instead.
- **No secret-rotation route.** Rotating a `whsec_` today means deleting and recreating the endpoint.
- **Retention has no `created_at`-only index** on `webhook_delivery`; the batched delete scans. Add one if volume
  makes it slow.

**Acceptance.**
```
pnpm db:generate && test -z "$(git status --porcelain apps/api/drizzle)"   # no drift (after regenerate)
pnpm --filter @gateway/api test                                            # new webhooks.test.ts green
# manual (ALLOW_HTTP_WEBHOOKS=true): run the receiver, create http://localhost:4100/hook
tsx apps/api/src/db/webhook-receiver.ts &                                  # :4100, verifies signature
curl -X POST .../v1/webhooks/$ID/test        # receiver logs "signature ok"
FAIL=1 restart receiver                       # attempts++ on completion; first retry ~30s (not the lease)
WEBHOOK_PAUSE_AFTER=3 WEBHOOK_MAX_ATTEMPTS=1   # pauses after 3 failed deliveries (the breaker counts exhausted deliveries)
curl -X POST .../v1/webhooks/$ID/deliveries/$D/redeliver   # new row, replay_of set, new webhook-id
```
Tests cover: signature round-trip (a Standard-Webhooks verifier accepts it), the backoff schedule (first retry 30 s),
the breaker, attempts counted on completion (a mid-flight crash doesn't burn an attempt), and two workers never
sending the same delivery twice.

**Depends on / merge.** First functional phase; lands the shared schema/env/contracts/job wiring. Merge **before**
the webhooks dashboard (P3) and before the v1.0 tag.

---

## Phase 2 — Dashboard depth (YAGNI-minimal)

**Objective.** Close the small gaps that make v1 coherent. Slices 3-5 already shipped log filtering
(`status|keyId|accountId|method|endpoint|q|cursor`), per-key usage (`GET /api/usage?groupBy=key`), and key
scope/allowlist editing (`PATCH /api/keys/:id`). So this phase **adds little and verifies the rest**.

**Owns.** `apps/web/src/routes/_app/{logs.index,keys}.tsx`, `apps/api/src/modules/logs/routes.ts` (query only).
Disjoint from P3 (P3 owns `modules/usage/routes.ts`; P2 does not touch it). Edits existing route components only, so
no new routes and no `routeTree.gen.ts` change.

**Changes.**
- **Log search.** Extend `q` so it also matches a `path`/`endpoint` substring (currently request-id only), keep it
  index-friendly (prefix match inside the bounded range). `method`/`endpoint`/`status`/`keyId`/`accountId` filters
  already ship, so this is the only log gap. As built, `q` is a substring (not prefix) match, since the
  `q=users/me` acceptance below can only match as a substring; a `req_…` value stays an id lookup.
- **Per-key usage link (web only).** From `keys.tsx`, link each key to `/usage?groupBy=key` (reuses the shipped
  `groupBy=key` aggregation; the user spots their key in the grouped table — no new endpoint, no `usage.tsx` change).
- **Verify (no build).** Key scope + account-allowlist editing already persists via `PATCH /api/keys/:id` (shipped
  edit dialog with the allowed-account picker); add a regression test if missing.

**Acceptance.**
```
curl -b jar ':4000/api/logs?q=users/me&limit=5' | jq '.items|length'      # matches by endpoint
curl -b jar ':4000/api/usage?groupBy=key' | jq '.rows[0].key'             # per-key rows
# UI: edit a key's scope+allowlist -> persists; key row links to its usage
```

**Depends on / merge.** Independent of P1a (file-disjoint; touches no shared hand-written file). Can develop in
parallel with P1a; in the stated order it merges **after** P1a, rebasing.

---

## Phase 3 — Webhooks dashboard + Home "needs attention"

**Objective.** Dashboard CRUD for endpoints and a deliveries view, and resurface a minimal attention list on Home
(plan.md §142-145) now that endpoints can be *paused*.

**Owns.** New: `apps/web/src/routes/_app/webhooks.index.tsx`, `apps/web/src/routes/_app/webhooks.$id.tsx`. Edit:
`apps/web/src/routes/_app.tsx` (the `nav` array: add `{to:'/webhooks',label:'Webhooks'}`),
`apps/web/src/routes/_app/index.tsx` (Home), `apps/web/src/lib/api.ts` (webhook query factories), and
`apps/api/src/modules/usage/routes.ts` (the `/overview` handler) + `contracts.ts` (serialised; rebases on P1a) to add
`pausedWebhooks` + the attention list. Generated (**never merged** — regenerate): `apps/web/src/routeTree.gen.ts`
(the two new webhook routes). Web files are disjoint from P2.

**UI / API.**
- `webhooks.index.tsx`: list with a health badge (ok / failing / paused), enable toggle, create/edit dialog
  (url, events multiselect from `GET /v1/webhooks/events`, reveal secret). Calls the P1a routes.
- `webhooks.$id.tsx`: deliveries table (status/event filters, cursor "load more"), payload drawer, **Redeliver**.
- `/api/overview`: add `pausedWebhooks` count and a `needsAttention` list (paused/failing endpoints). Home renders
  the list under the 3 KPI cards; keep it to that — no charts, no onboarding checklist (those stay cut, §7). (The
  upstream "event gap" indicator is a P1b add, post-1.0; v1.0 Home shows paused/failing endpoints only: there is no
  local accounts table, and Home must not block on the upstream `/v1/accounts` call, so `needsAttention` items are
  `kind: 'webhook'` only.)

**Acceptance.**
```
curl -b jar :4000/api/overview | jq '.pausedWebhooks, .needsAttention'   # present
# UI: Webhooks nav visible; create endpoint; pause it; Home lists it under "needs attention"
pnpm --filter @gateway/web typecheck
```

**Depends on / merge.** Needs P1a (routes + `webhook_endpoint` for the overview query). Merge after P1a, before
release.

---

## Phase 4 — Release polish for v1.0 (the tag)

**Objective.** The minimum to cut a clean public v1.0. Landing/README already done.

**Owns.** New: `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/{bug.md,feature.md}.yml`, `.github/pull_request_template.md`.
Edit: `apps/api/src/auth.ts` (two hardening fixes below), `package.json` version fields.

**Changes.**
- **Pre-1.0 hardening (review-mvp "Open (high)", small + required):** (a) block org writes in `hooks.before` and add
  a unique index on `member.user_id` so the session hook can't pick an arbitrary workspace; (b) create the workspace
  idempotently on first `loadSession` so a failed sign-up insert can't strand a user on `no_workspace`.
- **CHANGELOG.md** summarising v0.1 → v1.0.
- **Issue/PR templates.**
- **Naming / scrub — done, no longer a blocker.** The product name is **"Gateway"** and the brand scrub already
  landed (see recent `docs:` commits). `sh scripts/prepublish-check.sh` must still print "ok" as a guard, but naming
  is **not** a release blocker.
- **Tag + GitHub release:** set `apps/api` and `apps/web` versions to `1.0.0`, tag `v1.0.0`, draft a release from the
  CHANGELOG.

**Acceptance.**
```
sh scripts/prepublish-check.sh          # "pre-publish check: ok."
pnpm -r typecheck && pnpm -r test       # auth hardening tests green
```

**Depends on / merge.** Last before the tag. Merge after all tag-gating functional phases (P1a, P2, P3).

---

## After v1.0 (planned, not on the critical path)

These are planned but deliberately **after** the v1.0 tag — not cut (see §7 for what's cut entirely). **Nothing here
gates the tag.** They land once the tag is out and (for P1b) the real upstream is confirmed.

### Phase 1b — Upstream WebSocket event source (6b) — **off by default**

**Objective.** Turn opaque upstream events into deliveries via a single upstream WS, then `emit()`.

**Off by default.** The source runs **only when `UPSTREAM_WS_URL` is set**; default unset = **disabled**. The v1.0
tag must **not** be gated on this proving out against a real upstream.

**Owns.** New: `apps/api/src/modules/webhooks/event-source.ts`, a small mapping config
`apps/api/src/modules/webhooks/event-map.json`. Shared: `jobs/index.ts` (register the source under `RUN_JOBS`
**only when `UPSTREAM_WS_URL` is set**), `env.ts` (+`UPSTREAM_WS_URL`), plus the Home WS-status add noted below.
Depends on P1a's `webhook_endpoint` / `webhook_delivery` / `emit()` / dedup index.

**Lifecycle.** A **single long-lived, reconnecting** WS held by an **in-process singleton** — one socket per process,
gated by `RUN_JOBS`, **not** a DB lock. No duplicate sockets on reconnect, no leaked timers. Reconnect backoff
1 s → 60 s. (This is the jobs harness's first long-lived task; the harness is otherwise run-once-return intervals.)

**Auth.** The Node/undici global `WebSocket` cannot reliably send an `Authorization` header. Authenticate via
`Sec-WebSocket-Protocol: bearer.<UPSTREAM_TOKEN>` (**recommended**; keeps §2.5's no-new-dependency rule), pending
confirmation the real upstream accepts it (Q1). Alternative: add the `ws` dependency and strike the no-deps rule.

**Mapping.** Upstream event type → catalogue entry is a **small JSON/config value** (`event-map.json`), not
hardcoded: a chat/message event → `message.received`; an auth-expired signal → `account.session_expired`; anything
else → `upstream.<eventType>` (passthrough; do not enumerate platform events). Then `emit()` to **every** linked team
with a matching endpoint. List accounts via `upstream.listAccounts`, subscribe to new ones. The subscribe/message
frame shape is upstream-defined (Q1).

**Tenancy decision.** Under one shared `UPSTREAM_TOKEN` the event source fans **every account's** events to **every**
linked workspace, as stored, pushed deliveries. **Acceptable for a single-operator self-host** (the operator owns all
workspaces); multi-tenant scoping is **out of scope for v1** (also §2.4, Q1).

**Lossy-intake mitigations.** Record the **WS connected state + a last-event timestamp**; surface a **gap on Home**
when the socket is down or stale. When an upstream event carries a **stable id**, set `dedup_key` from it so the
unique `(endpoint_id, dedup_key)` index **dedups** across reconnects. `message.received` is **best-effort**
(at-most-once; possible duplicates across reconnects) — document this.

**Acceptance.**
```
# requires UPSTREAM_WS_URL set; default-unset path stays disabled
UPSTREAM_WS_URL=ws://localhost:4200/ws RUN_JOBS=1 tsx ...   # source connects
# fake-upstream /ws emits one event -> a message.received delivery arrives
# kill + restart the socket -> no duplicate socket; a stable-id event dedups (unique index)
# Home shows WS connected + last-event age; a gap is visible when the socket is down
```

### Phase 5 — Gateway-side connect contract (cut from v1.0)

**Cut from v1.0 entirely.** Reason: operator `link-team` already gates upstream access; the private client that would
use this token lives in the user's **private repo**; it adds a **second hand-rolled auth path** and a token-storage
attack surface for **zero v1 benefit**. Kept here as a post-1.0 plan.

**Objective.** The gateway's **public** contract for attaching a pairing client to a workspace: issue/rotate a
per-workspace connect token and read connection status.

**BOUNDARY (hard).** The browser-extension **session capture** and the **account/stream pairing internals** live in
the user's **private repo** and are **out of this plan**. The gateway stores only a connection record + a token hash;
it never sees, stores, or defines a platform session or pairing payload. The upstream stays opaque. The gateway→
upstream data path still uses the single operator `UPSTREAM_TOKEN`; the connect token authenticates the *private
client to the gateway*, not the gateway to the upstream. This phase stops at the handshake.

**Owns.** New: `apps/api/src/modules/connect/{routes,service}.ts`, optional `apps/web/src/routes/_app/settings.tsx`
edit (show status + "generate token"). Shared: `db/schema.ts` (+1 table), `contracts.ts`, `app.ts` (mount). Rebases
on P1a's schema/env. No new env.

**Schema.** `workspace_connection`: team_id PK FK cascade, status (`unconfigured`|`connected`|`error`), token_hash
(sha256 hex, unique) null, token_start null, token_rotated_at null, last_seen_at null, last_error null, updated_at.
(`team_backend` stays the operator approval gate; this table only tracks the pairing client's attachment + health.)

**Routes.**
- `POST /api/connect/token` (session, write): mint/rotate; returns the secret once (prefix `gwc_`); invalidates the old.
- `DELETE /api/connect/token` (session): revoke.
- `GET /api/connect` (session): `{status, tokenStart, lastSeenAt, lastError}`.
- `POST /connect/heartbeat` (mounted at root with its own `authenticateConnect` guard that looks up
  `workspace_connection.token_hash` — **not** the `/v1` key/session `authenticate` hook, which expects a `gk_` key):
  the one surface the private client calls — flips status to `connected`, stamps `last_seen_at`. It accepts a
  heartbeat only; event/session push and pairing are **not** defined here.

**Acceptance.**
```
curl -b jar -X POST :4000/api/connect/token | jq -r .secret      # gwc_… once
curl -H "Authorization: Bearer gwc_…" -X POST :4000/connect/heartbeat   # 204
curl -b jar :4000/api/connect | jq '.status, .lastSeenAt'        # connected, timestamp
# rotate -> old token heartbeat returns 401
```

**Depends on / merge.** After the v1.0 tag, after P1a (shared schema/env). Only if/when the private pairing client is
ready.

---

## 5. Env additions (append to `env.ts` + `.env.example`; `hygiene.test.ts` checks they match)

| Var | Default | Phase |
|---|---|---|
| `ALLOW_HTTP_WEBHOOKS` | `false` | 1a |
| `WEBHOOK_MAX_ATTEMPTS` | `6` | 1a |
| `WEBHOOK_PAUSE_AFTER` | `20` | 1a |
| `WEBHOOK_RETENTION_DAYS` | `7` | 1a |
| `UPSTREAM_WS_URL` | *unset = event source disabled* | 1b (after v1.0) |

`RUN_JOBS` (exists) now also gates the webhook worker (P1a) and — only when `UPSTREAM_WS_URL` is set — the event
source (P1b). The connect contract (P5) needs no new env.

## 6. Workstreams & merge order

| Wave | Phase | Persona | Owns |
|---|---|---|---|
| A | P1a webhooks delivery engine+API | implementer (opus/high) | `modules/webhooks/{routes,service,worker}.ts`, `lib/signature.ts`, webhook-receiver, +shared schema/env/contracts/jobs/app |
| A | P2 dashboard depth | implementer | web `{logs.index,keys}.tsx` + `modules/logs/routes.ts` query |
| B | P3 webhooks dashboard + Home | implementer | web `webhooks.*`, `_app.tsx` nav, `index.tsx`, `lib/api.ts`, `routeTree.gen.ts` (regen), `modules/usage/routes.ts` (overview) + `contracts.ts` |
| C | P4 release polish | implementer | CHANGELOG, `.github/**`, `auth.ts`, version/tag |
| after tag | P1b event source | implementer | `modules/webhooks/event-source.ts`, `event-map.json`, `UPSTREAM_WS_URL`, Home WS-status |
| after tag | P5 connect contract | implementer | `modules/connect/**`, `workspace_connection`, settings UI |

**Merge order: P1a → P2 → P3 → P4 (v1.0 tag). Then P1b and P5 after the tag.** P1a first (it lands the shared
schema/env/contracts/job wiring). P2 (dashboard depth) is **genuinely disjoint** and may run in parallel with P1a.
P3 (webhooks dashboard) **rebases on P1a** (routes + schema). P4 is last before the tag.

**Shared files are not "disjoint" — they are serialised.** The hand-written shared files `schema.ts`,
`contracts.ts`, `env.ts` (and `app.ts`, `jobs/index.ts`) are **not** split cleanly across branches; each phase
**rebases on the prior** so there is one writer at a time. The merge order keeps them conflict-free, exactly like
plan-v2's WS3-first rule.

**Generated files are NEVER merged across branches.** The drizzle **migration files** + `apps/api/drizzle/meta/_journal.json`
+ the **snapshots**, and `apps/web/src/routeTree.gen.ts`, are not hand-merged. Whichever phase lands last on that area
**rebases, deletes the generated artifacts, then regenerates** them (`pnpm db:generate` / the web route generator).
The drizzle **no-drift acceptance check runs AFTER that regenerate**, not before.

## 7. Cut from v1 (YAGNI) — and why

- **Per-attempt delivery history.** The `webhook_delivery` row carries `attempts` + `last_*`; a per-attempt table is
  not needed to retry, show health, or redeliver. (Already parked in plan.md §8.)
- **Encrypting webhook secrets.** Signing needs the plaintext; a single-operator VPS already holds `UPSTREAM_TOKEN`.
  Encryption adds key management for no v1 threat reduction. (Parked; Q2.)
- **Rich typed `realtime.*`/platform event enumeration.** Kept as opaque `upstream.*` passthrough — enumerating
  platform events couples the OSS repo to a reverse-engineered API and dates fast.
- **Per-workspace upstream WS.** Collapses to one WS under the single-token tenant model (§2.4); per-workspace
  sockets would be dead weight until multi-tenant upstream auth exists.
- **Team invites / members page / team deletion, quotas, credits/billing.** Out of the single-workspace, no-billing
  model already chosen in the amendment; adding them means auth + schema churn with no v1 user.
- **Usage rollup job, schema-driven playground, Home charts/onboarding checklist.** Already cut in the amendment;
  not reintroduced. (Home gains only the paused-webhook attention list.)
- **GHCR image + release automation, multi-instance/HA worker, and the Postgres advisory lock.** The lock is removed
  outright: `pg_try_advisory_lock` is **session-scoped** and cannot work over the pooled connection (`db/index.ts`
  uses `pg.Pool`), and its only job was the multi-instance HA this bullet cuts. `SELECT … FOR UPDATE SKIP LOCKED`
  already makes delivery safe for N workers; the single P1b socket uses an in-process singleton, not a DB lock. One
  worker + a manual `v1.0.0` tag are enough for a self-hosted VPS; registry/tags/CI publishing are post-1.0 if update
  speed hurts.
- **Dashboard connect-account wizard, opaque `acct_` ids, reference-shaped routes.** Parked; accounts still connect
  through the (private) pairing client. The connect contract (P5) is deferred past the tag.

## 8. Open questions (need the user)

1. **Upstream `/ws`: auth + frame shape + one-token fan-out — blocks P1b only, not the tag.** Confirm the real
   upstream accepts `Sec-WebSocket-Protocol: bearer.<UPSTREAM_TOKEN>` (else P1b adds the `ws` dep, §2.5); confirm the
   subscribe/message frame shape (the test fake defines its own — map via `event-map.json` if it varies); and confirm
   it is acceptable that, under one `UPSTREAM_TOKEN`, every linked workspace receives all upstream account events
   (the single-tenant model, §2.4). None of this gates the v1.0 tag.
2. **Plaintext webhook secrets** acceptable for v1.0? (Needed for signing; encryption parked, §7.)
3. **Standard Webhooks signature encoding.** Confirm we follow the spec (base64 secret, `v1,<sig>`) so an
   off-the-shelf SW verifier library accepts our deliveries.

*(Resolved: the product name is **"Gateway"** and the brand scrub is already done — naming is no longer a release
blocker. The connect contract is cut from v1.0, so "is it needed for the tag?" is moot — it ships post-1.0 only if
the private client is ready.)*

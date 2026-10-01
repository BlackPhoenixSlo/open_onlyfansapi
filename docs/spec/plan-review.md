# Plan review: the devil's advocate case against `plan.md`

- **Date:** 2026-10-01.
- **Method:** read the backend code (read-only), ran a proxy-path test on Fastify 5.12.5, got a second opinion from Codex, and checked DNS and the web for the name.
- **Format:** each item gives the claim, then the problem, then the **fix**.
- **Verdict:** the plan's shape is sound: one process, Postgres only, `/v1` shared by keys and the dashboard, and slices that can be tested on their own. Three things block building or publishing, a dozen are cheap plan edits, and about a quarter of the scope can be cut.

## Blocking

1. **"`/v1/{account}/<rest>` is a raw passthrough to `/of/<rest>`" (§1, slice 2). This lets callers escape the proxy, and I reproduced it.**
   - Fastify decodes `%2F` into the wildcard param. `GET /v1/12/..%2fof-accounts` gives `rest="../of-accounts"`. `new URL('/of/'+rest, BACKEND_URL)` then resolves the path to `/of-accounts`. `/v1/12/users%2F..%2F..%2Fof-accounts` does the same.
   - Account `12` passes the `^\d+$` check and the allowlist. The request then reaches **any** backend route with an owner JWT: `/of-accounts/:id/session-cookie`, `DELETE /of-accounts/:id`, `/automations/*`, and so on.
   - That bypasses both the key's scope and its account allowlist.
   - **Fix:**
     - Build the upstream path from the raw `request.url`, not the decoded param.
     - Reject any segment that decodes to `.` or `..`, and any `%2f`, `%5c` or `\`.
     - After building the URL, assert that `url.origin === BACKEND_URL` and that `url.pathname.startsWith('/of/')`.
     - Add these URLs to the slice-2 verify list as proxy tests.
2. **"Fanrelay: no software with this name" (§9). This is false, and the name is in the same market.**
   - `fanrelay.com` and `fanrelay.io` (the `.io` was registered 2026-08-11, and both were updated 2026-09-27) serve a "Join Fan Relay" waitlist. Its tagline is "a direct, noise-free connection between entertainers and their fans".
   - The name gets baked into the key prefix `frk_`, the webhook secret prefix `frwh_` and the `fanrelay-*` headers. Renaming after slice 2 or slice 6 is a breaking change.
   - **Fix:** pick the name before slice 2. Make the wire format name-independent:
     - Key prefixes: `sk_` and `whsec_`.
     - Webhooks: the **Standard Webhooks** headers (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`). Verify libraries already exist for most languages, so `docs/webhooks.md` shrinks to a link.
     - Status of the alternatives: `fanplane.com` is parked, `.dev` and `.io` don't resolve, and `github.com/fanplane` is taken.
3. **Publishing on GitHub as planned exposes you to trademark and copyright claims.**
   - The working name `gateway` contains a Fenix International trademark.
   - `docs/spec/pages.md` and `endpoints.md` inventory a competitor's dashboard and the platform's reverse-engineered endpoints.
   - **Fix:** keep "OnlyFans" out of the repo, package and product names. Keep `docs/spec/{pages,endpoints,mapping}.md` and this file out of the public repo (private repo or `.gitignore`), and never move the signing logic or `endpoints.json` in.
   - Add a NOTICE: unofficial, not affiliated with or endorsed by Fenix International, users must comply with the platform's terms.

## Should fix before slice 1 (plan edits)

1. **"We mint like the e2e script, so no backend change is needed" (§1).** This works, but the details matter. The e2e script calls `app.jwt.sign` in-process with a 7-day default (`scripts/automation-api-e2e.ts:25-27`).
   - `sub` must be a **number** (`auth.ts:49`).
   - Never include `employeeId`, which switches to the employee path (`auth.ts:124`).
   - Include `iat`, otherwise the backend's "revoke all" check (`rv:<userId>`) is skipped.
   - **Fix:** mint exactly `{sub:<int>, iat, exp:+5m}`. On an upstream `TOKEN_*` error, drop the cached token and re-mint once.
2. **Blast radius of `BACKEND_JWT_SECRET` (R2).** The secret can mint tokens for *any* user, including platform admins, because `isPlatformAdmin` is read from the DB. Backend refresh tokens also work as access tokens. A gateway compromise therefore means a full backend compromise.
   - **Fix:** accept this for the MVP but document it in SECURITY.md. Make an `aud:"gateway"` claim, accepted only on `/of`, `GET /of-accounts` and `/ws`, the first backend change after the MVP.
   - Note that the backend's `JWT_SECRET` falls back to its `BETTER_AUTH_SECRET`. The env comment should say which value to copy.
3. **"Rename the organization model to `team`" (§2.3).**
   - The org plugin already has its own nested `team` model, so the names collide.
   - `modelName` doesn't rename the client methods, `activeOrganizationId` or the `organizationId` FKs.
   - **Fix:** keep better-auth's default names in the DB and code, and say "team" only in the UI.
   - Generate the auth schema into its own file, `db/auth-schema.ts` (`@better-auth/cli generate`). Re-export it from `schema.ts`, then run `drizzle-kit generate`. Pin the better-auth version.
   - `activeOrganizationId` is null right after sign-up. Auto-create a team and set it active in a sign-up hook.
4. **"`x-dashboard: 1` is the CSRF guard" (§2.2). It is specified only for `/v1`.**
   - `POST /api/keys` is cookie-authenticated and returns a secret.
   - SameSite=Lax still sends cookies from sibling subdomains.
   - **Fix:** add one global hook. If a request is authenticated by session and the method is not GET or HEAD, require `Origin === APP_URL` and the header. Never register CORS with credentials.
5. **"Account allowlist restricts a key" (slice 2). Webhooks ignore the allowlist.**
   - A key limited to account 12 can create an endpoint and receive DMs from every account.
   - It can also read the delivery payloads.
   - **Fix:** for the MVP, return 403 on `/v1/webhooks*` to keys with `allowed_account_ids` set.
6. **"`GET /v1/accounts` = backend `/of-accounts`".** The backend returns full rows, including `egressPort`, `agencyId` and `createdByUserId` (`of-accounts.controller.ts:7-22`).
   - **Fix:** return only `{id, label, ofUsername, ofDisplayName, ofAvatarUrl, status}`.
   - Status is `pending|active|expired|disconnected`.
7. **"Store redacted, truncated response bodies for 14 days" (slice 3).** These bodies are fans' DMs, earnings and payout or bank data.
   - A key-name regex can't redact message text.
   - `code$` also masks `countryCode`.
   - Query strings are stored unredacted.
   - **Fix:**
     - Always store request bodies, redacted.
     - Store response bodies only when status ≥ 400, with `LOG_RESPONSE_BODIES=false` as the default.
     - Redact query keys too.
     - Redact the parsed JSON first and truncate afterwards.
8. **"HTTPS-only webhook URLs" (slice 6). This does not prevent SSRF.** An HTTPS URL can still point at internal hosts, the metadata IP, or a DNS-rebinding domain.
   - **Fix:**
     - Use an undici `Agent` whose `connect.lookup` rejects loopback, RFC1918, link-local, CGNAT and ULA addresses at connect time. This also covers DNS rebinding.
     - Reject URLs with userinfo, and keep `redirect:'manual'`.
     - Allow private targets only behind an `ALLOW_PRIVATE_WEBHOOKS` dev flag.
     - Store error strings in `last_error`, never response bodies.
9. **"`SELECT … FOR UPDATE SKIP LOCKED`, then POST each" (slice 6).**
   - Outside a transaction, the locks vanish when the SELECT finishes.
   - Inside one, a pool connection stays pinned for up to 20 × 10 s.
   - **Fix:** claim with a lease: `UPDATE webhook_delivery SET next_attempt_at=now()+'60 s' WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING *`. Send after the commit; a crash means a retry after 60 s.
   - Document at-least-once delivery, with receivers deduplicating on `webhook-id`.
   - Change the test from "never twice" to "never concurrently".
10. **"The event source holds `pg_try_advisory_lock`".** With a `pg` Pool, the lock lives on whichever pooled connection took it. Idle recycling releases it silently.
    - **Fix:** drop the lock. "`RUN_JOBS=true` on exactly one instance" is the MVP rule, and that env var already exists.
11. **Upstream 401 and 403 pass through unchanged.** A rejected minted JWT, a blocked owner, or a linked user with no agency (403) all look to the client like "your API key is bad".
    - **Fix:**
      - If the upstream body is the backend's own error shape (`{error:"TOKEN_*"}` or the agency 403), return 502 `backend_auth_failed`.
      - `link-team` should verify the link by calling `/of-accounts` with a minted token.
12. **"Test DB truncated per file" (§7).**
    - vitest runs files in parallel, so truncating one shared DB makes tests flaky.
    - `docker/initdb` runs only when the volume is first created.
    - **Fix:** set `fileParallelism:false`, and create `gateway_test` in globalSetup if it is missing (ignore error 42P04).
13. **Env gaps in `.env.example`.**
    - **Fix:** add `BETTER_AUTH_URL` (better-auth's baseURL), `NODE_ENV`, `LOG_LEVEL` and `TRUST_PROXY`. Without `TRUST_PROXY`, `request_log.ip` is the reverse proxy's IP.
14. **Licence (R6).** The licence choice doesn't reduce the ToS or trademark risk; the NOTICE in Blocking 3 does that.
    - **Recommendation:** **AGPL-3.0** if a hosted offering is ever planned. In an API-reseller market, a closed hosted fork is the realistic threat.
    - Use Apache-2.0 instead if the goal is adoption or a portfolio piece. Its §6 explicitly withholds trademark rights. Avoid bare MIT here.

## Nice to have

- **One request id everywhere.** Set `genReqId: () => newId('req')` so the pino logs, `x-request-id`, the error `requestId` and `request_log.id` are the same value. Stop forwarding `x-request-id`: the backend ignores it (verified).
- **SPA fallback.** Serve `index.html` only for GET requests with `accept: text/html` that are outside `/v1`, `/api`, `/openapi.json` and `/docs`. Otherwise unknown API paths return 200 HTML.
- **Per-key rate limit.** All gateway traffic shares the backend's single 300/min IP bucket, and the gateway's own `/of-accounts` calls draw from it too. Register `@fastify/rate-limit` on `/v1`, keyed by `keyId ?? userId` (about 5 lines).
- **Event source cost.** The first `v2.subscribe` for an account starts a real OnlyFans socket in ws-relay (5-minute lease, 45 s grace period) and feeds the automation transcript cache. Subscribe only for accounts that an enabled endpoint actually wants events for.
- **OpenAPI merge (slice 5).**
  - The backend document has no securityScheme and doesn't declare `x-of-proxy-account-id`.
  - The same document also lists non-`of-api` internal and admin routes.
  - Filter by tag, add the `account` param and bearer security.
  - Prefix the backend's `components.schemas` and rewrite its `$ref`s, because both documents come from `@fastify/swagger`.
- **Body handling.** Capture the request body in `preHandler` or `onResponse`, not `onRequest`. `onSend` payloads can be a string, a Buffer or null. Re-stringifying the parsed body is fine, because the backend rebuilds bodies anyway (verified).
- **Webhook secret reveal.** Return the secret only on create and from an explicit session-only `POST …/secret`, not on `GET`. Otherwise any read key can read it.
- **Time-sortable ids.** Use UUIDv7 or ULID-based ids so `req_` ids sort by time and cursors can be id-only. Endpoint normalisation will let username segments explode cardinality; later, normalise against the backend's spec templates.

## Cut from the MVP

Cutting these keeps keys, logs, usage, playground and webhooks intact. Gateway throughput is **hard-capped at 300 req/min** by the backend, which makes most scale machinery moot.

- **`usage_daily`, the rollup job, its CLI and the idempotency test.** Serve `/api/usage` with `GROUP BY date_trunc('day', created_at)` over `request_log`, within the 14-day retention. Add rollups when Usage needs data older than retention.
- **Log writer batching (1 s or 500 rows).** Use one un-awaited insert in `onResponse` instead. At 5 req/s or less, batching is premature.
- **Multi-instance goals.** Drop the advisory lock and the "safe on several instances" wording; SKIP LOCKED stays, because it costs nothing.
- **Invitations, `/team`, member removal, team switching, typed-confirm delete.** Create one team per user at sign-up and keep `team_id` scoping. Linking is CLI-only, so a second member adds nothing to the five features.
- **Circuit breaker** (`consecutive_failures`, `paused_reason`, `WEBHOOK_PAUSE_AFTER`, the paused badges and the Home "paused" list). Max attempts per delivery plus the manual enable toggle are enough.
- **`realtime.<eventType>` catch-all.** For non-message frames, the eventType is the raw first top-level OnlyFans key (`ws-relay/src/relay/upstream.ts:374`); shipping it makes platform internals a public contract. Ship only `message.received`, `account.session_expired` and `webhook.test`.
- **`packages/shared`** (a single file). The web app reads `GET /v1/webhooks/events`.
- **Playground extras.** Drop the schema-seeded bodies and the raw-path-to-template matching. Use a body textarea, plus the example if one exists. Log rows already store `endpoint`, so pass `op` in the URL.
- **Smaller UI items.** Drop `GET /api/overview`, the onboarding checklist and the CSV export. Home reuses `/api/usage` and `/v1/accounts`.

## Verified as correct (backend code, `fastify/src`)

- **The minted token passes auth.** An HS256 `{sub:<int>,iat,exp}` token passes `authenticate` (`@fastify/jwt` 10 on `fast-jwt` 6, no iss, aud or typ). It needs a `users` row that isn't `blocked`; the agency comes from `agencies.ownerUserId` (`plugins/auth.ts:124-174`).
- **The owner passes `isAgencyMember`.** It only checks `user.agencyId` (`agency-scope.ts:10-14`). There is no plan or benefit gate on `/of`, and the owner passes the DELETE policy (`of-api/policy.ts:17-25`).
- **The account header behaves as claimed.** `x-of-proxy-account-id` is required and parsed with lenient `parseInt`, so the gateway's `^\d+$` check is stricter. For owners, `requireAccessibleAccount` is an agency check only.
- **`GET /docs/json` is public**, with no NODE_ENV check (`app.ts:107-122`). It has about 274 `of-api` ops (154 GET, 57 POST, 12 PUT, 11 PATCH, 38 DELETE), so the "≥ 270" verify target holds.
- **`/ws` matches the plan.** Auth is `Sec-WebSocket-Protocol: bearer.<jwt>` (`ws.routes.ts:17-35`). The client sends `{type:"v2.subscribe",accountId}`; the server sends `v2.realtime.event{accountId,eventType,data}` and `v2.realtime.status{accountId,state}`.
  - The chat eventType is `realtime.chat_message.received` (the plan's mapping is right), `auth_failed` is a state, and the JWT isn't re-checked on an open socket, so a 5-minute token is fine.
- **Rate limit.** 300/min, keyed by `request.ip`, with no `trustProxy`; only `/ws` is allow-listed (`app.ts:127-135`).
- **Routing.** Static `/v1/whoami` beats `/v1/:account/*` (tested). An unmatched `/v1/webhooks/x/y` falls through to the proxy, where `^\d+$` returns 404.
- **Proxy response handling.** The backend doesn't compress, so buffered native fetch and dropping `content-encoding` and `content-length` are correct.
- **Key hashing.** sha256 is enough for 32-character base62 keys.

## Six thinking hats

- **Facts (white):** minted owner tokens work, there are about 274 ops, throughput is capped at 300 req/min, and the name is taken in the same niche.
- **Risks (black):** the proxy escape; the shared secret gives full backend access, including admin; fans' DMs in the logs; trademark and copyright exposure on the first public push.
- **Benefits (yellow):** the stack matches the backend so modules can move there later, there is no Redis, the dashboard reuses `/v1`, and each slice can be tested on its own.
- **Feelings (red):** the open-source gateway is useless without the private OnlyStack backend. "Open source" with no self-host story may disappoint early GitHub visitors, so decide what the public repo is for.
- **Creativity (green):** Standard Webhooks headers; usage computed straight from `request_log`; a backend `aud:"gateway"` claim as the long-term replacement for the shared secret.
- **Process (blue):** apply Blocking 1–3 and the cuts to `plan.md`, add the traversal URLs to the slice-2 tests, settle the name and licence before the first push, then build slice 1.

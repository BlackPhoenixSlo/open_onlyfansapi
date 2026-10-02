# Plan v5: onlyfansapi.com parity — webhooks, raw passthrough, named routes

Build plan after plan-v4 (merged to master and pushed, f6bed98), for Opus implementer agents in parallel git
worktrees. Goal: a client written for onlyfansapi.com works against this gateway by changing the base URL, key and
account id, **except for the known gaps listed below**. v5 delivers (A) **webhook parity** (their event names,
envelope, payload shapes, signature), (B) a **raw passthrough** that reaches every OF call before its named route
ships, and (C) **named-route parity** for the chats, fans and money groups, measured by a **parity audit** that CI
enforces. v5 ships as **v2.0.0** (breaking, §1.8). Principle: **YAGNI**. The cuts and the reasons for them are in
§8; the content, promo and settings waves are deferred to plan-v6.

**Known gaps after v5** (a client written for onlyfansapi.com hits these):
- Media and story uploads (and the `media_uploads.*` events). The passthrough cannot do them either.
- Their connect flow (`authenticate/*`). Sessions are added only with the operator's `connect.py`.
- `acct_…` account ids. Ours are numeric OF user ids.
- Error bodies, which keep our shapes.
- Team-level routes (`/v1/whoami`, `/v1/accounts`, `/v1/webhooks*`), which keep their unwrapped v4 shapes.
- `analytics/*`. `/v1/stats` is the nearest equivalent.
- Content, promo and settings named routes (deferred to plan-v6) and the 10 `deferred-write` rows of Phases 2–4.
  They are reachable only through the passthrough, in OF's own paths and shapes.
- The rest of §8: `_meta` contents, webhook endpoint options, key `permission_level` and `account_scope`,
  poll-derived events, and the events marked *TBC* or *never* (§1.12).

**Canonical inventory:** `docs/spec/plan-v5-inventory.md` holds the per-route and per-event parity tables and the
signing comparison (Section D). This plan does not repeat those tables. Where this plan and the inventory give
different counts, the inventory's count is the correct one.

**Overrides** plan-v4 §1.6 (upstream `/of/<tail>` mirrored OF's `/api2/v2/<tail>`; it now mirrors onlyfansapi's
tail), the three plan-v4 §2.1 paths that differ (§1.1), §2.3 event names and `data` shapes, §2.4 "client frames are
`envelope(e)`" (still true, but the envelope changes), docs/webhooks.md's Standard Webhooks signing, and plan-v4 §8's
"generic `/of/*` curl-through" and "more v2 handlers on demand" cuts. Where this plan says nothing, plan-v4 applies.

## 0. Baseline (2026-10-02, master f6bed98)

- **Gateway surface.** The gateway defines these routes itself: `GET /v1/whoami`, `GET /v1/accounts`, nine
  `/v1/webhooks…` routes, `GET /v1/stats` and `GET /v1/ws`. Every other `/v1/{account}/…` request is handled by one
  catch-all route, `ALL /v1/:account/*` (`modules/proxy/routes.ts`), which forwards to upstream `/of/*`, reads the
  account from `x-of-proxy-account-id`, and lets through only an allow-listed set of request and response headers.
  So **per-account parity work happens only in `services/upstream/`**, and Fastify's route tree cannot see those
  routes. `/openapi.json` already merges the upstream's `of-api` operations as `/v1/{account}/…`.
- **Upstream `/of` operations: 8** (`users/me`, `chats`, `chats/{chatId}/messages` GET and POST, `posts`,
  `posts/{postId}`, `vault/media`, `vault/media/{mediaId}`). Each returns OF's body unchanged. `OFClient` has about
  170 single-call methods plus `request(method, path_or_url, json_body, params)`. `_build_url` also accepts absolute
  URLs, which matters for the passthrough (§2.1). The upstream has no `_of` route and no generic forwarder. The
  gateway already forwards `/v1/{account}/_of/…` to upstream `/of/_of/…`, where it gets a 404 today.
- **Webhooks.** The envelope is `{id,type,createdAt,accountId,data}`. Deliveries use Standard Webhooks signing:
  `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, `v1,` + base64 HMAC-SHA256 over `id.ts.body`,
  with the key being the base64-decoded part of `whsec_…`. The catalogue has 11 entries. The upstream emits
  `message.received`, `message.sent`, `post.expired` and `account.session_expired`; the gateway emits `webhook.test`
  and `upstream.*`; the 5 other entries are TBC (plan-v4 §9 Q1). Client WS frames are the same envelope. The ledger
  (`event.type`) stores the type names, and `ingest.ts` reads `data.amountCents`.
- **Keys.** `gk_` keys have scope `read|write` (`read` = GET/HEAD only) and an optional `allowedAccountIds`. The
  allowlist corresponds to their `account_scope: inclusive`; `null` corresponds to their `global`.
- **Theirs** (route table in the mirror, 2026-10-02): **445** routes under `api/` and **236** per-account routes,
  including the raw passthrough `_of/{path?}`, spread over 34 per-account groups. The yaml has 225 paths. The webhook
  catalogue has 34 events. Responses are `{data, _pagination?, _meta}`. Deliveries look like
  `{"event","account_id","payload"}` with one `Signature` header.
- **Parity today** (inventory, Counts section):
  - **In scope, theirs:** 265 rows. 233 are per-account named routes (235 minus the 2 AI fan-summary routes; `_of`
    is excluded) and 32 are non-account routes.
  - **Ours:** 21 public routes, of which 13 are named `/v1` routes and 8 are upstream `/of` routes.
  - **Matched: 18.** 1 *have* (`DELETE /v1/webhooks/:id`) and 17 *partial*, 8 of which are per-account. Every per-account
    match is partial only because their responses are wrapped in `{data, _meta, _pagination?}`. On path, 5 of our 8
    already match; `me`, `media/vault` and `media/vault/{media_id}` also differ in path.
  - **Missing: 247** (225 per-account, 22 non-account). For **96** of these, `OFClient` already has the method; it is
    just not exposed as a route.
- **v5 target** (inventory section A rows, grouped by first path segment): Phases 2–4 cover 104 of the 233
  per-account rows. 94 of them ship (4 already exist from v4) and 10 are `deferred-write`. With the 4 v4 content
  rows, 98 rows are *have* after v5. The other 125 rows (content, promo, settings) are deferred to plan-v6.
- **Events today** (inventory): 34 OF events are documented and 26 are in scope. 3 are *partial*
  (`messages.received`, `messages.sent` and `accounts.session_expired`, which we emit under v4 names with smaller
  payloads). 5 are in our catalogue but never emitted (tip, PPV unlock, 3 subscription events). 18 have no
  counterpart. The signing scheme does not match (inventory Section D).

## 1. Decisions

1. **Path convention.** `/v1/{account}/<tail>` mirrors their `api/{account}/<tail>`. The upstream serves
   `/of/<tail>` with **their** tail, not OF's. `{account}` stays our numeric OF user id; we do not adopt their
   `acct_…` ids. The three v4 routes that differ are renamed **without aliases**. v4 is pushed (`origin/master` =
   f6bed98) and one friend runs a deploy from the private repo, so this is one of the v2.0.0 breaks (§1.8).
   `/v1/{account}/_of/users/me` still returns OF's own shape.
2. **The route table wins for paths, the yaml for bodies** (owner). Every mirror page embeds the full Laravel route
   table in `props.ziggy.routes`. Where it and the yaml differ, use the table for the method and URI and the yaml for
   request and response bodies. The audit and the inventory are both built from the table. Route **names** are often
   opaque (`api.generated::…`), so matching uses `METHOD uri` only.
3. **The passthrough is not counted** (owner). `_of/{path?}` ships first, in P1b0, and the audit counts named routes
   only.
4. **Response wrapper `{data, _meta, _pagination?}`.** The wrapper is applied once, in the gateway proxy (§2.2), so
   that a named route that matches on method and path also matches on response shape. That turns the 8 per-account
   *partials* into *have* in Phase 1. The audit checks methods and paths; `of_fake` contract tests check shapes (§7).
   - `_meta` is `{}`. Their fields are `_credits` and `_cache` (billing) and `_rate_limits`; our limiter does not
     expose the remaining count, and the per-minute limit is documented.
   - `_pagination` is `{"next_page": "<absolute URL>"}` (the yaml's key, inventory D.4), added only when the
     upstream marks a next page.
   - Error bodies keep our shapes.
   - The passthrough is never wrapped.
   - The gateway's own team-level routes keep their v4 shapes (§8).
5. **Webhook envelope and payloads** (owner). The body is `{"event","account_id","payload"}`. Payloads follow
   `props.examplePayloads` from the mirror's `team/<team>/webhooks.html`. `account_id` is our id as a **JSON
   string**, which is their type, and it is omitted for events that have no account. Client WS frames use the same
   envelope, so there is still one `envelope()`.
6. **Event names: adopt theirs, hard switch, no alias table** (owner, decided). v4 is pushed and one friend's deploy
   runs it, so this is a v2.0.0 break (§1.8). The Phase 1 migration renames stored endpoint filters and ledger rows,
   and drops pending v4 deliveries (§2.4). `post.expired` has no equivalent on their side and becomes
   `posts.expired`, our extension in their naming style. `webhook.test` and `upstream.*` stay.
7. **Signing: switch.** Inventory Section D gives the verdict **MISMATCH**. Their scheme is a `Signature` header
   carrying lowercase hex HMAC-SHA256 of the raw body, keyed with the subscriber's secret, with no timestamp, and
   sent only when a secret is set. Ours is Standard Webhooks.
   - *Branch K (keep; does not apply):* if the schemes had matched, nothing would change apart from the header name.
   - *Branch S (applies):* replace `sign`, `signatureHeaders` and `verifySignature` with their scheme (§2.3). Every
     endpoint of ours has a secret, so `Signature` is always sent.
8. **Hard cut, released as v2.0.0** (owner, decided). No versioned envelope, compat flag, alias map or dual signing.
   The breaks are the envelope, the `Signature` header, plural event names, the three path renames (§1.1) and the
   response wrapper (§1.4). The compat path is the §2.4 migration plus a `CHANGELOG.md` 2.0.0 entry with an
   "Upgrading to 2.0" section. That section lists every break and says that the gateway and upstream images must be
   upgraded together: the gateway drops frame types it does not know (ingest.ts:47), so a mixed pair loses the
   renamed events. docs/webhooks.md links to it.
9. **The upstream shapes events** (extends v4 §1.4). `events.py` builds their payloads. The §2.2 frame gains a
   top-level `amount_cents`, so the gateway never parses a payload.
10. **One upstream route module per group.** Each wave owns `services/upstream/routes/<module>.py`; Phase 1 creates
    the package, the stubs and the include list. Waves call existing `OFClient` methods or
    `client.request_json(method, f"{API_BASE}/…")`. Waves never edit `of_client.py`, `app.py` or `conftest.py`.
11. **The audit reads the upstream's OpenAPI, not Fastify's route tree.** Fastify sees one wildcard for every
    per-account route, so neither `printRoutes` nor a `/__routes` endpoint can list them. FastAPI's `app.openapi()`
    can be dumped without a server or a database. Team-level parity is tracked in the inventory and is not gated.
12. **The catalogue accepts every in-scope event name of theirs.** Each one is marked *emitted*, *TBC* (the OF
    source is known but needs a captured frame or a poller; §9 Q1–Q2) or *never* (no source in a self-hosted
    gateway). This means a subscription copied from onlyfansapi validates, and does not get a 400.

## 2. Contracts (every phase codes against these)

### 2.1 Raw passthrough `ANY /v1/{account}/_of/{path}`
- **Gateway:** no new route. The existing catch-all forwards `/v1/{account}/_of/<path>?<q>` to upstream
  `/of/_of/<path>?<q>`. Everything that already applies to the catch-all applies here unchanged:
  - authentication with an API key or the dashboard session;
  - `read` keys get GET and HEAD only (`403 insufficient_scope`);
  - the allowlist check (`403 account_not_allowed`) and `409 team_not_linked`;
  - dot segments and encoded `/` or `\` are rejected (`400 invalid_path`);
  - the per-key rate limit and one `request_log` row;
  - the Fastify body limit (1 MiB) and `UPSTREAM_TIMEOUT_MS` end to end.
- **Upstream** (`routes/passthrough.py`): methods GET, POST, PUT, PATCH and DELETE. OPTIONS and HEAD get 405.
  - The `path` must match `[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*`, must not start with `http`, and must have no `.`
    or `..` segment. The regex already rejects absolute URLs, since `:` is not allowed. Anything else gets
    `400 invalid_path`.
  - The handler builds the absolute URL itself, `f"{API_BASE}/{path}"` (`https://onlyfans.com/api2/v2/…`), appends
    the raw query string, and calls `client.request(method, url, json_body=…)`. A client string is never passed to
    `_build_url` on its own, because `_build_url` treats a string starting with `http` as a full URL
    (of_client.py:224). The signature therefore covers exactly the URL that is sent.
  - **Assumed mapping.** Their docs do not say what `_of/{path}` maps to (inventory G). Pinning it to OF's
    `/api2/v2/{path}` is our assumption and a documented divergence risk: the operation's OpenAPI description says
    so, and §9 Q6 holds the default.
  - Request body: JSON only, parsed and passed as `json_body`. An empty body is sent as no body. Any other content
    type gets `415 unsupported_media_type`, and malformed JSON gets `400 invalid_json`.
  - Request headers: none of the client's headers reach OF. `OFClient` builds its own signed set.
  - Response: OF's status, OF's raw body bytes and OF's `content-type` only. `set-cookie`, `x-of-rev` and every other
    OF header are dropped. OF's 4xx and 5xx responses pass through verbatim; they are not mapped to `of_error`.
    Transport failures keep v4's 502 and 504.
  - Responses are buffered, not streamed (api2 is JSON).
  - No ledger rows and no events.
  - OpenAPI: one operation per method (`of.passthrough.get`, …), tag `of-api`.

### 2.2 Named-route responses (the upstream returns the value, the gateway wraps it)
- **Upstream.** A named route returns the `data` value as its JSON body. That is the shape of `data` in the yaml
  example for the route. Usually it is OF's body; where it is not, the inventory notes the reshape for that route.
  - Writes return OF's response, or `null` for an empty response.
  - A paged list sets `x-next-page: /<tail>?<next query>` only when the page is full (as many items as the limit)
    **and** OF reports `hasMore`. OF's `hasMore` is unreliable (of_client.py:766, :1147, :1340), so a short or empty
    page always ends pagination. The header is new: nothing sets or reads it today.
  - Query and body field names are theirs (yaml), and the handler maps them to OF's wire names.
  - Query parameters are plain typed values with defaults (v4 §2.1 rule).
- **Gateway** (`modules/proxy/routes.ts`, the only place per-account responses pass). The proxy wraps a 2xx response
  whose `content-type` is JSON, except when:
  - the response has a `content-encoding` header;
  - the status is 204 or the body is empty;
  - the first path segment after `/v1/{account}/`, **decoded**, is `_of` (so `%5Fof` cannot bypass the rule).

  Team-level routes (`/v1/whoami`, `/v1/accounts`, `/v1/webhooks*`) are separate Fastify routes and never reach the
  wrapper (§8). Errors are forwarded unchanged.
- The wrapped body is `{"data":<upstream body>,"_meta":{}}`, plus `,"_pagination":{"next_page":<url>}` when the
  upstream sent `x-next-page`. `<url>` is the absolute URL of the next page: `<APP_URL origin>/v1/<account>` followed
  by the header value (our base URL, the upstream's path and query), encoded with `JSON.stringify`. This is the
  yaml's `_pagination.next_page` (inventory D.4).
- The proxy builds the body by **splicing bytes, not with `JSON.parse`**, because `lib/upstream.ts:48` already holds
  the upstream body as a buffer. (64-bit ids are not the reason: `ingest.ts:39` parses frames with `JSON.parse`.)
  `content-length` is recomputed for the wrapped body.
- The proxy reads `x-next-page` from the upstream headers before the response-header filter (`routes.ts:74`). The
  header is not on the allowlist, so it is never forwarded.
- Routing order: within a module, declare literal paths before parameter paths (`users/list` before
  `users/{username}`). Starlette matches routes in order, and an int-typed parameter otherwise returns 422 instead of
  falling through to the literal path.

### 2.3 Webhook delivery and client frame
```
POST <endpoint url>
content-type: application/json
user-agent: Gateway-Webhooks
X-OFAPI-Idempotency-Key: evt_…    # the event's id; the same on automatic retries and manual redeliveries
Signature: <64 lowercase hex>     # HMAC-SHA256(key = UTF-8 bytes of the endpoint secret, msg = raw body bytes)

{"event":"messages.received","account_id":"1001","payload":{…}}
{"event":"webhook.test","payload":{"message":"Test event from the gateway"}}
```
- Key order is `event`, `account_id`, `payload`.
- `Signature` is sent only when the endpoint has a secret. Every endpoint of ours has one, so it is always sent.
- The `webhook-id`, `webhook-timestamp` and `webhook-signature` headers are dropped.
- Existing `whsec_…` secrets stay valid and are used as the key string as-is, so no endpoint needs a new secret.
- `verifySignature(secret, signature, body)` compares hex digests in constant time.
- There is no timestamp, so there is no replay window. docs/webhooks.md says this, and recommends de-duplicating on
  `X-OFAPI-Idempotency-Key`.
- **Idempotency key.** `ingestFrame` already mints one `evt_…` id per frame (ingest.ts:62); for a stored type it is
  the ledger's `event.id`, and `upstream.*` frames get one too. P1a passes it to `emit()`, which writes it to a new
  `webhook_delivery.event_id` column on each delivery row it inserts. The worker sends it as
  `X-OFAPI-Idempotency-Key` where it builds the body and headers today (worker.ts:129–132), so retries carry it.
  `redeliver()` copies `event_id` from the original row into the replay row; the replay still gets a new `whd_` id
  (service.ts:153), so the delivery id changes and the key does not. `queueTest()` mints a fresh `evt_` id. The key is
  not stored in `dedup_key`: that column is unique per endpoint (schema.ts:116), which would reject the replay row.
  P1a owns `db/schema.ts` and adds the column in `drizzle/0006_*`, backfilling existing rows with their own id so the
  column is `NOT NULL`.
- A client WS frame is the same JSON without the headers. The `ready` frame is unchanged.

### 2.4 Event names and the upstream frame
| v4 | v5 |
|---|---|
| `message.received` · `message.sent` | `messages.received` · `messages.sent` |
| `ppv.unlocked` | `messages.ppv.unlocked` (post unlocks arrive as `transactions.new`) |
| `tip.received` | `tips.received` |
| `subscription.new` · `.renewed` · `.expired` | `subscriptions.new` · `.renewed` · `.expired` |
| `account.session_expired` | `accounts.session_expired` |
| `post.expired` | `posts.expired` (ours) |

- **Emitted after Phase 1:** `messages.received`, `messages.sent`, `accounts.session_expired`, `posts.expired`, and
  `accounts.connected` / `accounts.reconnected`. The last two come from `POST /session/bootstrap`: a new uid gives
  `connected`, a uid that already had a session gives `reconnected`.
- **Catalogue status:** the inventory's per-event table assigns *TBC* or *never* to every other in-scope event.
- **Frame:** v4 §2.2 plus `"amount_cents": int|null`. `type` is the v5 name, and `payload` has the shape of their
  example for that type. `ingest.ts` fills the ledger's `amount_cents` from the frame, not from `data`.
- **Frame ids keep their v4 names.** `events.event()` (events.py:53) takes the internal v4 name, builds the frame
  `id` from it as today (`f"{type_}:{account_id}:{object_id}"`, events.py:55), and sets `type` from a separate
  internal-to-public map (the table above). The ledger's `dedup_key` is that id (ingest.ts:68), so a frame seen
  before and after the upgrade still de-duplicates, and `dedup_key` needs no migration. Events that are new in v5 use
  their public name for both.
- **Migration** `drizzle/0006_*` (custom SQL, generated by P1a):
  - applies the map above to `webhook_endpoint.events` (each array element) and `event.type`;
  - sets `status = 'dropped'` on every `pending` `webhook_delivery` row whose `event_type` is a renamed v4 name, so
    no v4 payload goes out under a v5 name. `dropped` is a new status value. The column is plain text
    (drizzle/0003_webhooks.sql:8), so only the enums in `db/schema.ts` and `contracts.ts` change, and retention
    purges it like any finished row (jobs/retention.ts:9). Finished deliveries keep their v4 `event_type` as history;
  - adds `webhook_delivery.event_id` (§2.3).

### 2.5 Parity audit `scripts/parity-audit.mjs` (node:fs only)
- **`extract <mirror page.html>`** reads only the `<script data-page="app">` JSON → `props.ziggy.routes`, and writes
  `docs/spec/parity/onlyfansapi-routes.txt`.
  - It prints nothing else from the page.
  - The output has one line per `api/` route: `METHODS uri name`, with methods comma-joined, HEAD dropped, sorted by
    uri.
  - A header comment records the source and date.
- **`check <upstream-openapi.json> [--missing] [--have]`** compares their per-account lines with our `/of/*`
  operations:
  - An operation is `METHOD tail`, with every `{param}` replaced by `{}`. Each of their lines expands to one
    operation per method, so a `PUT,PATCH` line is two operations.
  - A line is *have* only when **every** method it advertises exists on our side: `PUT` and `PATCH` both, when both
    are advertised. Response shapes are not checked; the `of_fake` contract tests do that (§7).
  - Not counted: `_of/{path?}`, and lines under the `OUT_OF_SCOPE` prefixes. That constant mirrors §8; the
    inventory's cut rows must agree with it.
  - Output: `group have/total` (lines), a total line, a team-level count (informational); with `--missing`, the
    missing lines; with `--have`, our matched operations, sorted, one per line (the baseline format).
- **Fails (exit 1)** when:
  - an operation listed in `docs/spec/parity/baseline.txt` is missing from our spec; or
  - one of our `of-api` operations (other than `_of`) matches no line of theirs. That is an *off-spec* route, and
    failing on it enforces §1.1.
- **Baseline:** `docs/spec/parity/baseline.txt` is a committed **set** of `METHOD tail` operations, not a count, so a
  lost route fails CI even when another one was added. Only the orchestrator raises it: after each wave merge it runs
  `check --have` on the merged tree and commits the result as **its own commit**, never inside the merge commit.
  Wave branches never edit it, so parallel waves cannot conflict on it.
- **CI**, in the `upstream` job (env `UPSTREAM_TOKEN`):
  `python -c 'import json, app; print(json.dumps(app.app.openapi()))' > /tmp/up.json && node ../../scripts/parity-audit.mjs check /tmp/up.json`.

---

## Phase 1 — Webhook parity, passthrough, seams, audit

Four branches run in parallel, and all four code against §2. **P1b0** merges first and is deployable on its own: it
changes no frame, event or envelope. P1a and P1b rebase onto it before they merge, because P1b0 makes the first edits
to `modules/proxy/routes.ts` (P1a continues it) and to `services/upstream/{app.py,routes/__init__.py,tests/conftest.py}`
(P1b continues them). Otherwise the file lists do not overlap.

### P1b0 — raw passthrough
**Owns.**
- `services/upstream/routes/passthrough.py` (§2.1), including the assumed-mapping note in its OpenAPI description.
- `routes/__init__.py` with `ROUTERS = [passthrough.router]`, and the loop in `app.py` that includes `ROUTERS`.
- `tests/conftest.py`: a generic `of_fake` fixture, which is an `OFClient` whose `_http_call` records
  `(method, url, json_body)` and returns queued responses, installed through the `account_client` override.
- `tests/test_passthrough.py`.
- Gateway: an `isPassthrough(rest)` predicate in `modules/proxy/routes.ts` (the decoded first segment is `_of`, §2.2)
  and a test in `test/proxy.test.ts` that `/_of/…` and `/%5Fof/…` responses are forwarded byte for byte. P1a's
  wrapper calls the predicate.

**Acceptance.** `ruff check . && pytest -q` and `pnpm -r typecheck && pnpm -r test`. The tests cover:
- method, URL and body reach `_http_call` on `https://onlyfans.com/api2/v2/…`, with the query string preserved;
- a path that starts with `http` gets 400, and nothing reaches `_http_call`;
- dot segments get 400, and a non-JSON body gets 415;
- OF's 404 body and status pass through byte for byte;
- the only header in the response is `content-type`.

### P1a — gateway webhooks
**Owns.**
- `contracts.ts`: the catalogue per §1.12 and §2.4, and `WEBHOOK_EVENTS` text with the status per type.
- `lib/signature.ts` and `db/webhook-receiver.ts`.
- `modules/webhooks/**` and `modules/events/ingest.ts`.
- `db/schema.ts`: `webhook_delivery.event_id` and the `dropped` status (§2.3, §2.4).
- `modules/proxy/routes.ts`: the §2.2 wrapper, after P1b0's predicate.
- `modules/openapi/routes.ts`: `platformSpec` publishes the wrapped shape, so each 2xx JSON response schema of a
  non-`_of` operation becomes `{data: <schema>, _meta: {}, _pagination?: {next_page: string}}`.
- `apps/web/src/routes/_app/webhooks.index.tsx` (its secret hint still names `webhook-signature`) and
  `apps/web/src/routes/_app/playground.tsx` (wrapped responses).
- `CHANGELOG.md`: the 2.0.0 entry and its "Upgrading to 2.0" section (§1.8).
- `drizzle/0006_*` with its meta.
- `test/fake-upstream.ts` (frames with the new names and `amount_cents`) and the affected tests.
- `docs/webhooks.md`: envelope, `Signature`, verification in Node and Python, the event table with
  emitted/TBC/never, the at-most-once note kept, de-duplication on `X-OFAPI-Idempotency-Key`, and a link to
  "Upgrading to 2.0".
- `docs/realtime.md`: the frame shape.

**Acceptance (tests).**
- A fixed event serialises to exact bytes (§2.3).
- `Signature` equals a known vector computed with `node:crypto` in the test.
- `verifySignature` rejects one flipped byte.
- `X-OFAPI-Idempotency-Key` is the ingest `evt_` id, and is identical on an automatic retry and on a manual
  redelivery. No `webhook-*` header is sent.
- A WS frame equals the webhook body.
- Seed v4-named rows, run the migration: endpoint filters and ledger rows carry v5 names, `dedup_key` is unchanged,
  and pending v4 deliveries are `dropped` and never sent.
- `POST /v1/webhooks` accepts every catalogue name, and an out-of-scope name (`data_exports.completed`) gets 400.
- The ledger amount comes from the frame's `amount_cents`.
- Proxy wrapper:
  - a 2xx JSON response from a named route is wrapped, and its `data` bytes equal the upstream body;
  - `content-length` matches the wrapped body;
  - `x-next-page` becomes an absolute `_pagination.next_page`, valid JSON even when the header holds `"` or `\`, and
    `x-next-page` is not forwarded;
  - `_of`, `%5Fof`, 4xx, 204, empty, non-JSON and `content-encoding` responses pass through unwrapped.
- `/openapi.json` shows a named route's 2xx schema wrapped, and the passthrough's unwrapped.
- Deliveries for `webhook.test` have no `account_id` key.
- `pnpm -r typecheck && pnpm -r test`, and the drizzle no-drift check, pass.

### P1b — upstream seams and payloads
**Owns.**
- `services/upstream/app.py`, after P1b0: the 8 v4 handlers move out of it.
- `routes/__init__.py`, after P1b0: the group modules join the explicit `ROUTERS` list.
- The modules `routes/{chats,fans,content,money}.py`, each starting as `router = APIRouter(prefix="/of",
  tags=["of-api"])`, added to `ROUTERS`. `promo.py` and `settings.py` wait for plan-v6.
- `routes/shape.py`: a `next_page(response, query)` helper that sets `x-next-page` (§2.2).
- `events.py` and `pump.py`: v5 names with v4 frame ids (§2.4), payloads shaped like their examples, `amount_cents`,
  and `accounts.connected` / `accounts.reconnected` from bootstrap.
- `tests/conftest.py`, after P1b0: P1b0's `of_fake` replaces `FakeOFClient` in `test_http.py`.
- `tests/fixtures/payloads/<event>.json`: hand-written, generic values (§7).
- Path examples in `README.md`, `docs/getting-started.md`, `deploy/hostinger.md`, `docs/runbook/ws7-operator-smoke.md`,
  `docs/video-script.md` and `apps/web/src/features/playground/spec.ts` (and its test).

The 8 v4 handlers move to their group module, with onlyfansapi's paths (§1.1) and onlyfansapi's query parameter
names (yaml), not v4's: `me` → `fans.py`, `chats*` → `chats.py`, `posts*` and `media/vault*` → `content.py`.

**Acceptance.** `ruff check . && pytest -q`. The tests cover:
- The 8 moved routes answer at their v5 paths with their v5 query names.
- `chats` sets `x-next-page` only when the page is full and OF reports `hasMore`. An empty page sets none, even when
  OF reports `hasMore`.
- `classify` produces v5 names, and payloads with the same key paths as the fixtures. Frame ids keep their v4 form:
  a `messages.received` frame for account 1001 and message 1002 has the id `message.received:1001:1002`.
- Bootstrap emits `connected` and then `reconnected`.

### P1c — parity audit
**Owns.** `scripts/parity-audit.mjs`, `docs/spec/parity/onlyfansapi-routes.txt`, the first
`docs/spec/parity/baseline.txt`, and `.github/workflows/ci.yml` (the §2.5 step).

**Acceptance.**
- `extract` on a mirror page writes about 445 lines. `grep -c 'api/{account' docs/spec/parity/onlyfansapi-routes.txt`
  gives 236.
- Run on P1b's dump, `check` reports no off-spec routes, and `check --have` prints the 8 v4 operations. That output
  is the first `baseline.txt`.
- A spec with one of the eight renamed back exits 1 (off-spec). A spec with one baseline operation removed exits 1
  (regression).
- A spec that serves a `PUT,PATCH` line with `PUT` only counts that line as missing.

---

## Phases 2–4 — Named-route waves

All three waves can run in parallel after Phase 1 merges. They are ordered by usefulness. Each wave owns only its
`routes/<module>.py` and `tests/test_routes_<module>.py`. The counts are inventory section A rows, grouped by the route
table's first path segment; section A is canonical per row.
- **GET rows all ship.**
- **Write rows ship only when the inventory marks them `client:`**, meaning the `OFClient` method already exists.
- Every other write row is **`deferred-write`**: it is not implemented in v5, it stays reachable through the
  passthrough (§2.1), and the wave lists it in its report.

| Phase | Branch | Module | Groups (rows) | Rows | Ship (from v4) | `deferred-write` |
|---|---|---|---|---|---|---|
| 2 | `v5/p2-chats` | `chats.py` | chats 20, messages 1, mass-messaging 6, queue 3, giphy 2 | 32 | 27 (3) | 5 |
| 3 | `v5/p3-fans` | `fans.py` | fans 10 (summary cut), users 13, user-lists 11, following 3, me 3, subscribers 1, session 1 | 42 | 39 (1) | 3 |
| 4 | `v5/p4-money` | `money.py` | payouts 7, banking 7, engagement 6, statistics 5, chargebacks 3, transactions 1, workflows 1 | 30 | 28 (0) | 2 |
| | | | **Total** | **104** | **94 (4)** | **10** |

- **The `deferred-write` rows.**
  - P2: `DELETE chats/{chat_id}`, `POST chats/{chat_id}/typing`, `POST messages/{queue_id}/attach-tags`,
    `PUT/PATCH mass-messaging/{mass_messaging}` and `PUT queue/{queue_id}/publish`.
  - P3: `DELETE fans/{fan_id}/notes`, `DELETE user-lists/{userListId}/users` and
    `POST user-lists/{userListId}/users/{userId}/pin`.
  - P4: `PATCH payouts/payout-frequency` and `POST payouts/request-manual-withdrawal`.
  - `POST chats/{chat_id}/messages` has no `client:` mark, but it already exists from v4, so it ships.
- **Baseline growth.** `baseline.txt` holds 8 operations after Phase 1 and 99 once all three waves have merged
  (P3's `PUT/PATCH user-lists/{userListId}` is two operations).

**Every wave:**
- Implement each shipping row in the inventory for its groups. The upstream returns the `data` value and
  `x-next-page` (§2.2); the gateway wraps it.
- OF calls go through the existing `OFClient` methods. GET rows without one use `client.request_json`.
- Tests: one `of_fake` test per route, asserting the OF method, the URL, the JSON body for writes, the returned
  `data` value and `x-next-page`. These tests are the response-shape check; the audit does not do it. One OF 4xx
  pass-through test per module.
- **Acceptance:** `ruff check . && pytest -q`. `check` exits 0 against the current `baseline.txt` (no lost
  operation, no off-spec route), and `check --have` lists every operation of the wave's shipping rows.
- Owner spot-check: one GET per group against a real account through `/v1/<id>/…`.
- An OF endpoint whose path or body is unknown is marked `?` in the inventory and skipped. The wave reports it; it
  does not guess.

## Deferred to plan-v6

| Planned branch | Module | Groups (rows) | Rows |
|---|---|---|---|
| content | `content.py` | posts 18, media 16, stories 15, saved-for-later 8 | 57 (4 exist from v4) |
| promo | `promo.py` | tracking-links 11, trial-links 11, shared-tracking-links 5, shared-trial-links 5, stored 4, promotions 4, bundles 3 | 43 |
| settings | `settings.py` | settings 16, release-forms 7, notifications 6 | 29 |
| | | **Total** | **129** |

- The draft's single P6 wave (promo and settings) splits into two branches, promo and settings, which share no
  module.
- The 4 v4 content routes (`posts`, `posts/{post_id}`, `media/vault`, `media/vault/{media_id}`) move to `content.py`
  in P1b and are wrapped from Phase 1 on. The other 125 rows are reachable only through the passthrough.
- Media and story uploads stay deferred in plan-v6 as well (v4 deleted the multi-part S3 flow). They count as
  *missing*, not *cut*, and the passthrough cannot do them either.
- Until uploads exist, P2's media sends (chat messages, mass messages) work only with media ids that are already in
  the vault.

---

## 5. Env additions

None.
- The wrapper's `next_page` origin comes from the existing `APP_URL`.
- The passthrough has no flag: it is gated by the key scope and the allowlist like every other `/v1/{account}` call.
- The audit's CI step sets `UPSTREAM_TOKEN` only so that `app` can be imported.
- `.env.example` is unchanged, so `hygiene.test.ts` does not need to change.

## 6. Workstreams & merge order

| Wave | Branch (worktree `.claude/worktrees/v5-<phase>`) | Owns |
|---|---|---|
| 1 | `v5/p1b0-passthrough` | P1b0 list |
| 1 | `v5/p1a-webhooks` | P1a list |
| 1 | `v5/p1b-upstream-seams` | P1b list |
| 1 | `v5/p1c-parity-audit` | P1c list |
| 2 | `v5/p2-chats`, `v5/p3-fans`, `v5/p4-money` | their module and test file |

One implementer (opus, high) per branch, and a reviewer → fix loop per branch before merge.

**Merge order:**
1. **P1b0** first. It changes no frame, event or envelope, so master can be deployed with it alone.
2. **P1a, then P1b, back to back, with no deploy between them.** The gateway drops frame types it does not know
   (ingest.ts:47), so a deploy that has only one of the two loses the renamed events. Both rebase onto P1b0 first.
3. **P1c.** It needs P1b's renames to pass the off-spec gate, and it adds the first `baseline.txt`.
4. **The waves**, in any order as they pass review, preferring P2 → P3 → P4. After each wave merge, the orchestrator
   runs `check --have` and commits the raised `baseline.txt` as its own commit (§2.5).

v5 is released as v2.0.0 (§1.8).

**Single-writer files** (the plan-v4 §6 rule):
- **P1b0 alone:** `routes/passthrough.py`, `tests/test_passthrough.py`, and the first edits (before P1a and P1b) to
  `modules/proxy/routes.ts`, `services/upstream/app.py`, `routes/__init__.py` and `tests/conftest.py`.
- **P1a alone:** `contracts.ts`, `db/schema.ts`, `lib/signature.ts`, `modules/{webhooks,events}/**`,
  `modules/proxy/routes.ts` (after P1b0), `modules/openapi/routes.ts`, `drizzle/**`, `test/fake-upstream.ts`,
  `apps/web/src/routes/_app/{webhooks.index,playground}.tsx`, `docs/{webhooks,realtime}.md`, `CHANGELOG.md`.
- **P1b alone:** `services/upstream/{app,events,pump,of_client}.py` (`app.py` after P1b0),
  `routes/{__init__,shape}.py` (`__init__` after P1b0), `tests/conftest.py` (after P1b0), `README.md`,
  `docs/getting-started.md`, `deploy/hostinger.md`, `docs/runbook/ws7-operator-smoke.md`, `docs/video-script.md`.
- **P1c alone:** `scripts/parity-audit.mjs`, `.github/workflows/ci.yml`, `docs/spec/parity/onlyfansapi-routes.txt`,
  and the first `docs/spec/parity/baseline.txt`.
- **Orchestrator alone:** `docs/spec/parity/baseline.txt` after P1c, and `docs/spec/plan-v5-inventory.md`.

A wave that needs a change to a shared file stops and reports. The orchestrator lands the change on master and the
wave rebases. Only P1a generates migration artifacts.

**Hard rule: the mirror is PII.** `app.onlyfansapi.com/` (gitignored) and `~/of-reference/` contain the owner's
personal data and API key previews.
- Implementers read them **only** for route and payload shapes: `props.ziggy.routes`, `props.examplePayloads`, and
  the yaml request and response schemas.
- They read them through a script that prints only those keys, or key paths and types. They never `cat` a page.
- Nothing else is quoted into code, tests, fixtures, commits or PR text.
- Never commit the mirror, the yaml, or an example value.
- Before each commit, grep the staged diff for the pattern list the orchestrator supplies: the owner's name, e-mail
  domain and the provider's key prefix. The list is not written in this plan.

## 7. Test strategy

- **No fake OF server.** As in v4, OF is faked at the object seam. The difference is that the fake now sits one layer
  lower: `of_fake` replaces `_http_call`, so every `OFClient` method and every `request_json` path is exercised and
  asserted at the URL level.
- **Payload contract tests use generic fixtures only.** `tests/fixtures/payloads/<event>.json` mirrors the key
  structure and JSON types of each example in their `props.examplePayloads`, with neutral values (ids 1001…,
  `"fan_1"`, fixed ISO times).
  - CI asserts that `classify()` output has the fixture's key paths.
  - A local-only `parity-audit.mjs shapes <webhooks.html> <fixtures dir>` subcommand compares key paths and types
    and prints only key paths. Implementers run it in P1b, and the orchestrator runs it at review. The mirror never
    reaches CI.
- **Response shapes are checked by contract tests, not by the audit.** Each named route's `of_fake` test asserts the
  `data` value; the gateway's wrapper tests assert the envelope around it. Example ids in every test and fixture are
  1001-style, never real-looking OF ids.
- **The gateway** keeps `test/fake-upstream.ts` as the executable copy of §2.4. Signing has a known-vector test.
- **CI:** the existing `check`, `docker` and `upstream` jobs, plus the §2.5 audit step in `upstream`.
- **Real OF** is exercised only by the owner's spot-checks: the P1b0 passthrough GET, and one GET per wave group.

## 8. Cut (YAGNI)

- **Out of scope** (owner; no inventory rows): Fansly, Fanvue, Smart Links and their postbacks, FansBot, data exports
  (`data_exports.*`), AI features (`fans/{fan_id}/summary`, `fan_summary.completed`, fan-summary categories, AI voice
  messages), billing (`usage/credits`, the inbound payment webhooks, `_meta._credits`).
- **Excluded by the inventory** (no rows):
  - the 30 `_internal`/`_auth_app` routes, which are their dashboard plumbing;
  - key-management routes, of which they have none, because their keys are dashboard-only like ours.
- **`_meta` contents** (`_credits`, `_cache`, `_rate_limits`; `_meta` is `{}`) and their `acct_` account ids.
- **The wrapper on our own team-level routes.** `/v1/whoami`, `/v1/accounts` and `/v1/webhooks*` keep their v4
  shapes, because the dashboard reads them. They stay *partial* in inventory section B.
- **Deferred team-level rows** (they stay *missing* in inventory B; the audit does not gate them):
  - their connect flow `authenticate/*` (email and password, OTP, mobile app). Operator `connect.py` stays the only
    way to add a session (v4 §2.1), and the OTP events stay in the catalogue as *never*;
  - `analytics/*`: our ledger behind `/v1/stats` is the equivalent;
  - `profiles/*`, `search`, `banned-words`, `link-tags`, `client-sessions` and `accounts` PUT/DELETE;
  - `webhooks/{type}/example-payload`: the docs table carries the shapes.
- **Webhook endpoint options:** `account_scope`/`account_ids` filters, user-supplied or optional signing secrets, a
  versioned envelope or compat flag, an event alias table, and keeping Standard Webhooks headers alongside
  `Signature`.
- **Key `permission_level` and `account_scope` changes** (§9 Q3–Q4).
- **Media and story uploads** and the `media_uploads.*` emitters: deferred and counted as missing.
- **Named routes outside Phases 2–4 and the `deferred-write` rows:** deferred to plan-v6 (§Deferred to plan-v6). The
  passthrough reaches them meanwhile.
- **Poll-derived events** (`transactions.new`, derived `subscriptions.expired`) until §9 Q2.
- **Passthrough extras:** OPTIONS, streaming, non-JSON bodies.
- **Audit extras:** gating team-level routes or response shapes, and a gateway `/__routes` endpoint.

## 9. Owner questions (default answers apply until you say otherwise)

1. **Frame mapping** (carried from v4 Q1, now wider). TBC events need OF frames: tips, PPV, subscriptions,
   `messages.deleted`/`liked`/`unliked`, `posts.liked`, `users.typing`/`online`/`offline` (`online_status` is
   dropped as noise today), and `chat_queue.*`. Should we lift the relay's transcoder, or capture 24 h of redacted
   frames? *Default: the capture, after Phase 1; the events stay TBC until then.*
2. **Poll-derived events.** `transactions.new` (theirs can lag by up to 3 min) and the expiry-derived
   `subscriptions.expired` would need a per-account poller in `pump.py`. *Default: no poller in v5.*
3. **Key `permission_level`.** Theirs is `read|read_write|read_write_delete`; ours is `read|write`. *Default: add a
   delete level only if a wave ships DELETE routes that some key must not be able to call. Note that `write` can
   already DELETE through the passthrough.*
4. **Key `account_scope`.** Theirs is `global|inclusive|exclusive`. Our allowlist covers global and inclusive.
   *Default: exclusive scoping stays out.*
5. **Committing the derived route list.** *Default: commit `docs/spec/parity/onlyfansapi-routes.txt`. It holds only
   the method, URI and name for each route, which is factual. Never commit the yaml, mirror pages or example
   payloads.*
6. **Passthrough mapping.** Their docs do not say what `_of/{path}` maps to on OnlyFans (inventory G). *Default:
   `https://onlyfans.com/api2/v2/{path}`, documented as an assumption that may diverge from theirs (§2.1). Revisit
   if a passthrough call that works on theirs fails on ours.*
7. **Fan data in payloads** (carried from v4 Q5, now wider). Their payloads carry full OF message and user objects
   (text, names, avatars) to every endpoint in every linked workspace. Is that OK? *Default: yes, as in v4.*

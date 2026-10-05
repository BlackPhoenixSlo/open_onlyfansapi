# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Analytics step 1, reply time ([docs/analytics.md](docs/analytics.md)): `GET /v1/stats/metrics` lists each metric with its formula in words, the windows it reads and `verified: false` (not yet checked by hand in OF or against Infloww); `GET /v1/stats/metrics/:id` returns rows by `day`, `hour` or `account` in the workspace timezone, as JSON or `format=csv`; `GET /v1/stats/metrics/:id/samples` returns up to 20 turns behind a number with message ids and times. Metrics `reply_time` (median over fan turns replied within `reply_cap`), `reply_time_mean` and `reply_time_mean_last` (Infloww-comparable means over replied turns, from the turn's first or last fan message), `reply_sla` (replied within `sla` over turns not pending) and `reply_time_substantive` (only a DM of `min_reply_chars`+ ends a turn), each with in-cap, late, breached and pending counts. `GET` and `PUT /v1/stats/config` read and change the workspace's windows and timezone (migration `0009`, table `stats_config`; `PUT` needs a `write` key and bumps `version`, which every result cites). The routes are scoped like `GET /v1/stats` and to the workspace's own rows: `409 team_not_linked` for an unlinked workspace, `403 account_not_allowed` for an `accountId` outside the key's allowlist.
- Analytics step 2, openers (compute only, unverified): metrics `openers`, `opener_reply_rate` and `opener_fan_reply_time`. An opener is a DM with no fan message and no DM in the chat for `open_gap` before it (mass and welcome messages do not reset the gap; after an unanswered fan message it is a late reply), of kind `first_ever`, `reactivation` or `unknown` from chat coverage, and `replied`, `no_reply` or `pending` against `open_reply`. CLI `analytics:openers` writes up to 20 openers of a range to a markdown file to check by hand in OF.
- Analytics step 3, script candidates (compute only, unverified, no money): the script normaliser v1 (strip tags, unescape HTML, NFKC, lowercase, collapse whitespace, fan's name, username and custom name to `<name>`; 4+ words or 20+ characters) hashes every outbound message into `message_fact.text_hash` with its `normaliser_version`; a hash sent 5+ times in 3+ chats within 30 days on one account is a script (migrations `0010` and `0011`: table `script`, `chat_coverage.fan_name` and `fan_custom_name`). `GET /v1/stats/scripts` lists scripts sent in a range with sends, chats, reply rate per outbound sequence within `open_reply` (and a substantive variant) and up to 5 exact variants. The backfill records the account's scripts when it ends. CLIs `analytics:scripts` (the top 20 to a markdown file) and `analytics:rehash` (rebuilds an account's hashes from stored text; run it once per account after migrating, since older rows have no normaliser version and are left out of scripts).
- Analytics follow-up to steps 1–3 (unverified): metric `reply_time_p90` (90th percentile of the `reply_time` waits, same in-cap turns and `n`, linear interpolation between closest ranks); metric `opener_reply_rate_substantive` (only a fan message of `min_reply_chars`+ is a reply); opener metric rows carry `massOrAutomatedGap`, the openers whose gap held mass or automated messages (CSV column `mass_or_automated_gap`); `GET /v1/stats/scripts` items carry `sendsAll` and `chatsAll`, the all-time sends and distinct chats a script qualified on (`sends` and `chats` stay in range).
- Analytics step 0 (backfill only, no routes; [docs/analytics-backfill.md](docs/analytics-backfill.md)): a new `analytics` module reads one account's range of messages, mass history (from the day before the range up to now, a full window split down to an hour), welcome message and transactions through the upstream, paced from the end of each response, capped per hour within a run, backing off on 429 and stopped at once with Ctrl-C (an `AbortSignal`), into four workspace-scoped tables (migration `0008`: `account_workspace`, `message_fact`, `chat_coverage`, `purchase_fact`), with derived mass, automated and fan-turn reply times (status `in_cap`, `late`, `breached` or `pending`). Chat coverage merges and never moves back; boundary messages older than the mass window are inserted once, never re-derived. The chat list is read down to two pages in a row with no chat active in the range, so a pinned or out-of-order older chat does not end it. CLIs: `analytics:claim` (an account belongs to one workspace), `analytics:backfill` (takes the client's automation texts with `--automation <file>`, reports unmatched queue ids and incomplete chats, and writes `messages.csv`, `chats.csv` with the fan username, `transactions.csv`, `reply_times.csv`; no message text) and `analytics:diff` (compares them with an Infloww Message Dashboard export saved as CSV, preferring joins whose `Sent to` is the chat's fan username, warning when most sent times are unreadable, and explains each difference or lists it as unresolved). New optional `ANALYTICS_REQUESTS_PER_HOUR` (default 600), `ANALYTICS_PAGE_DELAY_MS` (300) and `ANALYTICS_BACKOFF_MAX_MS` (300000). The upstream serves `GET settings/welcome-message` (the `reply_on_subscribe` template, or null); the backfill needs it, so upgrade the upstream with the gateway.
- Dashboard: the webhook event picker is a compact grid grouped by prefix with a select-all per group, so the whole catalogue fits on one screen. `GET /v1/webhooks/events` items carry a typed `status` (`emitted` | `tbc` | `never`).
- Dashboard: in-browser notifications for webhook deliveries. `GET /api/webhooks/stream` (session-authenticated SSE, scoped to the workspace, 10-minute lifetime) pushes a frame after each delivery attempt; the dashboard shows a toast (delivered / retrying / failed; the frame carries the delivery status `succeeded` / `pending` / `failed`) and, when permitted and the tab is hidden, a desktop notification.
- Dashboard: a Live events card on the Webhooks page shows the last 50 events as they arrive (time, type, account, payload), with or without a registered endpoint. The same stream now also carries `event: event` frames (`{ id, type, accountId, ts, data }`, `upstream.*` included) for linked workspaces; `POST /api/webhooks/stream/test` pushes a synthetic `webhook.test` event to the caller's workspace only (the card's Emit test event button).

- Webhook event `messages.deleted`, from OF's `chat_message_delete` socket frame (payload `{ id }`). It was
  `upstream.chat_message_delete` before; a value that is not a message id still is. Mapping:
  `docs/spec/plan-v6-ws-events.md`.
- Dashboard: Accounts → Connect account connects an OnlyFans account from a DevTools cURL, a nickname and a proxy URL, with plain-language hints for the upstream's errors; the dialog detects the Fastt Login Capture extension (links to its store page when missing). `POST /api/accounts/connect` (session + CSRF, linked workspaces only) forwards to the upstream's `/session/bootstrap` and passes its status and body through; the cURL is never written to the request log.
- Dashboard: the Playground shows each parameter's type, required marker, description and default from the spec, prefills `limit` (20) and date ranges (last 7 days), seeds JSON bodies from the request schema, remembers per-operation values and the last account (with Reset to defaults), lists recent operations and summaries in a collapsible sidebar, and adds Copy and a Table view for `rows`/`items`/`data` responses.
- Email verification on sign-up: a new account must open the emailed link before it can sign in (`403 EMAIL_NOT_VERIFIED` until then); the link signs it in and opens the dashboard, and the login page offers Resend verification email. Mail goes out over SMTP (new optional `SMTP_HOST`, `SMTP_PORT` (default 587, TLS on 465), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`); without `SMTP_HOST` the link is printed in the API log. Migration `0007` marks existing users verified, so nobody is locked out.

### Fixed
- Stats routes, before release: a DM after an unanswered fan message is a late reply, not an opener (17 openers instead of 19 on a live 30 days); a month that does not exist in `from` or `to` is `400 validation_error`, not a 500; a script's sends and first and last send come from the same rows; scripts read only hashes of the current normaliser version; reads are bounded to the range with an exact lookback per chat.
- Analytics backfill: the chat list is paged by OF's `nextOffset` (OF answers about 10 chats a page whatever the `limit`); it advanced by 50 and skipped 43 of 62 active chats in a live week.
- Analytics backfill: `chats.csv` `fan_username` is filled from the chat list, now read with `skip_users=none`; it was always empty.

### Changed
- Analytics backfill: `messages.csv` `text_hash` is the script hash ([docs/analytics.md](docs/analytics.md#scripts)): the fan's names become `<name>` and it is empty for text too short to be a script. Automation matching still hashes the text without replacing names.
- `OF_REQUIRE_PROXY` now defaults to `false` in the upstream, both compose files and the deploy env example: an account connected without a proxy uses the server's own IP. Set `true` to keep refusing proxy-less accounts.

- `posts.expired` is documented as firing for any post in the account's feed, not only its own: a socket capture
  showed OF sends `post_expire` for other creators' posts.
- `docs/webhooks.md`: `upstream.*` names and contents may change in any minor release.

### Removed

- The upstream no longer forwards counter frames made of numbers and flags only, such as
  `{"hasSystemNotifications": …, "messages": …}`; they were sent as `upstream.hasSystemNotifications` and
  `upstream.messages`.

## [2.1.0] - 2026-10-05

v2.1 adds 41 named per-account operations of the reference API: rows 2.0 left open, and the content, promo and
settings groups. It is additive: the wrapper and `_pagination`, the webhook body, signature and event names, the
passthrough and the database schema are unchanged. The only env change is optional: compose now passes
`OF_REQUIRE_PROXY` through to the upstream (default `true`, same as before). The gateway and upstream images do not have to be
upgraded together; a 2.0 gateway forwards the new routes through its catch-all. Every reference route not listed
here stays reachable through `_of/{path}`, in OF's own paths and shapes, when OF has such a call.

### Added

Paths are relative to `/v1/{account}`.

- **Rows left open in 2.0** (1): `DELETE fans/{fan_id}/notes` (clears the note).
- **Content** (15): `POST posts`, `DELETE posts/{post_id}`, `GET posts/{post_id}/comments`; `GET` and
  `POST media/vault/lists`, `PUT`, `PATCH` and `DELETE media/vault/lists/{list_id}`,
  `POST media/vault/lists/{list_id}/media`; `GET stories`, `GET stories/archive`, `GET stories/highlights`,
  `DELETE stories/{story_id}`; `GET saved-for-later/messages`, `GET saved-for-later/posts`.
- **Promo** (8): `GET` and `POST tracking-links`, `DELETE tracking-links/{tracking_link_id}`; `GET trial-links`,
  `DELETE trial-links/{trial_link_id}`; `GET promotions`, `DELETE promotions/{promotion_id}`; `GET bundles`.
- **Settings** (6): `GET settings`, `POST settings/profile`, `GET settings/social-media-buttons`;
  `GET release-forms/taggable-users`; `GET notifications/counts`, `GET notifications/tabs-order`.

### Added (verified on one account)

These 11 GETs call an OF path derived from a known one. A read-only probe on one connected account is their only
evidence.

- **Rows left open in 2.0** (4): `GET chats/{chat_id}/messages/{message_id}`, `GET chargebacks`,
  `GET engagement/messages/direct-messages`, `GET engagement/messages/top-message`.
- **Content** (5): `GET posts/labels`, `GET media/vault/lists/{list_id}`, `GET stories/{story_id}`,
  `GET saved-for-later/messages/settings`, `GET saved-for-later/posts/settings`.
- **Settings** (2): `GET settings/blocked-countries`, `GET settings/drm`.

### Fixed

- `GET engagement/messages/mass-messages` and `GET mass-messaging/overview` no longer emit a looping
  `x-next-page`. OF ignores `offset` on the call behind them and always reports more, so a client following
  `_pagination.next_page` re-read page 1 forever; it now stops after page 1. Only clients that follow
  `_pagination.next_page` are fixed. A client that pages by hand with `offset` still gets page 1 for every offset
  and must stop when a page repeats the previous one. Refusing `offset` there with a `422` would break 2.0
  clients, so it waits for 3.0.0.

### Changed

- `GET settings` omits streaming-key fields: every top-level key of OF's settings whose name contains "stream"
  (any case) is dropped, because it can hold streaming credentials that any read-scope key could see.
- Every new route turns a `404`, `405` or `422` on its path into a success. Nothing else that 2.0 serves changes,
  apart from the fix above.

### Known gaps

- **Every write is fixture-tested only, never executed against OF**: `DELETE fans/{fan_id}/notes`, `POST posts`,
  `DELETE posts/{post_id}`, the five `media/vault/lists` writes, `DELETE stories/{story_id}`, `POST tracking-links`,
  the `DELETE` of tracking links, trial links and promotions, and `POST settings/profile`.
- **Write fields with no verified OF mapping answer `422 unsupported_field` when set**, rather than being dropped:
  OF can ignore a field silently, so a dropped `scheduledDate` or `saveForLater` would publish a post now. On
  `POST posts` only `text` and `mediaFiles` (vault ids) are sent; on `POST tracking-links`, `tags` is refused; on
  `POST settings/profile` only `about` is sent, and an empty body is a `422`. On create bodies, absent, `null`,
  `""`, `[]` and `false` count as unset.
- **`POST posts` treats `0` as a value, not as unset**: `expireDays`, `fundRaisingTargetAmount`, `votingDue` or
  `votingCorrectIndex` set to `0` is a `422`. Leave those fields out instead.
- **Narrowing filters answer `422 unsupported_field`** where OF's call cannot take them, instead of returning an
  unfiltered list: `query` on `media/vault/lists` and `engagement/messages/direct-messages`; `startDate`, `endDate`,
  `with_deleted`, `sortby` and `sort` on `tracking-links`; `startDate`, `endDate`, `sort` and `field` on
  `trial-links`; any `filter`, `sort` or `sortDirection` other than `all`, `date` and `desc` on
  `release-forms/taggable-users`. Cosmetic options (`synchronous`, `pagination`, `lightweight`, `skip_users`) are
  accepted and ignored. Routes that return one page answer `offset` above 0 with a `422`, and so do the reference's
  own cursors (`marker` on `stories/archive`, `sort=asc` on post comments).
- **`GET chargebacks`**: `limit` is refused with a `422` (OF's page size there is unverified), and so is `offset`
  above 0. OF pages by its own marker: a non-null `data.marker` means the list is truncated and more chargebacks
  exist.
- **`GET tracking-links`** clamps `limit` to 100, an unverified cap on OF's call. If OF caps lower, a page comes
  back short and carries no `next_page` although more links exist.
- **`GET stories/highlights`** returns OF's single answer; whether it holds every highlight is unverified.

## [2.0.0] - 2026-10-02

v2 makes the gateway a drop-in for clients of the reference API: its webhook event names, body and signature, and
its response shape on per-account routes. Every change below breaks 1.x clients; read
[Upgrading to 2.0](#upgrading-to-20) before you deploy.

### Added

- **Raw passthrough** `/v1/{account}/_of/{path}` reaches any OnlyFans call that has no named route yet, in OF's own
  paths and shapes.
- Webhook deliveries carry `X-OFAPI-Idempotency-Key`, the event's `evt_` id, which stays the same on retries and
  redeliveries. Deliveries expose it as `eventId`.
- The webhook catalogue accepts every in-scope event name of the reference API, each marked emitted, TBC or never
  (see [docs/webhooks.md](docs/webhooks.md#event-types)). New events emitted: `accounts.connected` and
  `accounts.reconnected`.
- A `dropped` delivery status, for pending 1.x deliveries the migration cancels.

### Upgrading to 2.0

**Upgrade the gateway and upstream images together.** The gateway drops event frames whose type it does not know,
so a mixed pair loses events until both run 2.0. The database migration runs on start.

- *Gateway 2.0 with upstream 1.x:* every renamed event is dropped as an unknown type (`posts.expired` and
  `accounts.session_expired` included); only `upstream.*` frames still arrive. 1.x frames have no `amount_cents`, so
  any amount would be stored as null. The 1.x paths (`users/me`, `vault/media`, ...) still work, but their
  responses come back wrapped.
- *Upstream 2.0 with gateway 1.x:* every stored event, `accounts.session_expired` included, is dropped as an
  unknown type, and the three renamed paths return 404 from the upstream.

1. **Webhook body.** `{"id","type","createdAt","accountId","data"}` is now `{"event","account_id","payload"}`, in
   that order. `account_id` is a JSON string, and is omitted for events without an account (`webhook.test`).
   There is no `id` or `createdAt` in the body any more. Client `/v1/ws` frames are the same JSON (the `ready`
   frame is unchanged).
2. **Signature.** The `webhook-id`, `webhook-timestamp` and `webhook-signature` (Standard Webhooks) headers are
   gone. Deliveries carry `Signature`: lowercase hex HMAC-SHA256 of the raw body, keyed with the endpoint's
   `whsec_...` secret string as-is (not base64-decoded). There is no timestamp and so no replay window. Existing
   secrets stay valid. De-duplicate on `X-OFAPI-Idempotency-Key` instead of `webhook-id`. See
   [docs/webhooks.md](docs/webhooks.md#verifying-the-signature).
3. **Event names are plural**, as in the reference API. The 1.x names are refused with `400`:

   | 1.x | 2.0 |
   |---|---|
   | `message.received` | `messages.received` |
   | `message.sent` | `messages.sent` |
   | `ppv.unlocked` | `messages.ppv.unlocked` |
   | `tip.received` | `tips.received` |
   | `subscription.new` / `.renewed` / `.expired` | `subscriptions.new` / `.renewed` / `.expired` |
   | `account.session_expired` | `accounts.session_expired` |
   | `post.expired` | `posts.expired` |

   The migration renames the names in stored endpoint `events` filters and in the event ledger (so `/v1/stats`
   returns the 2.0 names; use them in `?types=`). Pending deliveries of a renamed 1.x event are set to `dropped`
   and never sent, so no 1.x body goes out under a 2.0 name; finished deliveries keep their 1.x name as history.
   Neither can be redelivered (`409 not_redeliverable`; deliveries carry a `redeliverable` flag).
   Payloads changed too: they follow the reference API's examples (for instance `messages.received` carries the
   full OnlyFans message object), and amounts are no longer read from the payload. See the event table.
4. **Three per-account paths were renamed**, with no aliases: `users/me` is now `me`, `vault/media` is now
   `media/vault`, and `vault/media/{mediaId}` is now `media/vault/{media_id}`. The query parameters of the moved
   routes use the reference API's names: `chats` takes `limit` (1-50), `offset`, `order` (`recent`|`old`),
   `skip_users` (`all`|`none`), `filter` and `query`; `chats/{chat_id}/messages` takes `limit` (1-100), `order`
   (`desc`|`asc`), `first_id` (desc cursor) and `offset` (asc only); `posts` takes `limit` (1-100) and `offset`;
   `media/vault` takes `limit` (1-100), `offset`, `query`, `field`, `sort`, `type` (`all`|`photo`|`gif`|`video`|`audio`)
   and `list`. `/v1/{account}/_of/users/me` still returns OF's own body.
5. **Per-account responses are wrapped.** A `2xx` JSON response of a named `/v1/{account}/...` route is now
   `{"data": <1.x body>, "_meta": {}}`, plus `"_pagination": {"next_page": "<absolute URL>"}` when there is a next
   page. Errors, `204` and empty responses, the `_of` passthrough, and the team-level routes (`/v1/whoami`,
   `/v1/accounts`, `/v1/webhooks*`, `/v1/stats`) are not wrapped. `/openapi.json` documents the wrapped shapes.

## [1.0.0] - 2026-10-02

### Added

- **Webhooks.** `/v1/webhooks` API to create, list, update, pause and delete endpoints, list recent deliveries,
  send a test event and redeliver. Deliveries are signed with
  [Standard Webhooks](https://www.standardwebhooks.com) headers (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`) and a per-endpoint `whsec_` secret. Failed attempts are retried with backoff (30 s, 2 m,
  10 m, 1 h, 6 h); an endpoint that keeps failing is paused (circuit breaker) until it is re-enabled. Targets
  must be `https://`, and private, loopback and link-local addresses are refused. Finished deliveries are kept
  for 7 days. Only `webhook.test` is sent in this release; the other catalogue events arrive with the upstream
  event source. See [docs/webhooks.md](docs/webhooks.md).
- **Webhooks dashboard.** Webhooks page with endpoint list, create, pause and resume, and an endpoint detail page
  with deliveries, filters and redeliver.
- **Home "needs attention" list.** Paused and failing webhook endpoints, also returned by `/api/overview` as
  `pausedWebhooks` and `needsAttention`.
- **Logs search** also matches path and endpoint substrings; a `req_` id is still an exact lookup.
- **Per-key usage.** Key rows link to the usage page grouped by key.
- **Self-host deploy.** Multi-stage Docker image, production `deploy/docker-compose.yml` with Caddy (automatic
  TLS) and Postgres 17, migrations on start, a VPS deploy guide ([deploy/hostinger.md](deploy/hostinger.md))
  with backups, restore and an optional Cloudflare Tunnel, and a CI job that builds the image and smoke-tests the
  compose stack.
- `link-team` command to approve a workspace for the upstream, available in the image.
- Public README, `CONTRIBUTING.md`, `SECURITY.md`, issue and pull request templates, and this changelog.

### Changed

- The upstream is reached through an opaque adapter with one `UPSTREAM_TOKEN` (bearer) and an origin-only
  `UPSTREAM_URL`; see the README for the three calls it must answer.
- Each user has exactly one workspace. It is created on sign-up and, if that failed, on the next dashboard
  request, so the `403 no_workspace` error is gone.
- Migrations are compiled into the API build; dev tooling is kept out of the runtime image.

### Security

- Organization writes through the auth API (create, delete, invite, accept, member and role changes,
  set-active, leave, slug changes) are refused. Renaming the workspace is still allowed.
- Unique index on `member.user_id`, so a user cannot hold a second membership. The migration fails if an
  existing database already has a user with two memberships; remove the extra rows first.
- The API refuses to start in production with a plain `http://` public URL.
- Dev Postgres binds to loopback only; the production Postgres password is kept out of the connection URL.
- A pre-publish check (`scripts/prepublish-check.sh`) guards the repository against secrets and stray brand
  names.

## [0.1.0] - 2026-10-01

First working MVP.

### Added

- Sign-up and sign-in (better-auth) with one workspace per user.
- Scoped `gk_` API keys (`read` or `write`, optional account allowlist), stored as SHA-256 hashes; create,
  rename, rescope and revoke from the dashboard.
- Proxy from `/v1/{account}/...` to the upstream with a per-key rate limit; status, body and rate-limit headers
  pass through.
- Request logs with header and body redaction, 14-day retention, and a log detail page.
- Usage by day, key, account and endpoint; Home KPI cards.
- Playground that sends requests with the dashboard session and copies the curl.
- Merged OpenAPI document at `/openapi.json` and an interactive reference at `/docs`.
- Dashboard pages: Home, Accounts, API keys, Logs, Usage, Playground, Settings.
- Workspace isolation for keys, logs and usage; a workspace reaches the upstream only after the operator links it.
- CSRF protection on cookie-authenticated writes, pnpm workspace, Postgres via docker compose, CI, AGPL-3.0
  licence.

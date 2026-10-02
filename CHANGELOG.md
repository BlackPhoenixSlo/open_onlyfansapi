# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

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
so a 2.0 gateway with a 1.x upstream (or the reverse) loses every renamed event until both run 2.0. The database
migration runs on start.

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
   Payloads changed too: they follow the reference API's examples (for instance `messages.received` carries the
   full OnlyFans message object), and amounts are no longer read from the payload. See the event table.
4. **Three per-account paths were renamed**, with no aliases: `users/me` is now `me`, `vault/media` is now
   `media/vault`, and `vault/media/{mediaId}` is now `media/vault/{media_id}`. The query parameters of the moved
   routes use the reference API's names. `/v1/{account}/_of/users/me` still returns OF's own body.
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

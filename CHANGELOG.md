# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

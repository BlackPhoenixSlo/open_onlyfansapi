# Plan v2: one-command VPS deploy

- **Date:** 2026-10-01. **Builds on:** `plan.md` §11 and `review-mvp.md`. Where they conflict, this file wins.
- **Principle:** YAGNI. The v0.1 gateway stays the same. v2 adds packaging, deployment, CI and a generic upstream credential.
- **Runbook:** `docs/runbook/README.md` (four parallel workstreams, then three checks after the merge).

## 1. Goals and non-goals

**Goals**
1. Anyone with a Docker VPS (Hostinger KVM) can run `cd deploy && cp .env.example .env && docker compose up -d`
   and get the dashboard and API over HTTPS on one domain.
2. The gateway talks to its upstream through a small bearer-token adapter. It holds one `UPSTREAM_TOKEN`, so it
   no longer needs a JWT signing secret.
3. CI proves that the image builds and that the production compose stack answers `/healthz` through Caddy.

**Non-goals**
- **The upstream service.** It is an opaque HTTP service that the user supplies (`UPSTREAM_URL` +
  `UPSTREAM_TOKEN`). This repo specifies only the calls the gateway makes to it (§4).
- **Account connection and session flows.** These belong to the upstream service, not this repo.
- High availability, more than one gateway instance, Kubernetes, publishing to an image registry, email,
  webhooks, per-workspace upstream tokens and automated off-box backups (§6 documents a manual procedure and a cron line).

## 2. Architecture

```
 browser / API client
        │ 443 (80 → redirect)                                  ┌─────────────────────────────┐
        ▼                                                      │ upstream (user-supplied)    │
 ┌─────────────┐  http   ┌──────────────────────────┐  Bearer  │ UPSTREAM_URL                │
 │ caddy       │───────▶ │ gateway :4000            │ ───────▶ │ GET  /of-accounts           │
 │ TLS (ACME)  │         │ Fastify api + web dist   │  token   │ ANY  /of/<rest>             │
 └─────────────┘         │ migrations run on start  │          │ GET  /docs/json             │
   or (profile tunnel)   └────────────┬─────────────┘          └─────────────────────────────┘
 ┌─────────────┐  http          │ internal network only
 │ cloudflared │───────▶ gateway:4000      ▼
 └─────────────┘                ┌──────────────────┐
                                │ postgres :5432   │  volume pgdata
                                └──────────────────┘
```

Each path has exactly one proxy hop in front of the gateway (Caddy, or cloudflared in tunnel mode). That makes
`TRUST_PROXY=1` correct in both modes. The gateway port is never published, so no client can go around the proxy.

## 3. Compose services (`deploy/docker-compose.yml`)

| Service | Image | Ports (host) | Volumes | Healthcheck | Env |
|---|---|---|---|---|---|
| `caddy` (profile `caddy`) | `caddy:2-alpine` | **80, 443, 443/udp**: the only published ports | `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy_data:/data`, `caddy_config:/config` | none (the smoke test curls through it) | `PUBLIC_URL` |
| `gateway` | built from `../apps/api/Dockerfile` (context `..`) | none (`expose: 4000`) | none | the image's `HEALTHCHECK`: `GET http://127.0.0.1:4000/healthz` every 10 s | see §5 (`DATABASE_URL` is built from `POSTGRES_PASSWORD`) |
| `postgres` | `postgres:17-alpine` | none | `pgdata:/var/lib/postgresql/data` | `pg_isready -U gateway` | `POSTGRES_USER=gateway`, `POSTGRES_DB=gateway`, `POSTGRES_PASSWORD` |
| `cloudflared` (profile `tunnel`) | `cloudflare/cloudflared:<pinned tag>` (not `latest`) | none | none | none | `TUNNEL_TOKEN`; command `tunnel --no-autoupdate run` |

- **Profiles.** `deploy/.env.example` sets `COMPOSE_PROFILES=caddy`. Tunnel users set `COMPOSE_PROFILES=tunnel`.
  In both modes a plain `docker compose up -d` is the only command. In tunnel mode the Cloudflare public hostname
  points at `http://gateway:4000`.
- **Ordering.** `gateway` depends on `postgres` (`service_healthy`). `caddy` and `cloudflared` depend on `gateway`
  (`service_healthy`). Every service has `restart: unless-stopped`.
- **Logging.** Each service uses `json-file` with `max-size: 10m` and `max-file: 3`, so a small VPS disk does not fill up.
- **Caddyfile.** One site block `{$PUBLIC_URL}` with `encode zstd gzip` and `reverse_proxy gateway:4000`. An `https://`
  value turns on automatic ACME TLS. `http://localhost` serves plain HTTP on :80, which the CI smoke test and local
  checks use.
- **Image.** A multi-stage build (WS1). The build stages install with the pnpm lockfile and run `pnpm build`
  (web, then api). The runtime stage is `node:22-alpine` and runs as user `node` with `WORKDIR /app/apps/api`.
  It contains `dist/`, `drizzle/`, production `node_modules` and `/app/apps/web/dist`. That path matters because
  `plugins/web-static.ts` resolves `../../../web/dist` from `dist/plugins/`.
- **Start command.** `node dist/db/migrate.js && exec node dist/server.js`. Migrations are forward-only and
  idempotent, and only one instance runs.
- **Operator CLI inside the container.** `docker compose exec gateway node dist/db/link-team.js <workspace-slug>`.

## 4. Upstream adapter (`apps/api/src/lib/upstream.ts`)

This is the only module that knows the upstream's paths and credential. It does no database access.

```ts
export type UpstreamResponse = { status: number; ok: boolean; headers: Headers; body: Buffer };

export type ForwardRequest = {
  accountId: number;
  /** `/<rest>?<query>` taken from the raw URL; the proxy has already rejected dot segments and encoded separators. */
  path: string;
  method: string;
  /** Allow-listed by the proxy: never the client's `authorization`, `cookie` or `host`. */
  headers: Record<string, string>;
  body?: string;
};

export interface Upstream {
  /** `GET {origin}/of-accounts` → JSON array of account rows (whitelisted by `modules/accounts`). */
  listAccounts(requestId: string): Promise<UpstreamResponse>;
  /** `{method} {origin}/of{path}` with `x-of-proxy-account-id: {accountId}`. */
  forward(req: ForwardRequest): Promise<UpstreamResponse>;
  /** `GET {origin}/docs/json` → OpenAPI 3 document. It is optional: without it the gateway serves its own routes only. */
  openapi(): Promise<UpstreamResponse>;
}

/**
 * Every call sends `authorization: Bearer ${token}` and uses `redirect: 'manual'`. The body is buffered inside
 * `timeoutMs`. Errors: network → 502 `upstream_unavailable`, timeout → 504 `upstream_timeout`, a built URL that
 * leaves `{origin}/of/` → 400 `invalid_path`. `url` is reduced to its origin, so any path in it is ignored.
 */
export function createUpstream(opts: { url: string; token: string; timeoutMs: number }): Upstream;
```

- **Replaces** `lib/backend.ts` (the JWT minting and the `fast-jwt` dependency go away). `app.decorate('upstream', …)`
  replaces `app.backend`, and `AppOptions.backendUrl` becomes `upstreamUrl`.
- **Workspace gate stays.** A workspace reaches the upstream only after the operator runs `link-team <slug>` from
  the VPS shell. Sign-up is open, so the link is the approval step. The integer `backend_user_id` no longer means
  anything, so a migration drops it. The table name `team_backend` stays, because renaming it makes drizzle-kit prompt.
  `/v1/whoami` returns `team.linked: boolean` instead of `team.backendUserId`. The check moves to `lib/team-link.ts`
  (`assertTeamLinked(teamId)`, 409 `team_not_linked`).
- **Renames for consistency** (v0.1 is unpublished, so they are cheap now). Error code `backend_error` becomes
  `upstream_error`, the `x-backend-spec` header becomes `x-upstream-spec`, and user-facing "backend" wording
  becomes "upstream" in `apps/api/src`, `apps/web/src`, the README and `docs/*.md`. `docs/spec/**` is left as history.
- **"Delete account" is not in the interface.** The brief lists it, but no gateway route calls it today (see open question 1).

## 5. Env matrix

| Variable | Dev (`.env`) | Tests (`vitest.config.ts`) | Production (`deploy/.env` → compose) |
|---|---|---|---|
| `NODE_ENV` | `development` | `test` | fixed `production` in compose |
| `DATABASE_URL` | `…@localhost:5434/gateway` | `TEST_DATABASE_URL` | built: `postgres://gateway:${POSTGRES_PASSWORD}@postgres:5432/gateway` |
| `POSTGRES_PASSWORD` | – | – | **operator**: `openssl rand -hex 24` (URL-safe) |
| `PUBLIC_URL` | – | – | **operator**: `https://gw.example.com`; feeds the Caddy site, `APP_URL` and `BETTER_AUTH_URL` |
| `APP_URL` / `BETTER_AUTH_URL` | `:5173` / `:4000` | as today | `${PUBLIC_URL}` (same origin) |
| `BETTER_AUTH_SECRET` | operator | fixed test value | **operator**: `openssl rand -base64 32` |
| `TRUST_PROXY` | `false` | default | fixed `1` |
| `UPSTREAM_URL` | `http://localhost:3001` (fake upstream) | fake upstream on port 0 | **operator** (origin only) |
| `UPSTREAM_TOKEN` | `dev-upstream-token` | `test-only-upstream-token` | **operator** |
| `UPSTREAM_TIMEOUT_MS` | `30000` | `2000` | `${UPSTREAM_TIMEOUT_MS:-30000}` |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | default | fixed `4000` / `0.0.0.0` |
| `COMPOSE_PROFILES` | – | – | `caddy` (default) or `tunnel` |
| `TUNNEL_TOKEN` | – | – | only with `COMPOSE_PROFILES=tunnel` |
| `KEY_RATE_LIMIT_PER_MIN`, `LOG_*`, `RUN_JOBS` | defaults | as today | not passed; the `env.ts` defaults apply |

The variables `BACKEND_URL`, `BACKEND_JWT_SECRET` and `BACKEND_TIMEOUT_MS` are removed. The root `.env.example`
must still list every key in `env.ts`, which `hygiene.test.ts` checks.

**Dev without a real upstream.** `pnpm --filter @gateway/api exec tsx test/fake-upstream.ts` serves the same fake
the tests use on `0.0.0.0:${FAKE_UPSTREAM_PORT:-3001}`, with `UPSTREAM_TOKEN` (default `dev-upstream-token`) and
one seeded account `1`.

## 6. Security notes

- **One upstream token.** It lives only in `deploy/.env` (`chmod 600`, gitignored by `.env`) and in the gateway
  container's environment. The adapter adds it to outbound calls only. Request logs never store credential headers,
  and the proxy never forwards the client's `authorization`. Responses pass through, so an upstream that echoes
  request headers in its body would expose the token: the token is only as safe as the upstream's own behaviour.
  To rotate it, edit `deploy/.env` and run `docker compose up -d`.
- **One token means one upstream tenant.** Every linked workspace sees the same upstream accounts. Per-key
  `allowedAccountIds` and read/write scopes remain the fine-grained control.
- **TLS.** Caddy gets and renews certificates automatically. This needs DNS A/AAAA records pointing at the VPS and
  ports 80 and 443 reachable. Certificates persist in `caddy_data`; keep that volume to stay under ACME rate limits.
  Because `BETTER_AUTH_URL` is `https://…`, cookies are `Secure`. Plain HTTP is for local smoke tests only.
- **Network exposure.** Postgres and the gateway publish no host ports. Only Caddy does, or nothing in tunnel mode.
  Docker-published ports bypass `ufw`, so the Hostinger panel firewall allows only 22, 80 and 443 (tcp, plus udp
  for 443).
- **Postgres.** Use a random password and a named volume. Postgres 17 only: a major upgrade needs a dump and restore.
- **Backups.** `docker compose exec -T postgres pg_dump -U gateway -Fc gateway > gateway-$(date +%F).dump`, run
  daily from cron. Keep the dumps off the VPS. They hold key hashes, sessions and redacted logs, so store them
  `chmod 600` and encrypted at rest. Restoring is `pg_restore --clean --if-exists`. Hostinger snapshots are a
  second layer, not a replacement.
- **Container.** The container runs as non-root `node`. The runtime image has no dev dependencies, sources or tests.
  `.dockerignore` keeps out `.env*` (except examples), `.git`, `node_modules` and `dist`.

## 7. Workstreams

| WS | Wave | Owns (disjoint) | Runbook |
|---|---|---|---|
| WS1 image | 1 | `apps/api/Dockerfile`, `.dockerignore`, `apps/api/src/db/migrate.ts` (new), `apps/api/scripts/migrate.ts` | `ws1-docker-image.md` |
| WS2 deploy | 1 | `deploy/**` | `ws2-deploy-compose.md` |
| WS3 upstream | 1 | `apps/api/src/**` except `db/migrate.ts`, plus `apps/api/{test,drizzle,scripts/link-team.ts,package.json,vitest.config.ts}`, `pnpm-lock.yaml`, `apps/web/src/**`, `.env.example`, `README.md` and `docs/{getting-started,authentication}.md` | `ws3-upstream-adapter.md` |
| WS4 CI | 1 | `.github/workflows/ci.yml`, `scripts/compose-smoke.sh` (new) | `ws4-ci-smoke.md` |
| WS5 review / WS6 devil's advocate / WS7 operator smoke | 2 | read-only | `ws5-…`, `ws6-…`, `ws7-…` |

Merge order: WS3, then WS1, WS2 and WS4. Each later branch merges `master` and re-runs its own acceptance checks first.

## 8. Open questions (defaults apply until decided)

1. **Delete account.** The brief lists "delete account" as a gateway call, but no route or UI calls it. Default:
   leave it out. Add `deleteAccount(accountId)` to `Upstream` together with the first route that needs it.
2. **Open sign-up on a public URL.** Strangers can create unlinked workspaces. They cannot reach the upstream, but
   they do write rows. Default: accept this for v2. Add a `SIGNUP=closed` switch if it is abused.
3. **Build on the VPS or pull a prebuilt image.** Default: `docker compose up -d` builds on the VPS (2 GB RAM or more
   recommended). Publishing to GHCR from CI would make updates faster but adds a registry and tags to maintain.
4. **Fixed upstream paths.** `/of-accounts`, `/of/*` and `/docs/json` are hard-coded in the adapter. Default: keep
   them fixed. Make them configurable only when a second upstream with different paths actually exists.

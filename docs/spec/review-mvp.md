# MVP review (code as written, slice 5)

Security and correctness review of `apps/api` and `apps/web`, plus repo hygiene. Each fix below has a regression
test. Line numbers refer to the commit that adds this file.

## Fixed

- **Playground CSRF bypass.** The playground could be steered out of `/v1`. A logged raw path such as
  `/v1/%2e%2e/api/keys/<id>`, or a `..` path param, is normalised by the browser to `/api/keys/<id>`. It was then sent
  with the cookie, `x-dashboard` and a valid Origin. `urlProblem()` now checks the URL the browser will actually send:
  `apps/web/src/features/playground/spec.ts:91`, `routes/_app/playground.tsx:81,118`. Test: `spec.test.ts`.
- **Stalled backend body gave a 500.** The timeout covered only the headers. `backend.request` now buffers the body
  inside the timeout (504 or 502), and a non-JSON account list is a 502: `apps/api/src/lib/backend.ts:36`,
  `modules/accounts/routes.ts:28`. Test: `proxy.test.ts`.
- **Account ids above int4 lost their log row.** A path like `/v1/99999999999/…` broke the `request_log` insert.
  `parseAccountId` is now shared by the proxy and capture: `modules/proxy/routes.ts:11`, `modules/logs/capture.ts:49`.
  Test: `proxy.test.ts`.
- **Redaction stored API keys in clear.** `api_key`, `apiKey`, `access-key`, `privateKey` and `credentials` were kept
  in queries and bodies. `SENSITIVE_KEY` now covers them (an extension of plan §5): `modules/logs/redact.ts:4`.
  Test: `redact.test.ts`.
- **better-auth trusted the client for IPs.** Its sign-in rate limit and session IP came from a client-sent
  `X-Forwarded-For`, so one shared bucket could be bypassed or DoSed. The bridge now overwrites `x-gateway-client-ip`
  with `request.ip`: `plugins/session.ts:52`, `auth.ts:40`. Test: `csrf.test.ts`.
- **`TRUST_PROXY=true` trusted every hop**, so `request.ip` could be spoofed. It now also accepts a hop count or proxy
  IPs/CIDRs, and the docs say `1`: `env.ts:9`. Test: `hygiene.test.ts`.
- **Workspace deletion stranded the user** on `no_workspace`. Deletion is now disabled: `auth.ts:42`. Test: `csrf.test.ts`.
- **OpenAPI merge.** Only `/of/` ops tagged `of-api` are published, and their referenced `components.schemas` are
  copied (before, `$ref`s dangled). The fetch is shared by concurrent requests, failures are cached 60 s with the last
  good spec kept, and it uses `BACKEND_TIMEOUT_MS`: `modules/openapi/routes.ts:28-95`. Test: `openapi.test.ts`.
- **JWT clock skew.** Tokens are reused only while at least 3 min of validity remain (before: 1 min): `lib/backend.ts:9`.
- **Web.** Unknown `/docs/*` paths 404 instead of serving the SPA (`plugins/web-static.ts:8`). The new key's secret is
  shown before the list refetch and not kept in the mutation cache (`keys.tsx:204`). `METHOD_TONE` is unexported.
- **Hygiene** (test: `hygiene.test.ts`). `.env.example` matches `env.ts` (added `HOST`, `BACKEND_TIMEOUT_MS`; removed
  `BACKEND_WS_URL`). `check-secrets.sh` is NUL-safe and judges by output; spaces in paths or multiple xargs batches
  used to pass silently. CI fails on migration drift. `engines` is `>=22.12` (`--env-file-if-exists`, Vite, Vitest).
  The app `package.json` files have a `license` field.

Checked and OK:
- **Proxy.** Upstream gets allow-listed headers only (no cookie, client `authorization` or `host`), and no `Set-Cookie`
  comes back. Encoded separators and dot segments are rejected. `Retry-After` and `x-ratelimit-*` are forwarded. The
  per-key limit returns 429 with `Retry-After` (now tested). A bad bearer is 401 even with a cookie, and so is a
  revoked key. `last_used_at` is written at most once a minute.
- **CSRF.** Every `/api` write (POST/PATCH/DELETE) and every cookie `/v1` request is covered. The Origin must equal
  `new URL(APP_URL).origin` exactly, and `/api/auth/*` is left to better-auth with `disableOriginCheck: false`.
- **Tenancy and logs.** Every keys, logs, usage and overview query filters by team, and by-id calls 404 across teams.
  Credential headers are never stored, bodies are redacted before truncation, `LOG_BODIES` covers both bodies, and the
  insert can't throw into the response.
- **JWT and repo.** The JWT carries exactly `{sub:int, iat, exp}`, and `team_backend` is re-read on every request.
  `db:generate` produces no diff, and `check-secrets --all` passes.

## Open (high)

- `apps/api/src/auth.ts:42` — the org plugin still exposes `invite-member`, `accept-invitation` and `update` (slug).
  With a second membership, the session hook (`auth.ts:53`, `limit(1)`, unordered) picks an arbitrary workspace. Block
  org writes in `hooks.before`, and add a unique index on `member.user_id`.
- `apps/api/src/auth.ts:44` — `user.create.after` runs after sign-up commits. If the workspace insert fails, the user
  is stuck on 403 `no_workspace`. Create the workspace idempotently on the first `loadSession`.
- The repo directory name and `docs/spec/*` contain the third-party brand. Rename and scrub before the first push.

## Open (low)

- `apps/api/src/auth.ts:30` — cookies are `Secure` only when `BETTER_AUTH_URL` is https. Production over http
  (docker compose) is not refused.
- `apps/web/src/routes/_app.tsx:17` — a network or 5xx error from `getSession` is treated as signed out. There is no
  global 401 → `/login` redirect.
- `apps/web/src/routes/_app/playground.tsx:81` — the dot-segment guard is client-side only. The server can't tell a
  replayed `/api` write from a real one.
- `apps/api/src/modules/openapi/routes.ts:59` — path-item `parameters` are dropped, and backend header params (which
  are not forwarded) are published.
- `apps/api/src/modules/proxy/routes.ts:50` — the proxy only accepts JSON bodies up to 1 MiB; anything else is 415.
- `apps/api/src/modules/logs/capture.ts:51` — `path` is stored raw: secrets in path segments are not redacted.
- `apps/api/src/modules/logs/redact.ts:66` — with `LOG_BODIES=all`, every JSON body is parsed in full. Cap the size.
- `apps/api/src/app.ts:71` — the rate-limit store is in-memory, so limits apply per process.
- `apps/api/src/db/schema.ts:16` — keys have no `expires_at`. Revocation is the only lifecycle.

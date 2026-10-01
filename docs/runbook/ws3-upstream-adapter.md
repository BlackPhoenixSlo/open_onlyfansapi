# WS3: generic bearer-token upstream adapter

Launch (from `../gateway-ws3`, branch `ws3`):
`claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws3-upstream-adapter.md)"`

## Goal

Replace the JWT-minting backend client (`apps/api/src/lib/backend.ts`) with the bearer-token adapter specified in
`docs/spec/plan-v2.md` §4. Rename the env to `UPSTREAM_URL`, `UPSTREAM_TOKEN` and `UPSTREAM_TIMEOUT_MS`. Keep every
api test green, and don't lose any. The upstream is an opaque, user-supplied HTTP service. Specify only the three
calls the gateway makes: `listAccounts`, `forward` and `openapi`. Account connection and session flows belong to the
upstream service, not this repo. Don't add code or docs for them.

## Files you own

- `apps/api/src/**`, except `apps/api/src/db/migrate.ts` (WS1)
- `apps/api/scripts/link-team.ts`: move it to `apps/api/src/db/link-team.ts` and delete the script, so it compiles
  into `dist/` and runs in the container as `node dist/db/link-team.js <slug>`
- `apps/api/test/**` (`fake-backend.ts` → `fake-upstream.ts`), `apps/api/vitest.config.ts`, `apps/api/drizzle/**`
- `apps/api/package.json` (drop `fast-jwt`; point the `link-team` script at `src/db/link-team.ts`), `pnpm-lock.yaml`
- `apps/web/src/**` (only the files that say backend, `backendUserId` or `x-backend-spec`)
- `.env.example`, `README.md`, `docs/getting-started.md`, `docs/authentication.md`

## Must not touch

`apps/api/Dockerfile`, `.dockerignore`, `apps/api/src/db/migrate.ts`, `apps/api/scripts/migrate.ts` (WS1), `deploy/**`
(WS2), `.github/**` and `scripts/**` (WS4), `docs/spec/**`, `docs/runbook/**`, the root `docker-compose.yml`, `docker/**`,
`.claude/**`.

## Read first

`docs/spec/plan-v2.md` §4–§6, then `apps/api/src/{env.ts,app.ts,lib/backend.ts,modules/proxy/routes.ts,modules/accounts/routes.ts,modules/openapi/routes.ts,modules/whoami/routes.ts,contracts.ts,db/schema.ts}`,
`apps/api/scripts/link-team.ts`, `apps/api/test/{fake-backend.ts,helpers.ts,proxy.test.ts,tenant.test.ts,openapi.test.ts,keys.test.ts,logs.test.ts,hygiene.test.ts}`,
and `grep -rln "backend" apps/web/src docs/*.md README.md`.

## Steps

1. **Baseline.** `export TEST_DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway_test_ws3`, then
   `pnpm --filter @gateway/api test 2>&1 | tail -5`. Record the passing test count (expected 66). It is the floor.
2. **`lib/upstream.ts`.** Implement `Upstream` and `createUpstream` exactly as plan-v2 §4 specifies. Keep the
   behaviour of `backend.request`: origin check, `redirect: 'manual'`, the body buffered inside the timeout, and
   502/504 `AppError`s. All three methods send `authorization: Bearer ${token}`. Delete `lib/backend.ts`.
3. **`lib/team-link.ts`.** Add `assertTeamLinked(teamId): Promise<void>` (409 `team_not_linked`). In `db/schema.ts`,
   drop the `backendUserId` column from `team_backend` (keep the table name). Run `pnpm db:generate`, which must not
   prompt. Commit the generated migration.
4. **Modules.** `proxy` keeps its raw-URL checks (`resolveUpstream` may return `{ accountId, path }` instead of a URL)
   and calls `app.upstream.forward`. `accounts` calls `listAccounts` and keeps its whitelist; its error code becomes
   `upstream_error`. `openapi` calls `upstream.openapi()` and renames its header to `x-upstream-spec`. `whoami`
   returns `team.linked: boolean` (update `contracts.ts`). `app.ts` decorates `upstream`, and `AppOptions.upstreamUrl`
   replaces `backendUrl`.
5. **`env.ts` and `.env.example`.** Remove `BACKEND_*` and add `UPSTREAM_URL` (url), `UPSTREAM_TOKEN` (`min(16)`) and
   `UPSTREAM_TIMEOUT_MS` (default 30000). In `.env.example`, use `UPSTREAM_URL=http://localhost:3001` and a blank
   `UPSTREAM_TOKEN=` with a comment saying to use `dev-upstream-token` with the fake.
6. **`link-team`.** Move it to `src/db/link-team.ts` with the usage `link-team <workspace-slug>`. It is idempotent
   (upsert) and prints the linked slug.
7. **`test/fake-upstream.ts`.** Every route requires `authorization: Bearer <token>` and answers 401 otherwise.
   `/of-accounts` returns one account list (no per-user lists). Keep the `/of/*` echo, the `slow-body` and
   `rate-limited` switches, `/docs/json` with `specFails`, and the request recorder. When the file is run directly
   (`tsx test/fake-upstream.ts`), listen on `0.0.0.0:${FAKE_UPSTREAM_PORT:-3001}` with
   `UPSTREAM_TOKEN ?? 'dev-upstream-token'` and seed account
   `{ id: 1, label: 'Demo', ofUsername: 'demo', ofDisplayName: 'Demo', ofAvatarUrl: null, status: 'active' }`.
8. **Tests.** Replace the `jwt.sub` assertions with "upstream saw `authorization: Bearer <UPSTREAM_TOKEN>`, and never
   the client's `gk_` key or cookie". Tenant tests: keep keys/logs isolation; replace the "acts as A's backend user"
   case with "an unlinked workspace gets 409 `team_not_linked` and no upstream request is made". `keys.test.ts`
   expects `team.linked === false`. Update `vitest.config.ts` (`UPSTREAM_URL`, `UPSTREAM_TOKEN`,
   `UPSTREAM_TIMEOUT_MS=2000`). Don't delete a test unless you replace it with one that covers the same risk.
9. **Web and docs.** Update the `team_not_linked` hints (`link-team <slug>`, no id), the Settings "linked" state, the
   playground's `x-upstream-spec` check, and the backend wording in `README.md`, `docs/getting-started.md` and
   `docs/authentication.md`. Add the fake-upstream dev command to getting-started, and a README line that points to
   `deploy/hostinger.md` for VPS deploys. Don't describe the upstream beyond its three calls.

## Acceptance (all must pass)

```sh
export TEST_DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway_test_ws3
pnpm install --frozen-lockfile
pnpm db:generate && test -z "$(git status --porcelain apps/api/drizzle)"
pnpm -r typecheck
pnpm --filter @gateway/api test 2>&1 | tail -5        # all green, passing count >= baseline (66)
pnpm --filter @gateway/web test
pnpm build
sh scripts/check-secrets.sh --all
! grep -rnE "BACKEND_|fast-jwt|createBackend|backendUserId|x-backend-spec|backend_error" \
    apps/api/src apps/api/test apps/web/src docs/*.md README.md .env.example
test ! -e apps/api/src/lib/backend.ts && test ! -e apps/api/scripts/link-team.ts && test -f apps/api/src/lib/upstream.ts
```

## Verification by hand

`UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts`, then
`curl -s -H 'authorization: Bearer dev-upstream-token' localhost:3001/of-accounts` returns the demo account, and the
same call without the header returns 401. Stop the fake afterwards.

## Commits

Use small logical commits, for example `refactor(api): bearer upstream adapter`, `feat(db): drop team_backend.backend_user_id`,
`test(api): fake upstream`, `docs: upstream env`.

```sh
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "<type>(<scope>): <summary>" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report: the files changed, the baseline and final test counts, the acceptance output tail, and any spec deviation
with its reason.

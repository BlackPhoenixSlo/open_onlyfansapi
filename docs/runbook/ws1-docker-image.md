# WS1: production Docker image

Launch (from `../gateway-ws1`, branch `ws1`):
`claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws1-docker-image.md)"`

## Goal

Build one image that serves the API and the dashboard. It uses a multi-stage build: build web, build api, then a
slim runtime. It runs as a non-root user, has a healthcheck and applies migrations on start. This is the `gateway`
service of `docs/spec/plan-v2.md` §3.

## Files you own

- `apps/api/Dockerfile` (new)
- `.dockerignore` (new, repo root; the build context is the repo root)
- `apps/api/src/db/migrate.ts` (new): move `runMigrations` and the "run when executed directly" block here from
  `scripts/migrate.ts`. It must not import `env.ts`; it reads `DATABASE_URL` or `argv[2]`. The migrations folder is
  `new URL('../../drizzle', import.meta.url)`, which resolves from both `src/db/` and `dist/db/`.
- `apps/api/scripts/migrate.ts`: reduce it to a thin wrapper that re-exports `runMigrations` (`test/global-setup.ts`
  imports it) and still runs migrations when executed (`pnpm db:migrate` keeps working unchanged).

## Must not touch

Everything else. In particular: `apps/api/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (no new
dependencies), other files under `apps/api/src/**` and `apps/api/test/**` (WS3), `deploy/**` (WS2), `.github/**`,
`scripts/**` (WS4), the root `docker-compose.yml`, `docs/**`.

## Read first

`docs/spec/plan-v2.md` §3 and §6, `package.json` (the `packageManager` pin and the `build` script),
`apps/api/{package.json,tsconfig.build.json}`, `apps/api/src/{server.ts,plugins/web-static.ts}`,
`apps/api/scripts/migrate.ts`, `apps/api/test/global-setup.ts`, `apps/web/package.json`, `.gitignore`.

## Requirements

- **Build stages.** Use `node:22-alpine` and pnpm from the `packageManager` pin (corepack). Run
  `pnpm install --frozen-lockfile` with the manifests copied first for layer caching, then `pnpm build` (web, then api).
- **Runtime stage.** Use `node:22-alpine` with `NODE_ENV=production`. Copy production dependencies only (for example
  `pnpm --filter @gateway/api deploy --prod --legacy <dir>`; pnpm 10 needs `--legacy` without
  `inject-workspace-packages`). Use this layout: `/app/apps/api/{dist,drizzle,node_modules,package.json}` and
  `/app/apps/web/dist`. `plugins/web-static.ts` resolves `../../../web/dist` from `dist/plugins/`.
  `WORKDIR /app/apps/api`, `USER node`, `EXPOSE 4000`.
- **Healthcheck.** `HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
- **Start.** `CMD ["sh","-c","node dist/db/migrate.js && exec node dist/server.js"]`.
- **`.dockerignore`.** Exclude `**/node_modules`, `**/dist`, `.git`, `**/.env*`, `coverage`, `.claude`, `deploy`, `docs`, and the mirror paths from `.gitignore`.
- **Env names.** Don't hard-code them in the image. Before WS3 merges, the app reads `BACKEND_*`; after, it reads
  `UPSTREAM_*`. The acceptance run below passes both sets, so it works either way (`env.ts` ignores unknown keys).

## Acceptance (all must pass)

```sh
export TEST_DATABASE_URL=postgres://gateway:gateway@localhost:5434/gateway_test_ws1
pnpm --filter @gateway/api typecheck && pnpm --filter @gateway/api test 2>&1 | tail -5   # all green
pnpm --filter @gateway/api exec tsx scripts/migrate.ts "$TEST_DATABASE_URL"            # wrapper still runs (no .env in worktrees)
docker build -f apps/api/Dockerfile -t gateway:ws1 .
test "$(docker run --rm --entrypoint id gateway:ws1 -u)" != 0
docker run --rm --entrypoint sh gateway:ws1 -c \
  'test -f /app/apps/web/dist/index.html && test -d drizzle && test -f dist/db/migrate.js && test ! -e src && test ! -e test && test ! -e node_modules/vitest && test ! -e node_modules/typescript'
docker exec gateway-postgres-1 createdb -U gateway gateway_ws1
docker run -d --name gw-ws1 -p 4001:4000 --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgres://gateway:gateway@host.docker.internal:5434/gateway_ws1 \
  -e APP_URL=http://localhost:4001 -e BETTER_AUTH_URL=http://localhost:4001 \
  -e BETTER_AUTH_SECRET=ws1-local-only-secret-0123456789 \
  -e UPSTREAM_URL=http://127.0.0.1:9 -e UPSTREAM_TOKEN=ws1-local-only-token \
  -e BACKEND_URL=http://127.0.0.1:9 -e BACKEND_JWT_SECRET=ws1-local-only \
  gateway:ws1
curl -fsS --retry 30 --retry-connrefused --retry-delay 2 http://localhost:4001/healthz      # {"ok":true}
docker logs gw-ws1 2>&1 | grep -q "migrations applied"
curl -fsS -H 'accept: text/html' http://localhost:4001/login | grep -q '<div id="root">'
docker inspect -f '{{.State.Health.Status}}' gw-ws1                                        # "healthy" within 60 s (poll)
docker rm -f gw-ws1 && docker exec gateway-postgres-1 dropdb -U gateway gateway_ws1
```

Restarting the container must not fail on already-applied migrations. Check this with
`docker restart gw-ws1` before the cleanup line, then curl `/healthz` again.

## Commits

For example `build(api): multi-stage Dockerfile` and `refactor(api): compile migrate into dist`.

```sh
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "<type>(<scope>): <summary>" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report: the files changed, the image size (`docker image ls gateway:ws1`), the acceptance output tail, and any deviation.

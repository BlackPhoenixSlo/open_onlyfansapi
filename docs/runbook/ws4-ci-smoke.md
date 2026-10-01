# WS4: CI docker build and compose smoke test

Launch (from `../gateway-ws4`, branch `ws4`):
`claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws4-ci-smoke.md)"`

## Goal

CI proves on every push and PR that the image builds and that the production stack (`deploy/docker-compose.yml`)
boots and answers `/healthz` through Caddy on `http://localhost`. `PUBLIC_URL=http://localhost` turns automatic TLS
off. Put the smoke steps in one script that humans and CI run the same way.

## Files you own

- `.github/workflows/ci.yml`: keep the existing `check` job unchanged, except set `on.push.branches` to `[master]`
  (the repo's only branch; `main` never matches). Add a `docker` job.
- `scripts/compose-smoke.sh` (new, POSIX `sh`).

## Must not touch

`apps/**` (WS1/WS3), `deploy/**` (WS2), `.dockerignore`, `scripts/check-secrets.sh`, `docs/**`, the root
`docker-compose.yml`. If the smoke test fails because of one of those files, report it. Don't patch around it.

## Read first

`docs/spec/plan-v2.md` §3, §5 and §6, the current `.github/workflows/ci.yml`, `scripts/check-secrets.sh` (for
style), and `docs/runbook/ws1-docker-image.md` and `ws2-deploy-compose.md` (the contracts you test; those files may
not exist on your branch yet).

## Requirements

**`scripts/compose-smoke.sh`** runs from any cwd: it `cd`s to the repo root first. It uses `set -eu` and:
1. Writes a temp env file with `COMPOSE_PROFILES=caddy`, `PUBLIC_URL=http://localhost`, `POSTGRES_PASSWORD` and
   `BETTER_AUTH_SECRET` from `openssl rand -hex 24`, `UPSTREAM_URL=http://upstream.invalid` and
   `UPSTREAM_TOKEN=smoke-only-upstream-token`.
2. Defines `dc() { docker compose -p gateway-smoke --env-file "$ENV" -f deploy/docker-compose.yml "$@"; }`. The
   separate project name means a real local stack is never touched.
3. Sets `trap` on EXIT: if the exit status is non-zero, print `dc ps` and the last 100 log lines of `gateway` and
   `caddy`. Then always run `dc down -v --remove-orphans` and remove the env file.
4. Runs `dc up -d --build --wait --wait-timeout 180`.
5. Asserts, failing with a clear message on each:
   - `curl -fsS --retry 15 --retry-connrefused --retry-delay 2 http://localhost/healthz` contains `"ok":true`.
   - `curl -fsS -H 'accept: text/html' http://localhost/login` contains `<div id="root">` (the SPA is served).
   - `curl -sSI http://localhost/openapi.json` is `200` with `x-upstream-spec: unavailable` (the upstream is
     unreachable, and the gateway degrades instead of failing).
   - `dc port postgres 5432` and `dc port gateway 4000` both fail (nothing published but Caddy).
   - `dc exec -T gateway id -u` is not `0`.
6. Prints `compose smoke: ok`.

**`docker` job** in `ci.yml`: `runs-on: ubuntu-latest`, `actions/checkout@v4`, then a step
`docker build -f apps/api/Dockerfile -t gateway:ci .`, then a step `sh scripts/compose-smoke.sh`. No registry login,
no push, no extra actions.

## Acceptance

On your branch, before WS1, WS2 and WS3 are merged:

```sh
sh -n scripts/compose-smoke.sh
command -v shellcheck >/dev/null && shellcheck scripts/compose-smoke.sh || echo "shellcheck not installed; skipped"
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
git diff master -- .github/workflows/ci.yml          # the check job is unchanged apart from the branch name
sh scripts/check-secrets.sh --all
```

At merge time (WS4 merges last), run `git merge master` in this worktree, which brings in WS1, WS2 and WS3. Then:

```sh
sh scripts/compose-smoke.sh                           # prints "compose smoke: ok", exit 0
test -z "$(docker compose ls -a -q --filter name=gateway-smoke)"                               # cleaned up
```

Also check the failure path once. Temporarily edit the script to set `UPSTREAM_TOKEN=short`, which fails
`min(16)` in `env.ts`, so the gateway never turns healthy. The script exits non-zero, prints the gateway logs and still cleans up. Revert the edit
before you commit.

## Commits

For example `ci: docker build and compose smoke job` and `build: compose smoke script`.

```sh
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "<type>(<scope>): <summary>" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report: the files changed, the actionlint result, the smoke output (or "pending merge" if WS1, WS2 or WS3 is
missing), and any deviation.

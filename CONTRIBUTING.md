# Contributing

Thanks for looking at this. The project is a self-hostable API gateway and dashboard; issues and pull
requests are welcome.

## Run it locally

Follow [docs/getting-started.md](docs/getting-started.md) — it covers the prerequisites, the Postgres
container, `.env`, migrations and the first API call. The short version is in the
[README](README.md#develop-locally). Don't duplicate setup steps in a PR description; link to that guide.

## Checks

```sh
pnpm -r typecheck            # both apps
pnpm -r test                 # vitest; uses the gateway_test database from docker compose
pnpm db:generate             # after a schema change: commit the generated migration
sh scripts/check-secrets.sh --all
```

A pull request must pass `pnpm -r typecheck && pnpm -r test` and `sh scripts/check-secrets.sh --all`.
CI runs those, plus a check that `apps/api/drizzle` is in sync with the schema, and a `docker` job that
builds the image and runs `sh scripts/compose-smoke.sh`. Add or update a test with any behaviour change;
auth, tenant isolation and the proxy path have tests that are meant to stay green.

Before a public release, `sh scripts/prepublish-check.sh` must also pass. See [SECURITY.md](SECURITY.md)
for how to report a vulnerability instead of opening an issue.

## Commits

Conventional-commit style, lower-case, imperative, optional scope:

```
feat(api): request logs and usage
fix(web): session refresh on 401
chore: pnpm workspace scaffold
docs: getting started
```

Scopes in use: `api`, `web`. Keep a commit to one concern and keep the subject under ~72 characters;
put the detail in the body.

## Pull requests

- Branch off `master`, one topic per PR.
- Say what changed and how you verified it (the commands you ran).
- No secrets, no `.env`, no third-party API mirrors or vendor brand names in code, tests or docs.
- Database changes ship with their generated migration in the same commit.

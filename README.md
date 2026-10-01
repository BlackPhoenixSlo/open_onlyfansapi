# Gateway

A self-hostable API gateway and dashboard in front of a creator-account service: API keys with scopes and
per-account allowlists, a raw proxy to that upstream's account API, request logs, usage, a playground and an
OpenAPI reference. Webhooks come later. The product name is a placeholder.

> **Not affiliated.** This project is unofficial and is not affiliated with, endorsed by or connected to any
> content platform or its operators. Users are responsible for complying with the terms of the platforms they use.

## Quick start

Requires Node 22.12+, pnpm 10 and Docker.

```sh
docker compose up -d                 # Postgres 17 on :5434 (+ gateway_test database)
cp .env.example .env                 # set BETTER_AUTH_SECRET, UPSTREAM_URL and UPSTREAM_TOKEN
pnpm install
pnpm db:migrate
pnpm dev                             # api on :4000, dashboard on :5173
```

Without an upstream service at hand, run the fake one the tests use:

```sh
UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts
```

Register at http://localhost:5173 (a workspace is created for you), then link the workspace so it may reach
the upstream:

```sh
pnpm --filter @gateway/api link-team <workspace-slug>
```

Create a key on the **API keys** page and call the API:

```sh
curl -H "Authorization: Bearer $KEY" http://localhost:4000/v1/whoami
curl -H "Authorization: Bearer $KEY" http://localhost:4000/v1/accounts
curl -H "Authorization: Bearer $KEY" http://localhost:4000/v1/$ACCOUNT_ID/users/me
```

`pnpm -r typecheck` and `pnpm -r test` run the checks (tests use the `gateway_test` database).
`pnpm build` builds both apps; in production the api serves the dashboard from `apps/web/dist`.

## Docs

- [Getting started](docs/getting-started.md): run the gateway, link a workspace, make a first call.
- [Authentication](docs/authentication.md): API keys, scopes, account allowlists, sessions, rate limits and errors.
- [Hostinger deploy](deploy/hostinger.md): run the whole stack on a Docker VPS with HTTPS.

A running gateway also serves its OpenAPI spec at `/openapi.json` and an interactive API reference at `/docs`.

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).

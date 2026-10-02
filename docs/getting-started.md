# Getting started

This guide runs the gateway on your machine, links a workspace to the upstream and makes a first API call.

## Prerequisites

- Node 22.12 or newer
- pnpm 10
- Docker (for Postgres)
- An upstream service the gateway can reach, and its bearer token (or the fake upstream from step 3)

## 1. Start the database

```sh
docker compose up -d
```

This starts Postgres 17 on port `5434` (user, password and database are all `gateway`). A second database,
`gateway_test`, is created for the test suite.

## 2. Configure

```sh
cp .env.example .env
```

Set these values in `.env`:

| Variable | What to put there |
|---|---|
| `BETTER_AUTH_SECRET` | A random secret of at least 16 characters. `openssl rand -base64 32` works. |
| `UPSTREAM_URL` | The upstream service's origin. Defaults to `http://localhost:3001`. |
| `UPSTREAM_TOKEN` | The bearer token the gateway sends on every upstream call (at least 16 characters; letters, digits and `-._~` only, e.g. `openssl rand -hex 32`, because it also travels as a WebSocket subprotocol). Use `dev-upstream-token` with the fake upstream. |

`.env.example` already fills in the rest for local use. `APP_URL` is the dashboard origin
(`http://localhost:5173`) and `BETTER_AUTH_URL` is where the API serves sign-in (`http://localhost:4000`).
`DATABASE_URL` points at the Postgres from step 1. The API exits on start with a list of problems if a
required value is missing or invalid.

## 3. Install, migrate, run

```sh
pnpm install
pnpm db:migrate
pnpm dev
```

The API listens on `http://localhost:4000` and the dashboard on `http://localhost:5173`. In development the
dashboard forwards `/api` and `/v1` to the API.

Without a real upstream, run the fake one the tests use in a second terminal:

```sh
UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts
```

It listens on `0.0.0.0:3001` (`FAKE_UPSTREAM_PORT` to change that), requires
`authorization: Bearer dev-upstream-token` and serves one account with id `1`.

## 4. Sign up and link your workspace

Open http://localhost:5173 and register. A workspace is created for you.

The workspace must be linked before it may reach the upstream; the link is the operator's approval step.
Until then, calls that would reach the upstream fail with `409 team_not_linked`. Find your workspace slug on
the **Settings** page, then run:

```sh
pnpm --filter @gateway/api link-team <workspace-slug>
```

Running the command again is harmless. Accounts themselves are connected in the upstream service, not in the
gateway.

## 5. Create an API key

Go to **API keys** and create a key. Pick a scope (`read` or `write`) and, if you like, limit it to some
accounts. The secret is shown once, so copy it now. See [authentication.md](authentication.md) for details.

```sh
export API_KEY=gk_...
```

## 6. Make your first calls

```sh
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/whoami
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/accounts
```

`/v1/whoami` shows the workspace and key. `/v1/accounts` lists the accounts the key can use. Take an `id`
from that list (the **Accounts** page shows the same list) and call the upstream through the gateway:

```sh
export ACCOUNT_ID=123
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/$ACCOUNT_ID/users/me
```

Anything under `/v1/{account}/` is forwarded to the upstream's account API for that account. The upstream's
response, including errors, comes back unchanged.

## 7. Explore the API

- **Playground** (`/playground` in the dashboard): pick an operation (grouped by tag, with search) and an
  account, edit path parameters, query rows and a JSON body, then press Send. You see the status, latency,
  headers and JSON response, and a curl snippet that uses `$API_KEY`. Requests use your dashboard session,
  so no key is needed in the browser; account operations sent from it are logged with the key "Dashboard". The
  dashboard's own calls to gateway routes (such as `/v1/webhooks`) are not logged.
- **`GET /openapi.json`**: the OpenAPI spec. It holds the gateway's own `/v1` routes plus the upstream's
  account operations, mapped to `/v1/{account}/...` under the `platform` tag. If the upstream's spec can't be
  fetched, you get the gateway routes only and the response header `x-upstream-spec: unavailable`. The spec
  is cached for 10 minutes.
- **`GET /docs`**: an interactive API reference built from `/openapi.json`. Both are public.

## 8. Logs and usage

- **Logs** lists every authenticated `/v1` request with its status, latency, key and account. Open a row
  for headers and, when stored, bodies. "Open in playground" fills the playground with the same method,
  path, query and body.
- **Usage** charts requests and errors per day and breaks them down by key, account or endpoint.

Bodies are stored only for failed requests (status 400 and up) by default. Set `LOG_BODIES` to `all` or
`none` to change that. Logs are kept for `LOG_RETENTION_DAYS` days (14 by default).

## Production

```sh
pnpm build
NODE_ENV=production pnpm --filter @gateway/api start
```

`pnpm build` builds both apps. With `NODE_ENV=production` the API also serves the dashboard from
`apps/web/dist`, so the API and dashboard share one origin. Set `APP_URL` and `BETTER_AUTH_URL` to that
public URL, and `TRUST_PROXY=1` if one reverse proxy sits in front (a hop count or the proxies' IPs/CIDRs;
`true` would trust a client-sent `X-Forwarded-For`).

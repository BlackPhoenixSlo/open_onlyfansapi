# Getting started

This guide runs the gateway on your machine, links a workspace to the upstream and makes a first API call.

## Prerequisites

- Node 22.12 or newer
- pnpm 10
- Docker (for Postgres)
- An upstream: the one in `services/upstream`, the fake one the tests use, or your own (step 3)

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

### Email verification

New accounts must confirm their email address before they can sign in. Email verification requires `SMTP_*`
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`; e.g.
`mail.privateemail.com`, port `587` for STARTTLS or `465` for TLS). Without `SMTP_HOST` no mail is sent and the
link is printed in the API logs instead, which is enough for local use. Accounts created before this existed
are marked verified by the migration.

## 3. Install, migrate, run

```sh
pnpm install
pnpm db:migrate
pnpm dev
```

The API listens on `http://localhost:4000` and the dashboard on `http://localhost:5173`. In development the
dashboard forwards `/api` and `/v1` to the API.

### The upstream

Both options below listen on port 3001 (the default `UPSTREAM_URL`), so run one or the other.

**The fake upstream** needs no OF account. In a second terminal:

```sh
UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts
```

It listens on `0.0.0.0:3001` (`FAKE_UPSTREAM_PORT` to change that), requires
`authorization: Bearer dev-upstream-token` and serves one account with id `1`.

**The real upstream** (`services/upstream`) talks to OF. The root compose file runs it under the `upstream`
profile on `127.0.0.1:3001`, with its sessions in the `upstream-data` volume. It takes `UPSTREAM_TOKEN` from
your shell or the root `.env` (default `dev-upstream-token`):

```sh
docker compose --profile upstream up -d --build upstream
```

Connect an account with a curl copied from Chrome (DevTools → Network → a request to `onlyfans.com/api2/v2/…` →
Copy as cURL (bash); it must carry the cookies as `-b '…'`) and a proxy for that account. The upstream refuses an
account without a proxy only when `OF_REQUIRE_PROXY=true`; by default an account with no proxy connects from the server's own IP.

From the dashboard (once your workspace is signed up and linked, §4): **Accounts → Connect account**, paste the
cURL, optionally a nickname, and the proxy URL (`http://user:pass@host:port` or `socks5h://…`). The gateway
forwards it to the upstream's `/session/bootstrap` and never stores the cURL in the request log.

Or from the command line:

```sh
docker compose exec -T upstream python connect.py --nickname Main --proxy-url socks5h://user:pass@host:port < curl.txt
```

OF's static signing parameter comes from `--static-param <value>` on that command, or from `STATIC_PARAM` in
the upstream's environment (`STATIC_PARAM=… docker compose --profile upstream up -d upstream`). The deploy
equivalent is in [deploy/hostinger.md §7](../deploy/hostinger.md#7-connect-an-of-account).

**Events.** To feed webhooks and the `/v1/ws` socket ([realtime.md](realtime.md)), point the gateway at the
upstream's event socket in `.env` and restart `pnpm dev`. Both upstreams above serve it:

```sh
UPSTREAM_WS_URL=ws://localhost:3001/ws
```

Left empty, there is no event source and `/v1/ws` answers 503.

## 4. Sign up

Open http://localhost:5173 and register, then open the verification link (from your inbox, or the API log
without SMTP). It signs you in. A workspace is created for you and linked to the upstream automatically.

An unlinked workspace gets `409 team_not_linked` on calls that would reach the upstream. If **Settings** shows
yours as not linked (the automatic link failed; the API log says why), copy the slug from there and run:

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
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/$ACCOUNT_ID/me
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

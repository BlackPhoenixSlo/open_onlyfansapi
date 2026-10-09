# Video script: overview, setup and deploy

A shot list for a video of about 3:40. Commands come from the [README](../README.md),
[getting-started.md](getting-started.md) and [deploy/hostinger.md](../deploy/hostinger.md).
Durations assume narration at about 150 words a minute.

## How to record

Record with QuickTime (File → New Screen Recording) or OBS at 1440x900, the size of the generated media. Run
`pnpm media` first, against a running stack with a linked workspace (`BASE_URL`, default `http://localhost`; set
`DATABASE_URL` to the gateway database so a fresh account is marked verified): it
writes the PNGs and `docs/media/overview.webm`, the b-roll for section (b). Use a light terminal theme at 20 pt or
larger and clear it between shots. Keep real secrets off screen: show `.env` only with placeholder values, use
`gw.example.com` for the domain, and cut away from the dialog that shows a new API key. Record the narration
separately and lay it over the shots.

## (a) Cold open (0:20)

| Shot | On screen | Narration (spoken) | Duration |
|---|---|---|---|
| A1 | `docs/media/home.png`, slow zoom on the KPI cards | You run an upstream service with one bearer token. Your users want their own keys, logs and usage, never that token. | 0:08 |
| A2 | README, the "How it fits" diagram | OpenOnlyfansAPI is a self-hosted API gateway and dashboard that sits in front of it, issues scoped keys and records every call. | 0:08 |
| A3 | Quick cuts: `keys.png`, `logs.png`, a terminal | Here's the dashboard, local setup, and a VPS deploy. | 0:04 |

## (b) Dashboard tour (1:00)

B-roll is `docs/media/overview.webm`; the times in brackets are its timestamps. Hold a frame where the line runs
longer than the clip.

| Shot | On screen | Narration (spoken) | Duration |
|---|---|---|---|
| B1 | [0:00–0:04] Home: requests (24h), error rate, active keys | Each workspace gets a dashboard. Home shows requests and error rate for the last 24 hours, and how many keys are active. | 0:08 |
| B2 | [0:05–0:08] Accounts: the Demo account, id 1 | Accounts come from your upstream. The operator links a workspace once; after that its accounts appear here. | 0:07 |
| B3 | [0:08–0:12] API keys: `demo-read`, scope `read`, active | Keys are scoped read or write, optionally limited to some accounts. The secret is shown once and stored only as a hash. | 0:09 |
| B4 | [0:12–0:20] Playground: search "me", pick `GET /me`, Send, 200, open Headers | The playground lists every operation from the merged spec. Pick one, pick an account, send. You get status, latency, headers and a curl snippet. | 0:10 |
| B5 | [0:21–0:27] Logs list, then one request's detail page | Every authenticated call lands in Logs with key, account and timing. Credential headers are never stored; bodies are kept only for failed requests by default. | 0:10 |
| B6 | [0:28–0:34] Usage: daily chart, then grouped by key and by endpoint | Usage charts requests and errors per day, broken down by key, account or endpoint, with a CSV export. | 0:08 |
| B7 | [0:35–0:47] `/docs`: the API reference, scrolling to the platform operations | And slash docs is an interactive API reference: OpenOnlyfansAPI's own routes plus your upstream's operations, rewritten under slash v1 slash account. | 0:08 |

## (c) Develop locally (0:56)

Terminal in the repo root, browser on the right.

| Shot | On screen | Narration (spoken) | Duration |
|---|---|---|---|
| C1 | `pnpm install`, then `docker compose up -d`: the Postgres container starts | To develop locally you need Node 22.12, pnpm 10 and Docker. Install, then start Postgres with docker compose. | 0:08 |
| C2 | `cp .env.example .env`; `openssl rand -base64 32`; the editor with `BETTER_AUTH_SECRET` set and `UPSTREAM_TOKEN=dev-upstream-token` | Copy the example env file. Set an auth secret, and use dev-upstream-token as the upstream token for the fake upstream. | 0:08 |
| C3 | `pnpm db:migrate`, then `pnpm dev`: API on `http://localhost:4000`, dashboard on `http://localhost:5173` | Run the migrations, then pnpm dev. The API listens on port 4000, the dashboard on 5173. | 0:07 |
| C4 | Second terminal: `UPSTREAM_TOKEN=dev-upstream-token pnpm --filter @gateway/api exec tsx test/fake-upstream.ts` prints `fake upstream listening on …:3001` | No upstream yet? In a second terminal, start the fake one the tests use. It serves one account with id 1. | 0:08 |
| C5 | Browser: http://localhost:5173, Register; open the verification link from the API log; then Settings, copy the slug | Register at localhost 5173 and open the verification link. That creates your workspace. Copy its slug from Settings. | 0:07 |
| C6 | `pnpm --filter @gateway/api link-team <workspace-slug>` prints `linked workspace …`; reload Accounts, the Demo row appears | Linking is the operator's approval step. Run link-team with the slug, reload Accounts, and the demo account appears. | 0:08 |
| C7 | API keys → Create key (cut the secret dialog); terminal: `export API_KEY=gk_...`, `export ACCOUNT_ID=123` (type `1`, the fake upstream's account), `curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/v1/$ACCOUNT_ID/me` returns `{"echo":true,…}` | Create a key; the secret is shown once. Export it, then call slash v1, account one, me. The fake upstream echoes it back. | 0:10 |

## (d) Deploy to a VPS (1:11)

SSH session on a Docker VPS (`ssh root@<vps-ip>`), browser on the right. This is the short path from
`deploy/hostinger.md`; it covers the firewall, backups and troubleshooting.

| Shot | On screen | Narration (spoken) | Duration |
|---|---|---|---|
| D1 | DNS provider: an A record for `gw.example.com`; then `dig +short gw.example.com` prints the VPS IP | Point an A record at the VPS and check it with dig before starting, because Caddy requests the certificate on first boot. | 0:08 |
| D2 | `git clone https://github.com/BlackPhoenixSlo/gateway.git /opt/gateway`, then `cd /opt/gateway/deploy` | On a Docker VPS with at least 2 gigabytes of RAM, since the image builds there, clone the repo into opt gateway. | 0:09 |
| D3 | `cp .env.example .env && chmod 600 .env`; `openssl rand -hex 24`; `openssl rand -base64 32`; `nano .env` with placeholder values | Copy the env file and fill four values: public URL and three generated secrets. Single-quote any value containing a dollar sign. | 0:10 |
| D4 | Close-up of `.env`: `UPSTREAM_URL=http://upstream:8000` and `UPSTREAM_TOKEN` | The upstream token needs at least 16 characters, from `openssl rand -hex 32`. The bundled upstream's URL is already filled in. | 0:08 |
| D5 | `docker compose up -d --build --wait`: build output (jump cut), then the containers report healthy | Start it with docker compose up, build, wait. The first build takes a few minutes; migrations run on every start. | 0:09 |
| D6 | `curl -fsS https://gw.example.com/healthz` prints `{"ok":true}`; browser padlock on `https://gw.example.com` | Check healthz over HTTPS; Caddy already holds the certificate. If it fails, PUBLIC_URL must be the bare origin, no trailing slash. | 0:09 |
| D7 | Browser: sign up on `https://gw.example.com`, open the verification link from the email, then Settings, copy the slug | Open your domain, sign up and open the verification link. Sign-up is open, but a new workspace reaches nothing until you approve it. Copy the slug. | 0:09 |
| D8 | `docker compose exec gateway node dist/db/link-team.js <slug>` prints `linked workspace …`; reload Accounts | Approve it from the VPS shell with link-team. A typo prints no workspace with slug; copy it again from Settings. Reload Accounts. | 0:09 |

## (e) Close (0:15)

| Shot | On screen | Narration (spoken) | Duration |
|---|---|---|---|
| E1 | README, the Licence section | OpenOnlyfansAPI is AGPL-licensed open source. If you run a modified version as a service, share its source. | 0:06 |
| E2 | The repo's Issues tab, then `SECURITY.md` | Report bugs in GitHub issues. Report security problems privately, as SECURITY.md describes. | 0:05 |
| E3 | README, the "Not affiliated" note, then the repo URL | OpenOnlyfansAPI is unofficial and not affiliated with any platform. Thanks for watching. | 0:04 |

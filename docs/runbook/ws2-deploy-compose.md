# WS2: production compose stack and Hostinger guide

Launch (from `../gateway-ws2`, branch `ws2`):
`claude --agent implementer --permission-mode acceptEdits "$(cat docs/runbook/ws2-deploy-compose.md)"`

## Goal

Make `cd deploy && cp .env.example .env && <edit> && docker compose up -d` bring up the full stack on a Docker VPS:
`gateway`, `postgres` (volume) and `caddy` (TLS for one domain), plus an optional `cloudflared` profile. Also write
the operator guide for Hostinger. The upstream is an opaque, user-supplied service (`UPSTREAM_URL` +
`UPSTREAM_TOKEN`). Account connection and session flows belong to the upstream service, not this repo. Say exactly
that in the guide and nothing more.

## Files you own

`deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example` and `deploy/hostinger.md` (all new).

## Must not touch

Everything outside `deploy/`. In particular: the root `docker-compose.yml` (dev Postgres), `apps/**` (WS1/WS3),
`.github/**`, `scripts/**` (WS4), `README.md` (WS3 adds the link to your guide), `.gitignore` (it already ignores
`deploy/.env` and keeps `deploy/.env.example`).

## Read first

`docs/spec/plan-v2.md` §2, §3, §5 and §6 (these are binding: services, ports, profiles, env and security),
`apps/api/src/env.ts`, the root `docker-compose.yml`, and `.env.example`.

## Requirements

- **`docker-compose.yml`.** Build the services as the plan-v2 §3 table describes:
  - `gateway`: `build: { context: .., dockerfile: apps/api/Dockerfile }` with `image: gateway:local`, no `ports:`,
    and `expose: ["4000"]`.
  - `postgres`: no `ports:`, named volume `pgdata`, healthcheck `pg_isready -U gateway`.
  - `caddy`: under `profiles: [caddy]`, with `80:80`, `443:443`, `443:443/udp` and volumes `caddy_data` and `caddy_config`.
  - `cloudflared`: under `profiles: [tunnel]`, with a pinned image tag.
  - Set `depends_on` with `condition: service_healthy`, `restart: unless-stopped` and json-file log rotation
    (`10m` × 3) via a YAML anchor.
- **Gateway environment.** List it explicitly, not with `env_file`, so `POSTGRES_PASSWORD` and `TUNNEL_TOKEN` only
  reach the services that need them. Use `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=4000`, `TRUST_PROXY=1`,
  `DATABASE_URL=postgres://gateway:${POSTGRES_PASSWORD:?}@postgres:5432/gateway` and
  `APP_URL=BETTER_AUTH_URL=${PUBLIC_URL:?}`, plus `BETTER_AUTH_SECRET`, `UPSTREAM_URL`, `UPSTREAM_TOKEN` (all `:?`
  required) and `UPSTREAM_TIMEOUT_MS=${UPSTREAM_TIMEOUT_MS:-30000}`.
- **`Caddyfile`.** One site block: `{$PUBLIC_URL}` containing `encode zstd gzip` and `reverse_proxy gateway:4000`.
  Use no global options unless a requirement needs one.
- **`.env.example`.** Include `COMPOSE_PROFILES=caddy`, `PUBLIC_URL=https://gw.example.com`, `POSTGRES_PASSWORD=`,
  `BETTER_AUTH_SECRET=`, `UPSTREAM_URL=`, `UPSTREAM_TOKEN=`, `# UPSTREAM_TIMEOUT_MS=30000` and `# TUNNEL_TOKEN=`.
  Give each a one-line comment (generation command, what it is). No real-looking secrets.
- **`hostinger.md`** covers these sections, each as numbered shell steps:
  1. Create the VPS: a KVM plan, Ubuntu 24.04 with the Docker template, 2 GB RAM or more. In the panel firewall
     allow 22, 80, 443/tcp and 443/udp. Note that Docker-published ports bypass `ufw`.
  2. DNS: an A (and AAAA) record to the VPS IP. Check it with `dig +short`.
  3. Clone into `/opt/gateway`.
  4. Env: copy `.env.example` to `.env`, `chmod 600`, and generate the secrets.
  5. `docker compose up -d`. The first run builds the image and takes a few minutes. Then `docker compose ps` and
     `curl -fsS https://<domain>/healthz`.
  6. First user: sign up in the browser, read the slug on Settings, run
     `docker compose exec gateway node dist/db/link-team.js <slug>`, and check that the Accounts page lists the
     upstream accounts.
  7. Updates: `git pull && docker compose up -d --build`. Migrations run on start and are forward-only, so take a
     backup before updating.
  8. Backup and restore: the `pg_dump -Fc` command, a daily cron line, copying dumps off the VPS, `pg_restore --clean
     --if-exists`, and Hostinger snapshots as a second layer.
  9. Logs: `docker compose logs -f gateway caddy`, the rotation limits, and the dashboard's request logs.
  10. Optional Cloudflare Tunnel: set `COMPOSE_PROFILES=tunnel` and `TUNNEL_TOKEN`, point the public hostname at
     `http://gateway:4000`, close 80 and 443 in the firewall. `TRUST_PROXY=1` stays correct.
  11. Troubleshooting: ACME failures (DNS not propagated, port 80 closed), `team_not_linked`, and env validation
     errors in `docker compose logs gateway`.

## Acceptance (all must pass)

```sh
cd deploy
! docker compose --env-file .env.example config -q 2>/dev/null                 # blank required values must fail
printf 'COMPOSE_PROFILES=caddy\nPUBLIC_URL=http://localhost\nPOSTGRES_PASSWORD=x\nBETTER_AUTH_SECRET=x\nUPSTREAM_URL=http://u.invalid\nUPSTREAM_TOKEN=x\n' > /tmp/ws2.env
sed 's/^COMPOSE_PROFILES=caddy/COMPOSE_PROFILES=tunnel/' /tmp/ws2.env > /tmp/ws2-tunnel.env
docker compose --env-file /tmp/ws2.env config -q
test "$(docker compose --env-file /tmp/ws2.env config --services | sort | xargs)" = "caddy gateway postgres"
test "$(docker compose --env-file /tmp/ws2-tunnel.env config --services | sort | xargs)" = "cloudflared gateway postgres"
docker compose --env-file /tmp/ws2.env config --format json | node -e \
  'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=Object.keys(c.services).filter(n=>c.services[n].ports);if(p.join()!=="caddy"){console.error("published:",p);process.exit(1)}'
docker run --rm -e PUBLIC_URL=https://gw.example.com -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
cd .. && sh scripts/check-secrets.sh --all && git check-ignore -q deploy/.env && ! git check-ignore -q deploy/.env.example
```

The full `up` runs after WS1 and WS3 merge. If both are already on `master`, run `git merge master` and then
`sh scripts/compose-smoke.sh` if WS4 has merged too. Otherwise run
`docker compose --env-file /tmp/ws2.env up -d --build --wait && curl -fsS http://localhost/healthz && docker compose --env-file /tmp/ws2.env down -v`
(set `BETTER_AUTH_SECRET` and `UPSTREAM_TOKEN` to 16+ chars for that run).

## Commits

For example `build(deploy): production compose with caddy and postgres` and `docs(deploy): hostinger guide`.

```sh
git -c user.name=jakabasej -c user.email=jakabasej3@gmail.com commit -m "<type>(<scope>): <summary>" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report: the files written, the `config --services` output, the acceptance output tail, and any deviation from plan-v2 §3.

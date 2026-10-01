# Deploy on a Hostinger VPS

This runs the whole gateway on one Docker VPS: the dashboard and the API on a single domain over HTTPS, with
Postgres in a named volume and Caddy for TLS. Budget 20 minutes.

The gateway is a front door for an **upstream service that you supply** (`UPSTREAM_URL` + `UPSTREAM_TOKEN`).
Account connection and session flows belong to that upstream service, not to this repo.

## 1. Create the VPS

1. In hPanel pick **VPS → KVM** (KVM 1 is enough; **2 GB RAM or more**, because the image is built on the VPS).
2. OS: **Ubuntu 24.04 with the Docker template** (Applications → Ubuntu 24.04 + Docker). It ships Docker Engine
   and the Compose plugin.
3. Add your SSH key during setup, then log in:

   ```sh
   ssh root@<vps-ip>
   docker --version && docker compose version
   ```

4. In the **hPanel firewall** allow inbound `22/tcp`, `80/tcp`, `443/tcp` and `443/udp` (udp is HTTP/3), and nothing else.

> Docker publishes ports by writing DNAT rules, which **bypass `ufw`**. A `ufw` rule will not protect a published
> port. The hPanel firewall sits in front of the VPS, so that is the one that counts. This stack publishes only
> Caddy's 80/443; Postgres and the gateway have no host ports at all.

## 2. DNS

1. At your DNS provider add an **A** record for the hostname you will use, pointing at the VPS IPv4 address
   (and an **AAAA** record if the VPS has IPv6):

   ```
   gw.example.com.  A     203.0.113.10
   gw.example.com.  AAAA  2001:db8::10
   ```

2. Wait for propagation and verify before you start the stack, because Caddy asks Let's Encrypt for a certificate
   on first boot:

   ```sh
   dig +short gw.example.com
   dig +short AAAA gw.example.com
   ```

## 3. Clone into /opt/gateway

```sh
mkdir -p /opt/gateway
git clone <repo-url> /opt/gateway
cd /opt/gateway/deploy
```

## 4. Environment

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 24     # POSTGRES_PASSWORD
openssl rand -base64 32  # BETTER_AUTH_SECRET
nano .env
```

Fill in:

| Variable | Value |
|---|---|
| `COMPOSE_PROFILES` | `caddy` (leave as is; see §10 for `tunnel`) |
| `PUBLIC_URL` | `https://gw.example.com` — the domain from §2, no trailing slash |
| `POSTGRES_PASSWORD` | the `openssl rand -hex 24` output |
| `BETTER_AUTH_SECRET` | the `openssl rand -base64 32` output |
| `UPSTREAM_URL` | your upstream's origin, e.g. `https://upstream.example.com` |
| `UPSTREAM_TOKEN` | the bearer token that upstream issued to you (at least 16 characters) |

For an upstream on the same VPS use `UPSTREAM_URL=http://host.docker.internal:<port>` (plain `http://localhost:<port>`
would reach the gateway container itself). The upstream must listen on the Docker bridge or `0.0.0.0`, not on
`127.0.0.1` only; keep that port closed in the hPanel firewall.

`.env` is gitignored and holds every secret on the box. Keep it `chmod 600`. To rotate `UPSTREAM_TOKEN` or
`BETTER_AUTH_SECRET`, edit `.env` and run `docker compose up -d` (a new auth secret logs everyone out).

## 5. Start

```sh
cd /opt/gateway/deploy
docker compose up -d
```

The first run builds the gateway image and takes a few minutes. Migrations run automatically on every start.
Then check:

```sh
docker compose ps                        # gateway healthy, postgres healthy, caddy running
curl -fsS https://gw.example.com/healthz
```

Caddy requests the certificate as soon as it starts; allow a few seconds. If `curl` fails, see §11.

## 6. First user

1. Open `https://gw.example.com` in a browser and **sign up**. The first account creates a workspace.
2. Go to **Settings** and copy the workspace **slug**.
3. Approve that workspace from the VPS shell (sign-up is open, so this link is the approval step):

   ```sh
   cd /opt/gateway/deploy
   docker compose exec gateway node dist/db/link-team.js <slug>
   ```

   Check that it printed `linked workspace …`. A wrong slug exits with `no workspace with slug "…"`; copy the
   slug from Settings again.
4. Reload the **Accounts** page. It should now list the accounts your upstream exposes.

## 7. Updates

```sh
cd /opt/gateway/deploy
docker compose exec -T postgres pg_dump -U gateway -Fc gateway > "/root/backups/gateway-$(date +%F).dump"  # first (§8 creates /root/backups)
git -C /opt/gateway pull
docker compose up -d --build
docker image prune -f      # drops the image the build replaced
```

Migrations run on start and are **forward-only**: there is no down path, so take the backup above before every
update. Only one gateway instance runs, so migrations never race.

## 8. Backup and restore

Create the backup directory once:

```sh
mkdir -p /root/backups && chmod 700 /root/backups
```

Dump (custom format, compressed):

```sh
cd /opt/gateway/deploy
docker compose exec -T postgres pg_dump -U gateway -Fc gateway > "/root/backups/gateway-$(date +%F).dump"
```

Daily at 03:15 via cron (`crontab -e`):

```cron
15 3 * * * cd /opt/gateway/deploy && /usr/bin/docker compose exec -T postgres pg_dump -U gateway -Fc gateway > /root/backups/gateway-$(date +\%F).dump 2>>/root/backups/cron.log
```

Copy the dumps **off the VPS** — a backup that only exists on the box is not a backup:

```sh
rsync -av --remove-source-files root@<vps-ip>:/root/backups/ ./gateway-backups/   # run on your laptop
```

Dumps contain API key hashes, sessions and redacted request logs. Store them `chmod 600` and encrypted at rest.

Restore into a fresh, empty database (this replaces everything in it):

```sh
cd /opt/gateway/deploy
docker compose stop gateway
docker compose exec -T postgres dropdb -U gateway gateway
docker compose exec -T postgres createdb -U gateway gateway
docker compose exec -T postgres pg_restore -U gateway -d gateway --exit-on-error < /root/backups/gateway-<date>.dump
docker compose start gateway
```

Hostinger **snapshots** (hPanel → VPS → Snapshots) restore the whole machine and are a useful second layer, but
they are not a replacement: they are machine-wide, overwrite everything, and Hostinger keeps only one.

Postgres is pinned to 17. A major version upgrade needs a dump and a restore into a fresh volume.

## 9. Logs

```sh
cd /opt/gateway/deploy
docker compose logs -f gateway caddy      # follow
docker compose logs --since 1h gateway    # recent only
```

Every service logs to `json-file` capped at **10 MB × 3 files** per service. Older lines are dropped, not
archived — ship them elsewhere if you need history. Only container logs are capped: §7 prunes the old image on
each update, but `/root/backups` is not rotated. The §8 `rsync` removes the dumps it copies; otherwise delete old
dumps yourself.

Per-request API logs (method, path, status, duration, redacted bodies) live in Postgres and are visible on the
dashboard's **Logs** page. They are kept 14 days (the `LOG_RETENTION_DAYS` default; not set through `deploy/.env`).

## 10. Optional: Cloudflare Tunnel instead of open ports

Use this if you would rather expose nothing at all. Cloudflare terminates TLS and cloudflared dials out.

1. In Cloudflare **Zero Trust → Networks → Tunnels**, create a tunnel, copy its token, and add a **public
   hostname** for your domain with the service `http://gateway:4000`.
2. On the VPS edit `deploy/.env`:

   ```sh
   COMPOSE_PROFILES=tunnel
   TUNNEL_TOKEN=<token from Cloudflare>
   ```

   Keep `PUBLIC_URL=https://gw.example.com` — that is still the public origin.
3. Remove caddy, start cloudflared, then close the ports. Changing the profile does not stop caddy: its
   container keeps running with 80/443 published until you remove it.

   ```sh
   docker compose --profile caddy rm -sf caddy   # stops and removes caddy
   docker compose up -d                          # starts cloudflared
   docker compose ps                             # caddy gone, so no published ports
   ```

   In the hPanel firewall remove the 80 and 443 rules (keep 22). Your DNS record for the hostname is managed by
   Cloudflare as part of the tunnel, so drop the A/AAAA record from §2 if it is elsewhere.

`TRUST_PROXY=1` stays correct: there is still exactly one proxy hop in front of the gateway, cloudflared instead
of Caddy.

## 11. Troubleshooting

**No certificate / `curl` fails over HTTPS (ACME).** Check Caddy's log: `docker compose logs caddy`.

- `no such host` or a challenge timeout → DNS has not propagated or points elsewhere. Re-run `dig +short <domain>`
  and compare with the VPS IP. Once DNS is fixed, `docker compose restart caddy` retries at once instead of
  waiting out Caddy's retry backoff.
- `connection refused` on the challenge → 80 and 443 are closed in the hPanel firewall, or something else holds
  them (`ss -tlnp | grep -E ':(80|443)\s'`). Caddy tries the HTTP-01 challenge on 80 and the TLS-ALPN challenge
  on 443, so either open port gets a certificate; keep both open so `http://` redirects to HTTPS.
- `PUBLIC_URL` must be the bare origin (`https://gw.example.com`), no path and no trailing slash.
- Certificates live in the `caddy_data` volume. Keep it across updates; deleting it re-issues and counts against
  Let's Encrypt rate limits (5 duplicate certificates per week).

**`team_not_linked` (409) on API calls or the Accounts page.** The workspace has not been approved. Run
`docker compose exec gateway node dist/db/link-team.js <slug>` with the exact slug shown on Settings.

**gateway restarts in a loop.** Read the validation error:

```sh
docker compose logs gateway | tail -40
```

- `Invalid environment: …` names the offending variables. Common causes: `BETTER_AUTH_SECRET` shorter than 16
  characters, `UPSTREAM_TOKEN` shorter than 16 characters, `UPSTREAM_URL` or `PUBLIC_URL` not a valid absolute URL,
  or an `http://` `PUBLIC_URL` (reported as `APP_URL` and `BETTER_AUTH_URL`; production needs `https://`).
- `required variable … is missing a value` from `docker compose` itself means a blank line in `.env`
  (`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `UPSTREAM_URL`, `UPSTREAM_TOKEN` and `PUBLIC_URL` are all required).

**`password authentication failed for user "gateway"`.** Postgres sets the password once, when it first creates
the `pgdata` volume; changing `POSTGRES_PASSWORD` in `.env` later does not reach it. Restore the old value. On a
fresh install with nothing to keep, `docker compose down -v` deletes the volumes (the `caddy_data` certificates
too) and the next `up -d` starts over. `docker compose` also expands `$` in `.env` values, so single-quote a value
that contains one: `POSTGRES_PASSWORD='pa$word'`.

**502 `upstream_unavailable` / 504 `upstream_timeout`.** The gateway reached its own limits talking to your
upstream. Verify `UPSTREAM_URL` and `UPSTREAM_TOKEN` from inside the network and raise `UPSTREAM_TIMEOUT_MS`
if the upstream is simply slow:

```sh
docker compose exec gateway node -e 'fetch(new URL("/of-accounts",process.env.UPSTREAM_URL),{headers:{authorization:"Bearer "+process.env.UPSTREAM_TOKEN}}).then(r=>console.log(r.status))'
```

**Out of disk or a failed build.** `docker system df`, then `docker system prune -f` (it keeps named volumes).
A build killed by the OOM killer means the VPS has less than 2 GB RAM.

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
| `UPSTREAM_TOKEN` | the bearer token that upstream issued to you |

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

Caddy gets the certificate on the first HTTPS request; allow a few seconds. If `curl` fails, see §11.

## 6. First user

1. Open `https://gw.example.com` in a browser and **sign up**. The first account creates a workspace.
2. Go to **Settings** and copy the workspace **slug**.
3. Approve that workspace from the VPS shell (sign-up is open, so this link is the approval step):

   ```sh
   cd /opt/gateway/deploy
   docker compose exec gateway node dist/db/link-team.js <slug>
   ```

4. Reload the **Accounts** page. It should now list the accounts your upstream exposes. If it shows
   `team_not_linked`, the slug did not match — re-check it on Settings.

## 7. Updates

```sh
cd /opt/gateway/deploy
docker compose exec -T postgres pg_dump -U gateway -Fc gateway > "/root/gateway-$(date +%F).dump"  # first
git -C /opt/gateway pull
docker compose up -d --build
```

Migrations run on start and are **forward-only**: there is no down path, so take the backup above before every
update. Only one gateway instance runs, so migrations never race.

## 8. Backup and restore

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
mkdir -p /root/backups && chmod 700 /root/backups
rsync -av --remove-source-files root@<vps-ip>:/root/backups/ ./gateway-backups/   # run on your laptop
```

Dumps contain API key hashes, sessions and redacted request logs. Store them `chmod 600` and encrypted at rest.

Restore into a running stack:

```sh
cd /opt/gateway/deploy
docker compose stop gateway
docker compose exec -T postgres pg_restore -U gateway -d gateway --clean --if-exists < gateway-2026-10-01.dump
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

Every service logs to `json-file` capped at **10 MB × 3 files** per service, so a small VPS disk cannot fill up.
Older lines are dropped, not archived — ship them elsewhere if you need history.

Per-request API logs (method, path, status, duration, redacted bodies) live in Postgres and are visible on the
dashboard's **Logs** page, with retention controlled by `LOG_RETENTION_DAYS` (14 days by default).

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
3. Apply, then close the ports:

   ```sh
   docker compose up -d --remove-orphans   # starts cloudflared, stops caddy
   docker compose ps                       # no published ports at all
   ```

   In the hPanel firewall remove the 80 and 443 rules (keep 22). Your DNS record for the hostname is managed by
   Cloudflare as part of the tunnel, so drop the A/AAAA record from §2 if it is elsewhere.

`TRUST_PROXY=1` stays correct: there is still exactly one proxy hop in front of the gateway, cloudflared instead
of Caddy.

## 11. Troubleshooting

**No certificate / `curl` fails over HTTPS (ACME).** Check Caddy's log: `docker compose logs caddy`.

- `no such host` or a challenge timeout → DNS has not propagated or points elsewhere. Re-run `dig +short <domain>`
  and compare with the VPS IP.
- `connection refused` on the challenge → port 80 is closed in the hPanel firewall, or something else holds it
  (`ss -tlnp | grep ':80'`). Let's Encrypt needs inbound 80 for the HTTP-01 challenge.
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
  characters, `UPSTREAM_URL` or `PUBLIC_URL` not a valid absolute URL.
- `required variable … is missing a value` from `docker compose` itself means a blank line in `.env`
  (`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `UPSTREAM_URL`, `UPSTREAM_TOKEN` and `PUBLIC_URL` are all required).
- `ECONNREFUSED … 5432` right after boot is normal for a moment; it is a problem only if it persists — check
  `docker compose ps` for postgres health.

**502 `upstream_unavailable` / 504 `upstream_timeout`.** The gateway reached its own limits talking to your
upstream. Verify `UPSTREAM_URL` and `UPSTREAM_TOKEN` from inside the network and raise `UPSTREAM_TIMEOUT_MS`
if the upstream is simply slow:

```sh
docker compose exec gateway node -e 'fetch(process.env.UPSTREAM_URL+"/of-accounts",{headers:{authorization:"Bearer "+process.env.UPSTREAM_TOKEN}}).then(r=>console.log(r.status))'
```

**Out of disk or a failed build.** `docker system df`, then `docker system prune -f` (it keeps named volumes).
A build killed by the OOM killer means the VPS has less than 2 GB RAM.

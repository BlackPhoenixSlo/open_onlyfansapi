# Deploy on a Hostinger VPS

This runs the whole stack on one Docker VPS: the dashboard and the API on a single domain over HTTPS, the OF
upstream from `services/upstream`, Postgres in a named volume and Caddy for TLS. Budget 30 minutes.

The gateway talks to the upstream with one shared bearer token (`UPSTREAM_URL` + `UPSTREAM_TOKEN`). The upstream
holds the OF sessions and proxies; you connect accounts to it from the VPS shell (§7). It runs under the
`upstream` compose profile, so an upstream you run elsewhere still works: drop that profile and point
`UPSTREAM_URL` at it (§4).

> **One operator.** Every workspace you link (§6) sees every connected account: its REST calls, events,
> webhooks and stats. Link only workspaces you trust with all accounts; there is no per-account split.

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
> Caddy's 80/443; Postgres, the gateway and the upstream have no host ports at all.

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
openssl rand -hex 32     # UPSTREAM_TOKEN (hex, not base64)
nano .env
```

Fill in:

| Variable | Value |
|---|---|
| `COMPOSE_PROFILES` | `caddy,upstream` (leave as is; see §11 for `tunnel`) |
| `PUBLIC_URL` | `https://gw.example.com` — the domain from §2, no trailing slash |
| `POSTGRES_PASSWORD` | the `openssl rand -hex 24` output |
| `BETTER_AUTH_SECRET` | the `openssl rand -base64 32` output |
| `UPSTREAM_TOKEN` | the `openssl rand -hex 32` output |

Leave the rest as `.env.example` sets it:

| Variable | Default | Meaning |
|---|---|---|
| `UPSTREAM_URL` | `http://upstream:8000` | The bundled upstream, inside the compose network. |
| `UPSTREAM_WS_URL` | `ws://upstream:8000/ws` | The upstream's event socket. Empty turns events off: no upstream webhooks, and `/v1/ws` answers 503. |
| `OF_REQUIRE_PROXY` | `false` | Accounts without their own proxy connect from the VPS IP. Set `true` to refuse such accounts. |
| `STATIC_PARAM` | empty | OF's static signing parameter. Set it here once, or pass `--static-param` per account in §7. |
| `EVENT_RETENTION_DAYS` | `365` | Days of the event ledger behind `/v1/stats`. |

`UPSTREAM_TOKEN` may contain only letters, digits and `-._~`, and needs at least 16 characters: it also travels as
a WebSocket subprotocol, so a base64 value with `/` or `=` stops the gateway from booting. Use
`openssl rand -hex 32`.

**An upstream outside this stack.** Set `COMPOSE_PROFILES=caddy`, `UPSTREAM_URL` to its origin (e.g.
`https://upstream.example.com`), `UPSTREAM_TOKEN` to the token it expects, and `UPSTREAM_WS_URL` to its event
socket (`wss://…/ws`) or empty. For one on the same VPS use `http://host.docker.internal:<port>` (plain
`http://localhost:<port>` would reach the gateway container itself); it must listen on the Docker bridge or
`0.0.0.0`, not on `127.0.0.1` only, and that port stays closed in the hPanel firewall.

`.env` is gitignored and holds every secret on the box. Keep it `chmod 600`. To rotate a secret, edit `.env` and
run `docker compose up -d`. A new `BETTER_AUTH_SECRET` logs everyone out. A new `UPSTREAM_TOKEN` restarts **both**
the gateway and the upstream (they share it); the gateway's event socket reconnects, and events in that gap are
lost (§7). Connected accounts are kept.

## 5. Start

```sh
cd /opt/gateway/deploy
docker compose up -d
```

The first run builds the gateway and upstream images and takes a few minutes. Migrations run automatically on
every start. Then check:

```sh
docker compose ps                        # gateway, upstream and postgres healthy, caddy running
curl -fsS https://gw.example.com/healthz
docker compose port upstream 8000        # "invalid IP:0" (or empty): the upstream is not published
```

In `docker compose ps` only caddy shows `0.0.0.0:` mappings; the upstream lists a bare `8000/tcp`.

Caddy requests the certificate as soon as it starts; allow a few seconds. If `curl` fails, see §12.

## 6. First user

1. Open `https://gw.example.com` in a browser and **sign up**, then open the verification link from your email
   (without `SMTP_HOST` it is in `docker compose logs gateway`). The first account creates a workspace.
2. Go to **Settings** and copy the workspace **slug**.
3. Approve that workspace from the VPS shell (sign-up is open, so this link is the approval step):

   ```sh
   cd /opt/gateway/deploy
   docker compose exec gateway node dist/db/link-team.js <slug>
   ```

   Check that it printed `linked workspace …`. A wrong slug exits with `no workspace with slug "…"`; copy the
   slug from Settings again.
4. Reload the **Accounts** page. It lists the upstream's accounts: none yet on a fresh install, until §7.

## 7. Connect an OF account

Each account needs a logged-in OF session and, optionally, a proxy of its own (required only with `OF_REQUIRE_PROXY=true`). Any provider
works; use a `socks5h://` URL (DNS is resolved at the proxy too) or `http://`.

1. In Chrome, log in to OF, open **DevTools → Network**, click a request to `onlyfans.com/api2/v2/…` (for example
   `users/me`), and **Copy → Copy as cURL (bash)**. The copy must carry the cookies as `-b '…'` and a `user-id`
   header; a copy without `-b` has no session.
2. Save it on the VPS as `curl.txt` (it holds the session cookie):

   ```sh
   cd /opt/gateway/deploy
   umask 077 && nano curl.txt
   ```

3. Hand it to the upstream, with the account's proxy:

   ```sh
   docker compose exec -T upstream python connect.py --nickname Main --proxy-url socks5h://user:pass@host:port < curl.txt
   rm curl.txt
   ```

   It prints `{"accountId": …, "username": "…", "status": "…"}` and never echoes cookies. Without `STATIC_PARAM`
   in `.env` (a change there applies on `docker compose up -d`), add `--static-param <value>`.
   `bootstrap failed (409): … proxy_required` means the proxy is missing. Reconnecting the same account later (an
   expired session) keeps its proxy unless you pass a new one.

4. Reload **Accounts** in the dashboard; the account appears with a status:

| Status | Meaning |
|---|---|
| `active` | The upstream has received an OF frame since this account's event pump started. Not a live heartbeat. |
| `connecting` | The pump is starting or reconnecting; no frame yet. REST calls work. |
| `no_proxy` | `OF_REQUIRE_PROXY=true` and the account has no proxy. Reconnect it with `--proxy-url`. |
| `no_session` | No session is stored for the account. Run step 3. |
| `session_expired` | OF rejected the session (logged out, password changed). Capture a new curl and run step 3 again. |

**Events are at-most-once.** With `UPSTREAM_WS_URL` set, the gateway keeps one socket to the upstream and fans
its events out to webhooks and `/v1/ws` clients. While that socket reconnects (backing off up to 60 s, e.g.
after an upstream restart or token rotation) events are lost, not replayed; clients resync through the REST API.

## 8. Updates

```sh
cd /opt/gateway/deploy
docker compose exec -T postgres pg_dump -U gateway -Fc gateway > "/root/backups/gateway-$(date +%F).dump"  # first (§9 creates /root/backups)
git -C /opt/gateway pull
docker compose up -d --build
docker image prune -f      # drops the image the build replaced
./smoke.sh https://gw.example.com <api-key> <account-id>   # read-only check, see below
```

`up -d --build` rebuilds the gateway and upstream images together from the same checkout; upgrade them as a
pair. Before updating, read the release's entry in `CHANGELOG.md`, and across a major version its "Upgrading"
section (2.0 renames events, changes the webhook signature and wraps responses).

**2.0 to 2.1** needs no `.env` change and no new migration: between `v2.0.0` and `v2.1.0`, `deploy/.env.example`,
`deploy/docker-compose.yml` and `apps/api/drizzle` are unchanged; apart from version strings, the code changes are
all in the upstream service.

`smoke.sh` takes an API key from the dashboard and a connected account id. It calls `/healthz`, `GET me` and
`GET settings/drm` (a 2.1 route), and prints each status code with the JSON key names, never the values. It
exits non-zero on any status other than 200.

Migrations run on start and are **forward-only**: there is no down path, so take the backup above before every
update. Only one gateway instance runs, so migrations never race.

## 9. Backup and restore

Two volumes hold state: `pgdata` (Postgres) and `upstream_data` (the upstream's sessions, i.e. OF cookies, and
`proxies.json` with proxy passwords). `caddy_data` only holds certificates, which are re-issued.

> **`docker compose down -v` deletes every volume**: all Postgres data, every connected account's session and
> proxy credentials, and the certificates. Plain `docker compose down` keeps them.

Create the backup directory once:

```sh
mkdir -p /root/backups && chmod 700 /root/backups
```

### Postgres

Dump (custom format, compressed):

```sh
cd /opt/gateway/deploy
docker compose exec -T postgres pg_dump -U gateway -Fc gateway > "/root/backups/gateway-$(date +%F).dump"
```

Daily at 03:15 via cron (`crontab -e`):

```cron
15 3 * * * cd /opt/gateway/deploy && /usr/bin/docker compose exec -T postgres pg_dump -U gateway -Fc gateway > /root/backups/gateway-$(date +\%F).dump 2>>/root/backups/cron.log
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

Postgres is pinned to 17. A major version upgrade needs a dump and a restore into a fresh volume.

### Upstream sessions and proxies

`upstream_data` is credentials in plain files, so its backup is encrypted before it touches the disk. Create a
key once and keep a copy **off the VPS** (a password manager); without it the backups cannot be read:

```sh
openssl rand -hex 32 > /root/.upstream-backup-key && chmod 600 /root/.upstream-backup-key
```

Back up:

```sh
cd /opt/gateway/deploy
docker compose exec -T upstream tar -C /data -cz . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:/root/.upstream-backup-key \
  > "/root/backups/upstream-$(date +%F).tar.gz.enc"
```

Daily at 03:20 via cron:

```cron
20 3 * * * cd /opt/gateway/deploy && /usr/bin/docker compose exec -T upstream tar -C /data -cz . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:/root/.upstream-backup-key > /root/backups/upstream-$(date +\%F).tar.gz.enc 2>>/root/backups/cron.log
```

Restore (replaces the account files it contains; the upstream restarts its pumps on start):

```sh
cd /opt/gateway/deploy
docker compose stop upstream
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/.upstream-backup-key < /root/backups/upstream-<date>.tar.gz.enc \
  | docker compose run --rm --no-deps -T upstream tar -C /data -xz
docker compose start upstream
```

### Off the box

Copy the backups **off the VPS** — a backup that only exists on the box is not a backup:

```sh
rsync -av --remove-source-files root@<vps-ip>:/root/backups/ ./gateway-backups/   # run on your laptop
```

Hostinger **snapshots** (hPanel → VPS → Snapshots) restore the whole machine and are a useful second layer, but
they are not a replacement: they are machine-wide, overwrite everything, and Hostinger keeps only one. A
snapshot also holds the upstream's credentials unencrypted.

## 10. Logs

```sh
cd /opt/gateway/deploy
docker compose logs -f gateway upstream caddy   # follow
docker compose logs --since 1h gateway          # recent only
```

Every service logs to `json-file` capped at **10 MB × 3 files** per service. Older lines are dropped, not
archived — ship them elsewhere if you need history. Only container logs are capped: §8 prunes the old image on
each update, but `/root/backups` is not rotated. The §9 `rsync` removes the backups it copies; otherwise delete
old ones yourself.

Per-request API logs (method, path, status, duration, redacted bodies) live in Postgres and are visible on the
dashboard's **Logs** page. They are kept 14 days (the `LOG_RETENTION_DAYS` default; not set through `deploy/.env`).

## 11. Optional: Cloudflare Tunnel instead of open ports

Use this if you would rather expose nothing at all. Cloudflare terminates TLS and cloudflared dials out.

1. In Cloudflare **Zero Trust → Networks → Tunnels**, create a tunnel, copy its token, and add a **public
   hostname** for your domain with the service `http://gateway:4000`.
2. On the VPS edit `deploy/.env`:

   ```sh
   COMPOSE_PROFILES=tunnel,upstream
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

## 12. Troubleshooting

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
  characters, `UPSTREAM_TOKEN` shorter than 16 characters or with characters other than letters, digits and
  `-._~` (a base64 value; regenerate with `openssl rand -hex 32`), `UPSTREAM_URL` or `PUBLIC_URL` not a valid
  absolute URL, `UPSTREAM_WS_URL` not `ws://` or `wss://`, or an `http://` `PUBLIC_URL` (reported as `APP_URL`
  and `BETTER_AUTH_URL`; production needs `https://`).
- `required variable … is missing a value` from `docker compose` itself means a blank line in `.env`
  (`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `UPSTREAM_URL`, `UPSTREAM_TOKEN` and `PUBLIC_URL` are all required).

**upstream restarts in a loop.** `docker compose logs upstream | tail -40`. It refuses to boot with an
`UPSTREAM_TOKEN` shorter than 16 characters.

**`password authentication failed for user "gateway"`.** Postgres sets the password once, when it first creates
the `pgdata` volume; changing `POSTGRES_PASSWORD` in `.env` later does not reach it. Restore the old value. On a
fresh install with nothing to keep, `docker compose down -v` deletes the volumes (the `caddy_data` certificates
and the `upstream_data` sessions and proxies too, so every account must be reconnected) and the next `up -d`
starts over. `docker compose` also expands `$` in `.env` values, so single-quote a value
that contains one: `POSTGRES_PASSWORD='pa$word'`.

**502 `upstream_unavailable` / 504 `upstream_timeout`.** The gateway reached its own limits talking to the
upstream. With the bundled one, check `docker compose ps upstream` and `docker compose logs upstream` first.
Verify `UPSTREAM_URL` and `UPSTREAM_TOKEN` from inside the network and raise `UPSTREAM_TIMEOUT_MS` if the
upstream is simply slow:

```sh
docker compose exec gateway node -e 'fetch(new URL("/of-accounts",process.env.UPSTREAM_URL),{headers:{authorization:"Bearer "+process.env.UPSTREAM_TOKEN}}).then(r=>console.log(r.status))'
```

**Out of disk or a failed build.** `docker system df`, then `docker system prune -f` (it keeps named volumes).
A build killed by the OOM killer means the VPS has less than 2 GB RAM.

#!/usr/bin/env bash
# One-line install (or update) on a fresh Hostinger VPS, Ubuntu 24.04 + Docker template, as root:
#   DOMAIN=gw.example.com bash -c 'curl -fsSLo /tmp/install.sh https://raw.githubusercontent.com/BlackPhoenixSlo/open_onlyfansapi/master/deploy/install.sh && bash /tmp/install.sh'
# Automates deploy/hostinger.md §§3-6: clone into /opt/gateway, write deploy/.env with fresh secrets, start the
# stack, wait for https://$DOMAIN/healthz. Re-running is an update (a Postgres dump is taken first): it pulls,
# keeps .env and rebuilds.
#   DOMAIN          required, bare hostname whose A record points at this VPS (§2)
#   REPO            default https://github.com/BlackPhoenixSlo/open_onlyfansapi.git
#   REF             branch or tag, default master
#   SKIP_DNS_CHECK  1 = do not check that DOMAIN resolves to this host
set -euo pipefail

DIR=/opt/gateway
REPO=${REPO:-https://github.com/BlackPhoenixSlo/open_onlyfansapi.git}
REF=${REF:-master}
DOMAIN=${DOMAIN:-}

die() { echo "install: $*" >&2; exit 1; }
logs_and_die() { # <message>; run from deploy/
  echo "install: $1; recent logs:" >&2
  docker compose logs --no-color --tail 40 gateway caddy >&2 || true
  die "see hostinger.md §12 (Troubleshooting)"
}
say() { echo "==> $*"; }

# Inputs first, so a typo is reported before anything else happens.
[ -n "$DOMAIN" ] || die "DOMAIN is required, e.g. DOMAIN=gw.example.com (a bare hostname)"
[[ $DOMAIN =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] ||
  die "DOMAIN must be a bare hostname like gw.example.com (no https://, path or port), got: $DOMAIN"
[ "$(id -u)" -eq 0 ] || die "must run as root: open a root shell first (sudo -i), then run the line again"

command -v docker >/dev/null || die "docker is not installed; use the Ubuntu 24.04 + Docker template (hostinger.md §1)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (hostinger.md §1)"

export DEBIAN_FRONTEND=noninteractive
apt_install() { # <command> <package>
  command -v "$1" >/dev/null && return 0
  say "installing $2"
  # The lock timeout: unattended-upgrades holds the dpkg lock for a while after first boot.
  apt-get -o DPkg::Lock::Timeout=300 update -qq &&
    apt-get -o DPkg::Lock::Timeout=300 install -y -qq "$2" >/dev/null
}
apt_install git git
apt_install openssl openssl

# Caddy asks Let's Encrypt for a certificate on first boot, which fails unless DOMAIN points here. A public
# resolver, not the local stub: /etc/hosts maps the VPS hostname to 127.0.1.1, which is not what the CA sees.
if [ "${SKIP_DNS_CHECK:-}" != 1 ]; then
  apt_install dig dnsutils
  resolved=$(dig +short A "$DOMAIN" @1.1.1.1 | grep -E '^[0-9.]+$' || true)
  [ -n "$resolved" ] || die "$DOMAIN has no A record yet; add one pointing at this VPS (hostinger.md §2), wait, and re-run (SKIP_DNS_CHECK=1 bypasses)"
  own="$(curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true) $(hostname -I 2>/dev/null || true)"
  match=
  for ip in $resolved; do
    for o in $own; do [ "$ip" = "$o" ] && match=1; done
  done
  [ -n "$match" ] || die "$DOMAIN resolves to ${resolved//$'\n'/ }, not to this host (${own//$'\n'/ }); fix the A record (hostinger.md §2) and re-run (SKIP_DNS_CHECK=1 bypasses)"
  # Let's Encrypt may validate over IPv6, so every AAAA record must be this host too.
  for ip in $(dig +short AAAA "$DOMAIN" @1.1.1.1 | grep -E '^[0-9A-Fa-f:]+$' || true); do
    [[ " $own " == *" $ip "* ]] ||
      die "$DOMAIN has an AAAA record $ip that is not this host; fix or remove it (hostinger.md §2) and re-run (SKIP_DNS_CHECK=1 bypasses)"
  done
  say "$DOMAIN resolves to this host"
fi

export GIT_TERMINAL_PROMPT=0

if [ -d "$DIR/.git" ]; then
  say "updating $DIR to $REF"
  git -C "$DIR" fetch -q --tags origin
  git -C "$DIR" checkout -q "$REF"
  # A branch fast-forwards; a tag is a detached checkout with nothing to pull.
  if git -C "$DIR" symbolic-ref -q HEAD >/dev/null; then
    git -C "$DIR" pull -q --ff-only
  fi
else
  say "cloning $REPO ($REF) into $DIR"
  git clone -q --branch "$REF" "$REPO" "$DIR"
fi

cd "$DIR/deploy"
if [ -f .env ]; then
  say "kept the existing deploy/.env"
  grep -qxF "PUBLIC_URL=https://$DOMAIN" .env ||
    echo "install: warning: deploy/.env has a PUBLIC_URL other than https://$DOMAIN; Caddy serves that one" >&2
  # The §8 backup: migrations are forward-only, so dump before the new images start.
  if [ -n "$(docker compose ps --status running -q postgres)" ]; then
    umask 077
    mkdir -p /root/backups && chmod 700 /root/backups
    dump="/root/backups/gateway-$(date +%F-%H%M%S).dump"
    docker compose exec -T postgres pg_dump -U gateway -Fc gateway >"$dump"
    umask 022
    say "Postgres dump: $dump"
  fi
else
  say "writing deploy/.env with fresh secrets"
  # A bash loop, not sed: the secrets never appear on a command line.
  umask 077
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      PUBLIC_URL=*) line="PUBLIC_URL=https://$DOMAIN" ;;
      POSTGRES_PASSWORD=*) line="POSTGRES_PASSWORD=$(openssl rand -hex 24)" ;;
      BETTER_AUTH_SECRET=*) line="BETTER_AUTH_SECRET=$(openssl rand -base64 32)" ;;
      UPSTREAM_TOKEN=*) line="UPSTREAM_TOKEN=$(openssl rand -hex 32)" ;;
    esac
    printf '%s\n' "$line"
  done <.env.example >.env.tmp
  mv .env.tmp .env
  chmod 600 .env
  umask 022
fi

# Caddy publishes 80 and 443. Check before the build, not after, and do not count our own caddy on a re-run.
if grep -qE '^COMPOSE_PROFILES=.*caddy' .env; then
  own_caddy=$(docker compose ps -q caddy 2>/dev/null || true)
  for port in 80 443; do
    holder=$(ss -Hltnp "sport = :$port" 2>/dev/null | head -1)
    [ -z "$holder" ] && continue
    if [ -n "$own_caddy" ] && echo "$holder" | grep -q docker-proxy; then continue; fi
    die "port $port is already in use on this VPS ($holder); the one-line install needs a VPS with 80 and 443 free (an application template is not), or see hostinger.md §11b for a box with its own reverse proxy"
  done
fi

say "building and starting the stack (the first build takes a few minutes)"
docker compose up -d --build || logs_and_die "docker compose up failed"

say "waiting for https://$DOMAIN/healthz"
for _ in $(seq 36); do
  if curl -fsS -o /dev/null --max-time 5 "https://$DOMAIN/healthz"; then
    cat <<EOF

Done: https://$DOMAIN is up.

1. Sign up at https://$DOMAIN; you are signed in at once. Then close registration (hostinger.md §6): set
   REGISTRATION_OPEN=false in $DIR/deploy/.env and run: cd $DIR/deploy && docker compose up -d
2. Every sign-up gets its own workspace, linked to the upstream automatically. A workspace sees the accounts
   it connected (Accounts -> Connect account in the dashboard) or was given with analytics-claim.
3. Or connect an OF account from this shell (hostinger.md §7): paste its "Copy as cURL (bash)" into curl.txt, then
     cd $DIR/deploy
     umask 077 && nano curl.txt
     docker compose exec -T upstream python connect.py --nickname Main --proxy-url socks5h://user:pass@host:port [--static-param <value>] < curl.txt
     rm curl.txt
     docker compose exec gateway node dist/cli/analytics-claim.js --team <teamId> --account <accountId>
   (--static-param only when STATIC_PARAM in deploy/.env is empty; link-team <slug> prints the teamId; the slug
   is on Settings.)

Update later by re-running the same line, or: DOMAIN=$DOMAIN bash $DIR/deploy/install.sh
EOF
    exit 0
  fi
  sleep 5
done

logs_and_die "https://$DOMAIN/healthz did not answer within 3 minutes"

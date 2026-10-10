#!/usr/bin/env bash
# One-line install (or update) on a fresh Hostinger VPS, Ubuntu 24.04 + Docker template, as root:
#   HTTPS_PORT=443 HTTP_PORT=80 DOMAIN=gw.example.com bash -c 'curl -fsSLo /tmp/install.sh https://raw.githubusercontent.com/BlackPhoenixSlo/open_onlyfansapi/master/deploy/install.sh && bash /tmp/install.sh'
# Automates deploy/hostinger.md §§3-6: clone into /opt/gateway, write deploy/.env with fresh secrets, start the
# stack, wait for https://$DOMAIN/healthz. Re-running is an update (a Postgres dump is taken first): it pulls,
# keeps .env and rebuilds.
#   DOMAIN          required, bare hostname whose A record points at this VPS (§2)
#   REPO            default https://github.com/BlackPhoenixSlo/open_onlyfansapi.git
#   REF             branch or tag, default master
#   HTTPS_PORT      default 443. Another value (e.g. 8443) when 80/443 are taken: the site is https://DOMAIN:8443
#                   with a certificate from Caddy's own CA (Let's Encrypt only reaches 80 and 443), so browsers
#                   warn once; HTTP_PORT (default 80) is then the plain-http redirect port, e.g. 8080
#   GATEWAY_PORT    a box whose 80/443 belong to Traefik, nginx or another proxy (hostinger.md §11b): no Caddy, the
#                   gateway is published on 127.0.0.1:GATEWAY_PORT and that proxy terminates TLS for DOMAIN with
#                   a real certificate; the script prints the Traefik route to add. Not with HTTPS_PORT/HTTP_PORT.
#   SKIP_DNS_CHECK  1 = do not check that DOMAIN resolves to this host
set -euo pipefail
cd / # the caller may sit in a directory that no longer exists (an rm -rf of the previous install)

DIR=/opt/gateway
REPO=${REPO:-https://github.com/BlackPhoenixSlo/open_onlyfansapi.git}
REF=${REF:-master}
DOMAIN=${DOMAIN:-}
ports_given=${HTTPS_PORT+1}${HTTP_PORT+1}${GATEWAY_PORT+1} # the caller named a port: a re-run then moves the stack to it
HTTPS_PORT=${HTTPS_PORT:-443}
HTTP_PORT=${HTTP_PORT:-80}
GATEWAY_PORT=${GATEWAY_PORT:-}

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
[[ $HTTPS_PORT =~ ^[0-9]+$ && $HTTP_PORT =~ ^[0-9]+$ ]] || die "HTTPS_PORT and HTTP_PORT must be numbers, got: $HTTPS_PORT $HTTP_PORT"
[[ -z $GATEWAY_PORT || $GATEWAY_PORT =~ ^[0-9]+$ ]] || die "GATEWAY_PORT must be a number, got: $GATEWAY_PORT"
if [ -n "$GATEWAY_PORT" ] && { [ "$HTTPS_PORT" != 443 ] || [ "$HTTP_PORT" != 80 ]; }; then
  die "GATEWAY_PORT (the box's own proxy serves 443) does not go with HTTPS_PORT/HTTP_PORT (our Caddy on other ports)"
fi
if [ -n "$GATEWAY_PORT" ] || [ "$HTTPS_PORT" = 443 ]; then URL="https://$DOMAIN"; else URL="https://$DOMAIN:$HTTPS_PORT"; fi

# The .env lines that pick the mode; the secrets and everything else come from .env.example or the kept .env.
mode_lines() {
  printf 'PUBLIC_URL=%s\n' "$URL"
  if [ -n "$GATEWAY_PORT" ]; then
    printf 'COMPOSE_PROFILES=upstream\nCOMPOSE_FILE=docker-compose.yml:docker-compose.direct.yml\nGATEWAY_PORT=127.0.0.1:%s\n' "$GATEWAY_PORT"
  elif [ "$HTTPS_PORT" != 443 ] || [ "$HTTP_PORT" != 80 ]; then
    printf 'COMPOSE_PROFILES=caddy,upstream\nHTTPS_PORT=%s\nHTTP_PORT=%s\nCADDYFILE=Caddyfile.selfsigned\n' "$HTTPS_PORT" "$HTTP_PORT"
  else
    printf 'COMPOSE_PROFILES=caddy,upstream\n'
  fi
}
MODE_KEYS='^(PUBLIC_URL|COMPOSE_PROFILES|COMPOSE_FILE|GATEWAY_PORT|HTTPS_PORT|HTTP_PORT|CADDYFILE)='
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
  if [ -n "$ports_given" ]; then
    # Ports named on the command line win: rewrite the port lines, keep every other line (and the secrets).
    umask 077
    { grep -vE "$MODE_KEYS" .env || true; mode_lines; } >.env.tmp
    mv .env.tmp .env && chmod 600 .env
    umask 022
    say "deploy/.env now serves $URL${GATEWAY_PORT:+ from 127.0.0.1:$GATEWAY_PORT behind the proxy on this box}"
    # A profile change does not stop a running caddy, and it would keep its ports.
    if [ -n "$GATEWAY_PORT" ] && [ -n "$(docker compose --profile caddy ps -q caddy 2>/dev/null)" ]; then
      docker compose --profile caddy rm -sf caddy >/dev/null
    fi
  elif ! grep -qxF "PUBLIC_URL=$URL" .env; then
    echo "install: warning: deploy/.env has a PUBLIC_URL other than $URL; Caddy serves that one (name HTTPS_PORT/HTTP_PORT on the command line to move it)" >&2
  fi
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
      POSTGRES_PASSWORD=*) line="POSTGRES_PASSWORD=$(openssl rand -hex 24)" ;;
      BETTER_AUTH_SECRET=*) line="BETTER_AUTH_SECRET=$(openssl rand -base64 32)" ;;
      UPSTREAM_TOKEN=*) line="UPSTREAM_TOKEN=$(openssl rand -hex 32)" ;;
    esac
    [[ $line =~ $MODE_KEYS ]] && continue
    printf '%s\n' "$line"
  done <.env.example >.env.tmp
  mode_lines >>.env.tmp
  mv .env.tmp .env
  chmod 600 .env
  umask 022
fi

# The published ports must be free. Check before the build, not after, and do not count our own containers on a re-run.
if [ -n "$GATEWAY_PORT" ]; then
  own=$(docker compose ps -q gateway 2>/dev/null || true); check_ports=$GATEWAY_PORT
else
  own=$(docker compose ps -q caddy 2>/dev/null || true); check_ports="$HTTP_PORT $HTTPS_PORT"
fi
for port in $check_ports; do
  holder=$(ss -Hltnp "sport = :$port" 2>/dev/null | head -1)
  [ -z "$holder" ] && continue
  if [ -n "$own" ] && echo "$holder" | grep -q docker-proxy; then continue; fi
  die "port $port is already in use on this VPS ($holder). A box whose 80/443 belong to Traefik or nginx: GATEWAY_PORT=5454 in front of the install line (that proxy serves the domain, hostinger.md §11b). Otherwise name two free ports, e.g. HTTPS_PORT=8443 HTTP_PORT=8081 (self-signed certificate, §0); ss -Hltn lists the ports in use"
done

say "building and starting the stack (the first build takes a few minutes)"
docker compose up -d --build || logs_and_die "docker compose up failed"

if [ -n "$GATEWAY_PORT" ]; then
  # The stack answers on the local port; the box's proxy puts the domain in front of it.
  say "waiting for http://127.0.0.1:$GATEWAY_PORT/healthz"
  for _ in $(seq 36); do
    curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$GATEWAY_PORT/healthz" && break
    sleep 5
  done
  curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$GATEWAY_PORT/healthz" ||
    logs_and_die "http://127.0.0.1:$GATEWAY_PORT/healthz did not answer within 3 minutes"
  if ! curl -fsS -o /dev/null --max-time 5 "$URL/healthz"; then
    cat <<EOF

The stack is up on 127.0.0.1:$GATEWAY_PORT. $URL does not answer yet: route it in the proxy that owns 443 on this box.
For Traefik, a dynamic-configuration file (its file provider directory; entryPoint and certResolver names are
the ones in your Traefik config):

  http:
    routers:
      gateway:
        rule: Host(\`$DOMAIN\`)
        entryPoints: [websecure]
        tls: { certResolver: letsencrypt }
        service: gateway
    services:
      gateway:
        loadBalancer:
          servers: [{ url: "http://127.0.0.1:$GATEWAY_PORT" }]

A Traefik container without host networking cannot reach 127.0.0.1: then publish on the bridge instead,
GATEWAY_PORT=172.17.0.1:$GATEWAY_PORT in deploy/.env and the same address in the url above, and docker compose up -d.
Then: curl -fsS $URL/healthz
EOF
  fi
fi

say "waiting for $URL/healthz"
for _ in $(seq "$([ -n "$GATEWAY_PORT" ] && echo 2 || echo 36)"); do
  # -k: on an alternate port the certificate comes from Caddy's own CA.
  if curl -fsSk -o /dev/null --max-time 5 "$URL/healthz"; then
    cat <<EOF

Done: $URL is up.$([ "$HTTPS_PORT" = 443 ] || printf '\n   The certificate is self-signed (Let'"'"'s Encrypt cannot reach port %s): the browser warns once; accept it.' "$HTTPS_PORT")

1. Sign up at $URL; you are signed in at once. Then close registration (hostinger.md §6): set
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

[ -n "$GATEWAY_PORT" ] && exit 0 # the stack is up; the proxy route above is the remaining step
logs_and_die "$URL/healthz did not answer within 3 minutes"

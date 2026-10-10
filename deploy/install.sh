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
#   GATEWAY_PORT    a box whose 80/443 belong to nginx, a Traefik outside Docker or another proxy (hostinger.md §11b):
#                   no Caddy, the gateway is published on 127.0.0.1:GATEWAY_PORT and that proxy terminates TLS for
#                   DOMAIN with a real certificate; the script prints the Traefik route to add. Not with
#                   HTTPS_PORT/HTTP_PORT.
# Traefik in a container on 80/443: the default line finds it and routes DOMAIN through it (its Docker provider, or
# a file in its file provider directory), so Traefik gets the certificate. What it reads from Traefik's config can
# be named instead: TRAEFIK_ENTRYPOINT (the one on 443), TRAEFIK_RESOLVER (certificate resolver; empty = none),
# TRAEFIK_NETWORK (a network Traefik is on).
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

# Traefik already on 80/443: its container, and what its static configuration says. Traefik reads one source
# only: a configuration file if there is one, else its flags, else its TRAEFIK_* variables.
traefik_container() { docker ps --format '{{.ID}} {{.Image}}' | awk 'tolower($2) ~ /traefik/ { print $1; exit }'; }
traefik_names_ok() { # <entrypoint> <resolver> <network>, each may be empty
  [[ $1 =~ ^[A-Za-z0-9_-]*$ && $2 =~ ^[A-Za-z0-9_-]*$ && $3 =~ ^[A-Za-z0-9_.-]*$ ]]
}
yaml_flat() { # YAML on stdin -> a.b.c=value lines; block mappings only, list items are skipped
  awk '
    function unquote(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); gsub(/^["'"'"']|["'"'"']$/, "", s); return s }
    /^[[:space:]]*(#.*)?$/ || /^(---|\.\.\.)/ { next }
    {
      ind = match($0, /[^ ]/) - 1; line = substr($0, ind + 1); c = index(line, ":")
      if (line ~ /^-/ || c == 0) next
      key = substr(line, 1, c - 1); val = substr(line, c + 1)
      if (val != "" && val !~ /^[[:space:]]/) next # a:b is a scalar, not a key
      while (n > 0 && depth[n] >= ind) n--
      depth[++n] = ind; name[n] = unquote(key); path = name[1]
      for (i = 2; i <= n; i++) path = path "." name[i]
      sub(/[[:space:]]+#.*$/, "", val); print path "=" unquote(val)
    }'
}
toml_flat() { # TOML on stdin -> a.b.c=value lines; [[arrays of tables]] are skipped
  awk '
    function unquote(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); gsub(/^["'"'"']|["'"'"']$/, "", s); return s }
    /^[[:space:]]*(#.*)?$/ { next }
    { sub(/^[[:space:]]+/, "") }
    /^\[\[/ { skip = 1; next }
    /^\[/ { skip = 0; prefix = $0; sub(/^\[/, "", prefix); sub(/\].*$/, "", prefix); gsub(/[[:space:]"]/, "", prefix); print prefix "="; next }
    skip { next }
    {
      e = index($0, "="); if (e == 0) next
      key = substr($0, 1, e - 1); gsub(/[[:space:]"]/, "", key); val = substr($0, e + 1); sub(/[[:space:]]+#.*$/, "", val)
      print (prefix == "" ? key : prefix "." key) "=" unquote(val)
    }'
}
traefik_static() { # <container id>: its static configuration as a.b.c=value lines
  local id=$1 args f file='' text=''
  args=$(docker inspect -f '{{range .Args}}{{println .}}{{end}}' "$id")
  f=$(printf '%s\n' "$args" | grep -i '^--configfile=' | head -1 | cut -d= -f2- || true)
  for f in $f /etc/traefik/traefik.yml /etc/traefik/traefik.yaml /etc/traefik/traefik.toml; do
    text=$(docker exec "$id" cat "$f" 2>/dev/null) && { file=$f; break; }
  done
  if [ -n "$file" ]; then
    case $file in *.toml) toml_flat ;; *) yaml_flat ;; esac <<<"$text"
  elif printf '%s\n' "$args" | grep -q '^--'; then
    printf '%s\n' "$args" | sed -n 's/^--//p'
  else
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" |
      awk '/^TRAEFIK_/ { e = index($0, "="); k = tolower(substr($0, 9, e - 9)); gsub(/_/, ".", k); print k substr($0, e) }'
  fi
}
traefik_detect() { # <container id>: sets T_ENTRYPOINT T_RESOLVER T_DOCKER T_NETWORK T_FILEDIR T_HOSTNET; TRAEFIK_* given win
  local id=$1 port
  # The entrypoint behind the host's 443: the container port published there (443 itself with host networking),
  # else the one named websecure.
  port=$(docker port "$id" 2>/dev/null | awk '$NF ~ /:443$/ { sub(/\/.*/, "", $1); print $1; exit }')
  IFS='|' read -r T_ENTRYPOINT T_RESOLVER T_DOCKER T_NETWORK T_FILEDIR < <(traefik_static "$id" | awk -v port="${port:-443}" '
    { e = index($0, "="); if (e == 0) e = length($0) + 1; k = substr($0, 1, e - 1); v = substr($0, e + 1); lk = tolower(k); split(k, p, ".") }
    lk ~ /^entrypoints\.[^.]+\.address$/ {
      a = v; sub(/\/(tcp|udp)$/, "", a)
      if (ep == "" && a ~ (":" port "$")) ep = p[2]
      if (tolower(p[2]) == "websecure") ws = p[2]
    }
    lk ~ /^certificatesresolvers\.[^.]+/ && res == "" { res = p[2] }
    (lk == "providers.docker" && tolower(v) != "false") || lk ~ /^providers\.docker\./ { dock = 1 }
    lk == "providers.docker.network" { net = v }
    lk == "providers.file.directory" { dir = v }
    END { print (ep != "" ? ep : ws) "|" res "|" dock "|" net "|" dir }')
  # Without a network in its config: the first user-defined network the container is on.
  [ -n "$T_NETWORK" ] || T_NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$id" |
    grep -vxE 'bridge|host|none' | head -1 || true)
  T_HOSTNET=$([ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$id")" = host ] && echo 1 || true)
  [ -z "${TRAEFIK_ENTRYPOINT:-}" ] || T_ENTRYPOINT=$TRAEFIK_ENTRYPOINT
  [ -z "${TRAEFIK_RESOLVER+1}" ] || T_RESOLVER=$TRAEFIK_RESOLVER
  [ -z "${TRAEFIK_NETWORK:-}" ] || T_NETWORK=$TRAEFIK_NETWORK
}
traefik_file_route() { # <container id> <backend url>: a dynamic-configuration file in Traefik's file provider directory
  local tmp
  tmp=$(mktemp)
  cat >"$tmp" <<EOF
# Written by $DIR/deploy/install.sh: Traefik serves $DOMAIN from the gateway.
http:
  routers:
    $ROUTER:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [$T_ENTRYPOINT]
      service: $ROUTER
      tls: {${T_RESOLVER:+ certResolver: $T_RESOLVER }}
  services:
    $ROUTER:
      loadBalancer:
        servers: [{ url: "$2" }]
EOF
  chmod 644 "$tmp"
  if ! docker cp "$tmp" "$1:$T_FILEDIR/$ROUTER.yml" >/dev/null; then
    rm -f "$tmp"
    die "could not write $T_FILEDIR/$ROUTER.yml in the Traefik container (a read-only mount?)"
  fi
  rm -f "$tmp"
}
TRAEFIK='' TRAEFIK_VIA='' # Traefik's container, and docker (labels), file (a file, over its network) or file-host
LOCAL_PORT=5454       # file-host: Traefik on the host network reaches the gateway on 127.0.0.1:5454
# The .env lines that pick the mode; the secrets and everything else come from .env.example or the kept .env.
mode_lines() {
  printf 'PUBLIC_URL=%s\n' "$URL"
  if [ "$TRAEFIK_VIA" = docker ] || [ "$TRAEFIK_VIA" = file ]; then
    printf 'COMPOSE_PROFILES=upstream\nCOMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml\n'
    printf 'TRAEFIK_%s\n' "HOST=$DOMAIN" "ROUTER=$ROUTER" "ENTRYPOINT=$T_ENTRYPOINT" "RESOLVER=$T_RESOLVER" "NETWORK=$T_NETWORK"
  elif [ "$TRAEFIK_VIA" = file-host ]; then
    printf 'COMPOSE_PROFILES=upstream\nCOMPOSE_FILE=docker-compose.yml:docker-compose.direct.yml\nGATEWAY_PORT=127.0.0.1:%s\n' "$LOCAL_PORT"
  elif [ -n "$GATEWAY_PORT" ]; then
    printf 'COMPOSE_PROFILES=upstream\nCOMPOSE_FILE=docker-compose.yml:docker-compose.direct.yml\nGATEWAY_PORT=127.0.0.1:%s\n' "$GATEWAY_PORT"
  elif [ "$HTTPS_PORT" != 443 ] || [ "$HTTP_PORT" != 80 ]; then
    printf 'COMPOSE_PROFILES=caddy,upstream\nHTTPS_PORT=%s\nHTTP_PORT=%s\nCADDYFILE=Caddyfile.selfsigned\n' "$HTTPS_PORT" "$HTTP_PORT"
  else
    printf 'COMPOSE_PROFILES=caddy,upstream\n'
  fi
}
MODE_KEYS='^(PUBLIC_URL|COMPOSE_PROFILES|COMPOSE_FILE|GATEWAY_PORT|HTTPS_PORT|HTTP_PORT|CADDYFILE|TRAEFIK_[A-Z]+)='
rewrite_mode() { # the mode lines of deploy/.env from mode_lines, every other line (and the secrets) kept
  umask 077
  { grep -vE "$MODE_KEYS" .env || true; mode_lines; } >.env.tmp
  mv .env.tmp .env && chmod 600 .env
  umask 022
}
# Sourced (deploy/install.traefik.test.sh): the functions only.
(return 0 2>/dev/null) && return 0

# Inputs first, so a typo is reported before anything else happens.
[ -n "$DOMAIN" ] || die "DOMAIN is required, e.g. DOMAIN=gw.example.com (a bare hostname)"
[[ $DOMAIN =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] ||
  die "DOMAIN must be a bare hostname like gw.example.com (no https://, path or port), got: $DOMAIN"
[[ $HTTPS_PORT =~ ^[0-9]+$ && $HTTP_PORT =~ ^[0-9]+$ ]] || die "HTTPS_PORT and HTTP_PORT must be numbers, got: $HTTPS_PORT $HTTP_PORT"
[[ -z $GATEWAY_PORT || $GATEWAY_PORT =~ ^[0-9]+$ ]] || die "GATEWAY_PORT must be a number, got: $GATEWAY_PORT"
if [ -n "$GATEWAY_PORT" ] && { [ "$HTTPS_PORT" != 443 ] || [ "$HTTP_PORT" != 80 ]; }; then
  die "GATEWAY_PORT (the box's own proxy serves 443) does not go with HTTPS_PORT/HTTP_PORT (our Caddy on other ports)"
fi
traefik_names_ok "${TRAEFIK_ENTRYPOINT:-}" "${TRAEFIK_RESOLVER:-}" "${TRAEFIK_NETWORK:-}" ||
  die "TRAEFIK_ENTRYPOINT, TRAEFIK_RESOLVER and TRAEFIK_NETWORK take a name (letters, digits, - and _, and . in a network), got: ${TRAEFIK_ENTRYPOINT:-} ${TRAEFIK_RESOLVER:-} ${TRAEFIK_NETWORK:-}"
if [ -n "$GATEWAY_PORT" ] || [ "$HTTPS_PORT" = 443 ]; then URL="https://$DOMAIN"; else URL="https://$DOMAIN:$HTTPS_PORT"; fi

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
    rewrite_mode
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
  # Running only: a caddy that restarts because Traefik holds its ports is not the holder.
  own=$(docker compose ps -q --status running caddy 2>/dev/null || true); check_ports="$HTTP_PORT $HTTPS_PORT"
fi
# The host ports our own container publishes (empty when there is none): only those are not "taken".
own_ports=$( [ -n "$own" ] && docker port "$own" 2>/dev/null | sed -E 's/.*:([0-9]+)$/\1/' | sort -u || true)
for port in $check_ports; do
  holder=$(ss -Hltnp "sport = :$port" 2>/dev/null | head -1)
  [ -z "$holder" ] && continue
  if printf '%s\n' "$own_ports" | grep -qx "$port"; then continue; fi
  # The default line on a box whose 80/443 belong to a Traefik container: the domain goes through it.
  if [ -z "$GATEWAY_PORT" ] && [ "$HTTPS_PORT" = 443 ] && [ "$HTTP_PORT" = 80 ] && TRAEFIK=$(traefik_container) && [ -n "$TRAEFIK" ]; then
    break
  fi
  die "port $port is already in use on this VPS ($holder). A box whose 80/443 belong to Traefik or nginx: GATEWAY_PORT=5454 in front of the install line (that proxy serves the domain, hostinger.md §11b). Otherwise name two free ports, e.g. HTTPS_PORT=8443 HTTP_PORT=8081 (self-signed certificate, §0); ss -Hltn lists the ports in use"
done

if [ -n "$TRAEFIK" ]; then
  traefik_detect "$TRAEFIK"
  ROUTER=gateway-$(printf '%s' "$DOMAIN" | tr 'A-Z.' 'a-z-') # one router per domain, apart from the box's other apps
  if [ -n "$T_HOSTNET" ]; then
    [ -z "$T_FILEDIR" ] || TRAEFIK_VIA='file-host'
  elif [ -n "$T_NETWORK" ] && [ -n "$T_DOCKER" ]; then
    TRAEFIK_VIA='docker'
  elif [ -n "$T_NETWORK" ] && [ -n "$T_FILEDIR" ]; then
    TRAEFIK_VIA='file'
  fi
  if [ -z "$TRAEFIK_VIA" ] || [ -z "$T_ENTRYPOINT" ]; then
    die "Traefik (container $TRAEFIK) owns 80/443, but its config does not say how to route $DOMAIN through it. Found: entrypoint on 443 '$T_ENTRYPOINT', certificate resolver '$T_RESOLVER', docker provider ${T_DOCKER:+on}${T_DOCKER:-off}, network '$T_NETWORK', file provider directory '$T_FILEDIR', host networking ${T_HOSTNET:+yes}${T_HOSTNET:-no}. Needed: an entrypoint, and the docker provider with a user-defined network, or a file provider directory. Name what is missing in front of the line, e.g. TRAEFIK_ENTRYPOINT=websecure TRAEFIK_RESOLVER=letsencrypt TRAEFIK_NETWORK=traefik; or route the domain yourself with GATEWAY_PORT=5454 (hostinger.md §11b)"
  fi
  traefik_names_ok "$T_ENTRYPOINT" "$T_RESOLVER" "$T_NETWORK" ||
    die "Traefik's config has names install.sh does not handle: entrypoint '$T_ENTRYPOINT', resolver '$T_RESOLVER', network '$T_NETWORK'; name them with TRAEFIK_ENTRYPOINT, TRAEFIK_RESOLVER, TRAEFIK_NETWORK"
  [ -n "$T_RESOLVER" ] ||
    echo "install: warning: Traefik has no certificate resolver, so $DOMAIN gets its default certificate (TRAEFIK_RESOLVER=<name> names one)" >&2
  if [ "$TRAEFIK_VIA" = file-host ]; then
    holder=$(ss -Hltnp "sport = :$LOCAL_PORT" 2>/dev/null | head -1)
    if [ -n "$holder" ] && [ -z "$(docker compose ps -q gateway 2>/dev/null)" ]; then
      die "port $LOCAL_PORT is already in use on this VPS ($holder); Traefik on the host network reaches the gateway there"
    fi
  fi
  rewrite_mode
  # A caddy from an earlier run would fight Traefik for 80/443.
  [ -z "$(docker compose --profile caddy ps -aq caddy 2>/dev/null)" ] || docker compose --profile caddy rm -sf caddy >/dev/null
  case $TRAEFIK_VIA in
    # The compose project is gateway-prod, so the container is gateway-prod-gateway-1 on Traefik's network.
    file) traefik_file_route "$TRAEFIK" http://gateway-prod-gateway-1:4000 ;;
    file-host) traefik_file_route "$TRAEFIK" "http://127.0.0.1:$LOCAL_PORT" ;;
  esac
  say "Traefik owns 80/443: $DOMAIN goes through it (entrypoint $T_ENTRYPOINT, certificate resolver ${T_RESOLVER:-none}, $([ "$TRAEFIK_VIA" = docker ] && echo "labels on network $T_NETWORK" || echo "file $T_FILEDIR/$ROUTER.yml"))"
fi

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

say "waiting for $URL/healthz${TRAEFIK:+ (Traefik first gets the certificate)}"
# -k: on an alternate port the certificate comes from Caddy's own CA. Behind Traefik it must be a trusted one,
# unless Traefik has no resolver.
insecure=1; [ -z "$TRAEFIK" ] || [ -z "$T_RESOLVER" ] || insecure=
for _ in $(seq "$([ -n "$GATEWAY_PORT" ] && echo 2 || echo 36)"); do
  if curl -fs ${insecure:+-k} -o /dev/null --max-time 5 "$URL/healthz"; then # -s only: attempts before the certificate exists are not errors
    cat <<EOF

Done: $URL is up.$([ -z "$TRAEFIK" ] || printf '\n   Traefik on this box serves it, with its certificate (resolver %s).' "${T_RESOLVER:-none: its default certificate}")$([ "$HTTPS_PORT" = 443 ] || printf '\n   The certificate is self-signed (Let'"'"'s Encrypt cannot reach port %s): the browser warns once; accept it.' "$HTTPS_PORT")

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

if [ -n "$TRAEFIK" ]; then
  echo "install: $URL/healthz did not answer within 3 minutes; recent Traefik and gateway logs:" >&2
  docker logs --tail 30 "$TRAEFIK" >&2 || true
  docker compose logs --no-color --tail 40 gateway >&2 || true
  die "Traefik gets the certificate from Let's Encrypt over 80/443: check the A record (hostinger.md §2) and Traefik's log above for $DOMAIN; see hostinger.md §12"
fi
[ -n "$GATEWAY_PORT" ] && exit 0 # the stack is up; the proxy route above is the remaining step
logs_and_die "$URL/healthz did not answer within 3 minutes"

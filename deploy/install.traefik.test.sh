#!/usr/bin/env bash
# Runs install.sh's Traefik detection and routing against real traefik:v3 containers (needs docker, not root):
#   bash deploy/install.traefik.test.sh
# 1. flags + docker provider: detection finds entrypoint websecure, no resolver and the network; the .env lines and
#    docker-compose.traefik.yml put a whoami container (as "gateway") behind Traefik, over TLS.
# 2. a mounted traefik.yml: entrypoint on :443, resolver, docker network and file directory come from the file.
# 3. TRAEFIK_* variables + file provider only: the file route install.sh writes reaches a whoami container.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null # not followed: shellcheck would take its final exit for this script's
. "$here/install.sh" # the functions only
set +e
unset TRAEFIK_ENTRYPOINT TRAEFIK_RESOLVER TRAEFIK_NETWORK
NET=traefik_test PROJECT=gwtraefiktest IMAGE=traefik:v3
tmp=$(mktemp -d)
fail=0

check() { # <label> <want> <got>
  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: want '$2', got '$3'"; fail=1; fi
}
compose() { docker compose --env-file "$tmp/.env" -p "$PROJECT" -f "$tmp/base.yml" -f "$here/docker-compose.traefik.yml" "$@"; }
# shellcheck disable=SC2329 # the EXIT trap runs it
cleanup() {
  [ -f "$tmp/.env" ] && compose down -t 1 >/dev/null 2>&1
  docker rm -f gwtt-flags gwtt-file gwtt-env gwtt-whoami >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT
reaches() { # <host> <port>: whoami answers https://<host>:<port>/ through Traefik within 30 s
  for _ in $(seq 30); do
    curl -fsk --max-time 2 --resolve "$1:$2:127.0.0.1" "https://$1:$2/" 2>/dev/null | grep -q '^Hostname:' && return 0
    sleep 1
  done
  return 1
}

docker network create "$NET" >/dev/null || exit 1

# 1. Flags, docker provider, a user-defined network.
docker run -d --name gwtt-flags --network "$NET" -p 127.0.0.1:18080:18080 -p 127.0.0.1:18443:18443 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro "$IMAGE" \
  --providers.docker --entrypoints.websecure.address=:18443 --entrypoints.web.address=:18080 --api.insecure=true >/dev/null
check "flags: traefik_container" "$(docker ps -q --filter name=gwtt-flags)" "$(traefik_container)"
traefik_detect gwtt-flags
check "flags: entrypoint" websecure "$T_ENTRYPOINT"
check "flags: resolver" "" "$T_RESOLVER"
check "flags: docker provider" 1 "$T_DOCKER"
check "flags: network" "$NET" "$T_NETWORK"
check "flags: host networking" "" "$T_HOSTNET"
# shellcheck disable=SC2034 # read by mode_lines
DOMAIN=test.local URL=https://test.local TRAEFIK_VIA=docker
ROUTER=gateway-$(printf '%s' "$DOMAIN" | tr 'A-Z.' 'a-z-')
mode_lines >"$tmp/.env"
printf 'services:\n  gateway:\n    image: traefik/whoami\n    command: --port 4000\n' >"$tmp/base.yml"
check "flags: tls label without resolver" "true" \
  "$(compose config --format json | grep -o '"traefik.http.routers.gateway-test-local.tls": *"[^"]*"' | sed 's/.*: *"//; s/"$//')"
compose up -d >/dev/null 2>&1 || { echo "FAIL  compose up"; compose up -d; fail=1; }
if reaches test.local 18443; then echo "ok    flags: labels route test.local to the container over TLS"; else
  echo "FAIL  flags: https://test.local:18443 does not reach the container"; docker logs --tail 20 gwtt-flags; fail=1
fi
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve other.local:18443:127.0.0.1 https://other.local:18443/)
check "flags: another host is not routed" 404 "$code"
sed -i.bak 's/^TRAEFIK_RESOLVER=.*/TRAEFIK_RESOLVER=le/' "$tmp/.env"
check "flags: certresolver label with a resolver" "le" \
  "$(compose config --format json | grep -o '"traefik.http.routers.gateway-test-local.tls.certresolver": *"[^"]*"' | sed 's/.*: *"//; s/"$//')"
compose down -t 1 >/dev/null 2>&1
docker rm -f gwtt-flags >/dev/null

# 2. A mounted static configuration file (it wins over flags and variables, as in Traefik).
cat >"$tmp/traefik.yml" <<'YML'
# Static configuration as Hostinger-style templates write it.
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: https
  https:
    address: ':443'
certificatesResolvers:
  myresolver:
    acme:
      email: admin@example.org
      storage: /tmp/acme.json
      httpChallenge:
        entryPoint: web
providers:
  docker:
    exposedByDefault: false
    network: traefik_test # the shared network
  file:
    directory: /etc/traefik/dynamic
YML
docker run -d --name gwtt-file -v "$tmp/traefik.yml:/etc/traefik/traefik.yml:ro" "$IMAGE" --entrypoints.decoy.address=:443 >/dev/null
traefik_detect gwtt-file
check "file: entrypoint on :443" https "$T_ENTRYPOINT"
check "file: resolver" myresolver "$T_RESOLVER"
check "file: docker provider" 1 "$T_DOCKER"
check "file: network" "$NET" "$T_NETWORK"
check "file: file provider directory" /etc/traefik/dynamic "$T_FILEDIR"
TRAEFIK_RESOLVER='' TRAEFIK_NETWORK=other traefik_detect gwtt-file
check "file: TRAEFIK_RESOLVER= overrides" "" "$T_RESOLVER"
check "file: TRAEFIK_NETWORK overrides" other "$T_NETWORK"
docker rm -f gwtt-file >/dev/null

# 3. TRAEFIK_* variables, file provider only: install.sh writes the route into the directory.
mkdir "$tmp/dyn"
docker run -d --name gwtt-env --network "$NET" -p 127.0.0.1:18444:443 -v "$tmp/dyn:/dyn" \
  -e TRAEFIK_ENTRYPOINTS_SECURE_ADDRESS=:443 -e TRAEFIK_PROVIDERS_FILE_DIRECTORY=/dyn "$IMAGE" >/dev/null
docker run -d --name gwtt-whoami --network "$NET" traefik/whoami --port 4000 >/dev/null
traefik_detect gwtt-env
check "env: entrypoint" secure "$T_ENTRYPOINT"
check "env: docker provider" "" "$T_DOCKER"
check "env: network" "$NET" "$T_NETWORK"
check "env: file provider directory" /dyn "$T_FILEDIR"
DOMAIN=file.local ROUTER=gateway-file-local
traefik_file_route gwtt-env http://gwtt-whoami:4000
if reaches file.local 18444; then echo "ok    env: the file route reaches the container over TLS"; else
  echo "FAIL  env: https://file.local:18444 does not reach the container"; cat "$tmp/dyn/$ROUTER.yml"; docker logs --tail 20 gwtt-env; fail=1
fi

# The TOML flattener, without docker.
got=$(printf '[entryPoints.websecure]\n  address = ":443"\n[certificatesResolvers.le.acme]\n  email = "a@b.c" # x\n[[tls.certificates]]\n  certFile = "x"\n' | toml_flat | tr '\n' ' ')
check "toml_flat" 'entryPoints.websecure= entryPoints.websecure.address=:443 certificatesResolvers.le.acme= certificatesResolvers.le.acme.email=a@b.c ' "$got"

[ "$fail" -eq 0 ] && echo "install.traefik.test: ok" || echo "install.traefik.test: FAILED" >&2
exit "$fail"

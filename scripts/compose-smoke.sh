#!/usr/bin/env sh
# Boots deploy/docker-compose.yml under its own project name and checks the stack through Caddy.
# CI and humans run it the same way: sh scripts/compose-smoke.sh
# PUBLIC_URL=http://localhost keeps Caddy on plain :80, so no ACME is attempted.
set -eu

# Run from the repo root whatever the caller's cwd is.
CDPATH='' cd -- "$(dirname -- "$0")/.."

ENV=$(mktemp)
cat > "$ENV" <<EOF
COMPOSE_PROFILES=caddy
PUBLIC_URL=http://localhost
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -hex 24)
UPSTREAM_URL=http://upstream.invalid
UPSTREAM_TOKEN=smoke-only-upstream-token
EOF

# A project name of its own, so a real local stack is never touched.
dc() { docker compose -p gateway-smoke --env-file "$ENV" -f deploy/docker-compose.yml "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- compose smoke failed (exit $status); state follows ---" >&2
    dc ps >&2 || true
    dc logs --tail 100 gateway >&2 || true
    dc logs --tail 100 caddy >&2 || true
  fi
  dc down -v --remove-orphans >&2 || true
  rm -f "$ENV"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "compose smoke: $1" >&2
  exit 1
}

dc up -d --build --wait --wait-timeout 180 || fail "the stack did not come up healthy within 180s"

# 1. The gateway answers through Caddy.
health=$(curl -fsS --retry 15 --retry-connrefused --retry-delay 2 http://localhost/healthz) \
  || fail "GET http://localhost/healthz failed"
case $health in
  *'"ok":true'*) ;;
  *) fail "/healthz did not report ok:true, got: $health" ;;
esac

# 2. The dashboard SPA is served from the same origin.
login=$(curl -fsS -H 'accept: text/html' http://localhost/login) \
  || fail "GET http://localhost/login failed"
case $login in
  *'<div id="root">'*) ;;
  *) fail '/login did not serve the SPA shell (no <div id="root">)' ;;
esac

# 3. The upstream is unreachable here, so the merged spec must degrade, not fail.
heads=$(curl -sSI http://localhost/openapi.json) || fail "HEAD http://localhost/openapi.json failed"
printf '%s\n' "$heads" | grep -qE '^HTTP/[0-9.]+ 200' \
  || fail "/openapi.json was not 200: $(printf '%s\n' "$heads" | head -n 1)"
printf '%s\n' "$heads" | grep -qiE '^x-upstream-spec:[[:space:]]*unavailable' \
  || fail "/openapi.json lacks 'x-upstream-spec: unavailable'"

# 4. Caddy publishes the only host ports.
for svc_port in postgres:5432 gateway:4000; do
  svc=${svc_port%:*}
  port=${svc_port#*:}
  if published=$(dc port "$svc" "$port" 2>/dev/null) && [ -n "$published" ]; then
    fail "$svc publishes $port on the host ($published); only caddy may publish"
  fi
done

# 5. The gateway container does not run as root.
uid=$(dc exec -T gateway id -u 2>/dev/null | tr -d '\r') || fail "could not run 'id -u' in the gateway container"
[ -n "$uid" ] || fail "could not read the gateway container's uid"
[ "$uid" != 0 ] || fail "the gateway container runs as root"

echo "compose smoke: ok"

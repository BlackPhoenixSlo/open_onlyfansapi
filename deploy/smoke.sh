#!/usr/bin/env bash
# Post-deploy smoke test: ./smoke.sh <base-url> <api-key> <account-id>
# Read-only GETs. Prints status codes and JSON key names only, never values. Exits 1 on any non-200.
set -uo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <base-url> <api-key> <account-id>" >&2; exit 2; }
base=${1%/}; key=$2; acct=$3; fail=0; body=$(mktemp); trap 'rm -f "$body"' EXIT

check() { # <label> <path> [auth]
  local code
  if [ "${3:-}" = auth ]; then
    # Key goes in on stdin, so it stays out of the process list.
    code=$(printf 'header = "Authorization: Bearer %s"\n' "$key" |
      curl -sS -K - -o "$body" -w '%{http_code}' --max-time 30 "$base$2") || code=000
  else
    code=$(curl -sS -o "$body" -w '%{http_code}' --max-time 30 "$base$2") || code=000
  fi
  local keys
  keys=$(python3 - "$body" <<'PY' 2>/dev/null || echo '(not JSON)'
import json, sys
d = json.load(open(sys.argv[1]))
top = sorted(d) if isinstance(d, dict) else [type(d).__name__]
inner = d.get("data") if isinstance(d, dict) else None
print(" ".join(top) + (" | data: " + " ".join(sorted(inner)) if isinstance(inner, dict) else ""))
PY
)
  printf '%-14s %s  %s\n' "$1" "$code" "$keys"
  [ "$code" = 200 ] || fail=1
}

check healthz /healthz
check me "/v1/$acct/me" auth
check drm "/v1/$acct/settings/drm" auth

[ $fail -eq 0 ] && echo "smoke: ok" || echo "smoke: FAILED" >&2
exit $fail

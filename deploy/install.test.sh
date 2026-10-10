#!/usr/bin/env bash
# Checks deploy/install.sh without docker or root: syntax, then the input checks that run before anything else.
#   bash deploy/install.test.sh
set -uo pipefail
script="$(dirname "$0")/install.sh"
fail=0

expect() { # <label> <stderr substring> <env assignments...>
  local label=$1 want=$2 out code
  shift 2
  out=$(env -i PATH="$PATH" "$@" bash "$script" 2>&1 </dev/null) && code=0 || code=$?
  if [ "$code" -ne 0 ] && [[ $out == *"$want"* ]]; then
    echo "ok    $label"
  else
    echo "FAIL  $label (exit $code): $out"
    fail=1
  fi
}

if bash -n "$script"; then echo "ok    bash -n"; else echo "FAIL  bash -n"; fail=1; fi
expect "DOMAIN missing" "DOMAIN is required"
expect "DOMAIN with scheme" "bare hostname" DOMAIN=https://gw.example.com
expect "DOMAIN with port" "bare hostname" DOMAIN=gw.example.com:443
expect "GATEWAY_PORT with HTTPS_PORT" "does not go with" DOMAIN=gw.example.com GATEWAY_PORT=5454 HTTPS_PORT=8443
expect "GATEWAY_PORT not a number" "must be a number" DOMAIN=gw.example.com GATEWAY_PORT=abc
if [ "$(id -u)" -eq 0 ]; then
  echo "skip  not root (running as root)"
else
  expect "not root" "must run as root" DOMAIN=gw.example.com
fi

[ "$fail" -eq 0 ] && echo "install.test: ok" || echo "install.test: FAILED" >&2
exit "$fail"

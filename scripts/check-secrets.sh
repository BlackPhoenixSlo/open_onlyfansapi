#!/usr/bin/env sh
# Fails if staged files (or the whole tree with --all) contain known token patterns.
# Patterns: reference-product keys (ofapi_), generic bearer/sk/ghp tokens, private keys.
set -eu
PATTERN='ofapi_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
if [ "${1:-}" = "--all" ]; then
  FILES=$(git ls-files)
else
  FILES=$(git diff --cached --name-only --diff-filter=ACM)
fi
[ -z "$FILES" ] && exit 0
if echo "$FILES" | xargs grep -nE "$PATTERN" -- 2>/dev/null; then
  echo "secrets check: token-like strings found above; refusing." >&2
  exit 1
fi
exit 0

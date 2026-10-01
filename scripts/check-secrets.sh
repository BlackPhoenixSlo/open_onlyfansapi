#!/usr/bin/env sh
# Fails if staged files (or the whole tree with --all) contain known token patterns.
# Patterns: reference-product keys (ofapi_), generic bearer/sk/ghp tokens, private keys.
set -eu
PATTERN='ofapi_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
# NUL-separated names (paths may contain spaces). Matches are judged by output, not by the exit status
# (xargs folds "no match in one batch" and "match in another" into the same non-zero status).
if [ "${1:-}" = "--all" ]; then
  MATCHES=$(git ls-files -z | xargs -0 grep -nIE "$PATTERN" -- || true)
else
  MATCHES=$(git diff --cached --name-only -z --diff-filter=ACM | xargs -0 grep -nIE "$PATTERN" -- || true)
fi
if [ -n "$MATCHES" ]; then
  echo "$MATCHES"
  echo "secrets check: token-like strings found above; refusing." >&2
  exit 1
fi
exit 0

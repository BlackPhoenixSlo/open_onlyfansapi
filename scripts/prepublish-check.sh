#!/usr/bin/env sh
# Pre-publish gate: run this before the first public push (and before any later one).
# Checks the tracked tree only. Prints every failure, then exits 1 if there was any.
set -u

# The reference-product brand, built by concatenation so that this script is not itself a match.
BRAND='only''fansapi|ofapi''_'

fail=0
report() {
  fail=1
  echo "FAIL: $*"
}

# 1. staged/tree secrets check
if ! secrets=$(sh scripts/check-secrets.sh --all 2>&1); then
  report "scripts/check-secrets.sh --all failed:"
  echo "$secrets"
fi

# 2. third-party brand in tracked files (docs/spec is covered by check 5; the other two
#    carry the brand on purpose: an ignore rule and a token pattern)
brand_hits=$(git grep -I -i -n -E -e "$BRAND" -- \
  ':(exclude)docs/spec' ':(exclude).gitignore' ':(exclude).dockerignore' ':(exclude)scripts/check-secrets.sh' || true)
if [ -n "$brand_hits" ]; then
  report "tracked files mention the third-party brand; rename or scrub before publishing:"
  echo "$brand_hits"
fi

# 2b. the private upstream must be filtered out before a public publish
if git ls-files --error-unmatch services >/dev/null 2>&1; then
  report "services/ is tracked: private-only tree; filter it out before any public publish"
fi

# 3. README disclaimer
if ! grep -qi 'not affiliated' README.md 2>/dev/null; then
  report "README.md has no line containing \"not affiliated\"."
fi

# 4. licence
if [ ! -f LICENSE ]; then
  report "LICENSE is missing."
elif ! grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' LICENSE; then
  report "LICENSE does not contain \"GNU AFFERO GENERAL PUBLIC LICENSE\"."
fi

# 5. derived specs must leave the public tree
spec_tracked=$(git ls-files -- docs/spec/pages.md docs/spec/endpoints.md docs/spec/mapping.md)
if [ -n "$spec_tracked" ]; then
  report "derived specs are still tracked (they describe a competitor's product and a reverse-engineered platform API):"
  echo "$spec_tracked"
  echo "  hint: git rm --cached $(echo "$spec_tracked" | tr '\n' ' ')"
fi

if [ "$fail" -ne 0 ]; then
  echo "pre-publish check: not ready to publish." >&2
  exit 1
fi
echo "pre-publish check: ok."
exit 0

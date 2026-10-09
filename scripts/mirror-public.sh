#!/usr/bin/env sh
# Mirrors this repository to the public one: a fresh clone, history rewritten without the
# private upstream (services/), the pre-publish gate, then a force push of master and the tags.
# Run by .github/workflows/mirror.yml on every push to master; works by hand too:
#   sh scripts/mirror-public.sh                      # pushes to MIRROR_REMOTE
#   MIRROR_REMOTE=/tmp/public.git sh scripts/mirror-public.sh   # e.g. a local bare repo to inspect
# git filter-repo is deterministic, so repeated runs rewrite the same commits to the same ids and
# the push is normally a fast-forward; the force only matters after a rebase of master.
set -eu

MIRROR_REMOTE=${MIRROR_REMOTE:-git@github.com:BlackPhoenixSlo/gateway-public.git}
SOURCE=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --no-local --branch master "$SOURCE" "$WORK/repo"
cd "$WORK/repo"
git filter-repo --quiet --path services --invert-paths

sh scripts/prepublish-check.sh

git push --force "$MIRROR_REMOTE" master
git push --force "$MIRROR_REMOTE" --tags
echo "mirrored $(git rev-parse --short HEAD) ($(git rev-list --count HEAD) commits) to $MIRROR_REMOTE"

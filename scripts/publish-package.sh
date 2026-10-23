#!/usr/bin/env bash
# ============================================================================
# Publishes this package to the npm registry in NPM_REGISTRY_URL, at the version in package.json. Other repos then
# get it by version: they list "@automation/referenced-automation-sas": "^<version>" in package.json.
#
# Usage: ./scripts/publish-package.sh [--dry-run]
#
# Before publishing:
#   - bump the version (a version can be published only once):  npm version patch|minor|major
#     and commit the change; update CHANGELOG.md
#   - your npm must already be allowed to publish to that registry - this script does not log in for you
#     (use your organisation's usual way to authenticate npm against it)
#   --dry-run  builds the package and shows what would be uploaded, without uploading anything
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${NPM_REGISTRY_URL:-}" ]; then
  echo "ERROR: set NPM_REGISTRY_URL to your organisation's npm registry URL, then run this again." >&2
  exit 1
fi
npm config set registry "$NPM_REGISTRY_URL"

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN="--dry-run"; fi

OUT_DIR="$(mktemp -d)"
./scripts/create-package.sh "$OUT_DIR"
TARBALL="$(ls "$OUT_DIR"/*.tgz)"

echo ""
echo "== Publishing $(basename "$TARBALL") to $NPM_REGISTRY_URL ${DRY_RUN:+(dry run)} =="
npm publish "$TARBALL" --registry "$NPM_REGISTRY_URL" $DRY_RUN

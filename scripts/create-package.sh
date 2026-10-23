#!/usr/bin/env bash
# ============================================================================
# Builds this package and produces a versioned .tgz - the exact file `npm publish` uploads - named from the version
# in package.json: automation-referenced-automation-sas-<version>.tgz
#
# Two ways to use it:
#   1. Publish it to the registry:  ./scripts/publish-package.sh
#      Other repos then get it BY VERSION from their package.json (README: Publishing a package).
#   2. Keep it local: put the .tgz where the consuming repo can see it and install it there with
#      `npm install --no-save <file>.tgz` (README: Using a package without a registry) - or run
#      ./scripts/setup.sh --local in the consumer, which builds and installs every @automation dependency this way.
#
# Usage: ./scripts/create-package.sh [--local] [output-dir]
#   --local     build against the sibling @automation packages in ../shared-packages instead of the registry
#   output-dir  default ../shared-packages (sibling to this repo)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL=0
if [ "${1:-}" = "--local" ]; then
  LOCAL=1
  shift
fi
OUT_DIR="${1:-../shared-packages}"

# Every npm command below fetches packages from this registry.
if [ -n "${NPM_REGISTRY_URL:-}" ]; then
  npm config set registry "$NPM_REGISTRY_URL"
fi

mkdir -p "$OUT_DIR"

if [ "$LOCAL" = "1" ]; then
  # The packages this one depends on come from ../shared-packages instead of the registry (see scripts/setup.sh).
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ./scripts/setup.sh --local
else
  npm ci
fi
npm run clean
npm run build

# `npm pack` runs the "prepack" script (build) again and writes <name>-<version>.tgz into the current directory.
TARBALL="$(npm pack --silent)"
mv "$TARBALL" "$OUT_DIR/"

echo ""
echo "Package written to: $(cd "$OUT_DIR" && pwd)/$TARBALL"
echo "Publish it:             ./scripts/publish-package.sh"
echo "Or install it locally:  npm install --no-save $(cd "$OUT_DIR" && pwd)/$TARBALL"

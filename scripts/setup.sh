#!/usr/bin/env bash
# ============================================================================
# One-shot setup: installs this repo's dependencies. Also installs the Chromium binary Playwright needs plus its OS-level dependencies.
#
# Packages - the @automation/* ones too - are installed BY VERSION from the npm registry in NPM_REGISTRY_URL: the
# versions are the ones in package.json. To pick up a newer version of a package, change its version there and run
# `npm install` (README: Upgrading a package).
#
# Without these packages in a registry yet - or to try a change you have not published - use local mode:
#   ./scripts/setup.sh --local
# It builds the sibling repos this one depends on (referenced-automation-utils, referenced-automation-api, referenced-automation-ui), keeps their .tgz files in
# ../shared-packages and installs those instead. Nothing in package.json or package-lock.json changes. The sibling
# repos must be checked out next to this one. (USE_LOCAL_PACKAGES=1 does the same.)
#
# Usage: ./scripts/setup.sh [--local]
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL=0
for arg in "$@"; do
  if [ "$arg" = "--local" ]; then LOCAL=1; fi
done
if [ "${USE_LOCAL_PACKAGES:-}" = "1" ]; then LOCAL=1; fi

# Every npm command below fetches packages from this registry.
if [ -n "${NPM_REGISTRY_URL:-}" ]; then
  npm config set registry "$NPM_REGISTRY_URL"
else
  echo "NOTE: NPM_REGISTRY_URL is not set - npm keeps using the registry it is already configured with ($(npm config get registry))."
fi

SHARED_PACKAGES_DIR="../shared-packages"

# Builds <repo_name> into $SHARED_PACKAGES_DIR if no tarball of it is there yet. Needs <repo_name> checked out as a
# sibling of this repo; its own create-package.sh --local builds the packages IT depends on first.
ensure_package() {
  local repo_name="$1"
  if compgen -G "$SHARED_PACKAGES_DIR/automation-${repo_name}-*.tgz" > /dev/null 2>&1; then
    echo "== ${repo_name}: already packaged =="
    return
  fi
  local repo_dir="../${repo_name}"
  if [ ! -d "$repo_dir" ]; then
    echo "ERROR: ${repo_name} is not packaged and not checked out at ${repo_dir}." >&2
    echo "Clone it as a sibling of this repo first:" >&2
    echo "  git clone https://github.com/achaljoshi/${repo_name}.git ${repo_dir}" >&2
    exit 1
  fi
  echo "== Building ${repo_name} (dependency) =="
  ( cd "$repo_dir" && ./scripts/create-package.sh --local "$SHARED_PACKAGES_DIR" )
}

# The newest tarball of a package in $SHARED_PACKAGES_DIR (by version).
latest_tarball() {
  ls "$SHARED_PACKAGES_DIR"/automation-"$1"-*.tgz | sort -V | tail -1
}

if [ "$LOCAL" = "1" ]; then
  echo ""
  echo "== Local mode: making sure the @automation packages exist in ${SHARED_PACKAGES_DIR} =="
  ensure_package referenced-automation-utils
  ensure_package referenced-automation-api
  ensure_package referenced-automation-ui
  echo ""
  echo "== Installing dependencies (the @automation packages from ${SHARED_PACKAGES_DIR}; package.json and the lockfile stay as they are) =="
  npm install --no-save --no-audit --no-fund "$(latest_tarball referenced-automation-utils)" "$(latest_tarball referenced-automation-api)" "$(latest_tarball referenced-automation-ui)"
else
  echo ""
  echo "== Installing dependencies from the registry =========================="
  npm ci || {
    echo "" >&2
    echo "npm ci failed. If it stopped on an @automation/* package, that version is not in the registry yet:" >&2
    echo "publish it (see the README: Publishing a package) or run ./scripts/setup.sh --local." >&2
    exit 1
  }
fi

if [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = "1" ]; then
  echo ""
  echo "== Skipping Playwright browser download (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1) =="
  echo "Set BROWSER to a system-installed browser channel instead, e.g.:"
  echo "  BROWSER=msedge npm test   (or BROWSER=chrome)"
else
  echo ""
  echo "== Installing Playwright browsers ====================================="
  npx playwright install --with-deps chromium
fi

echo ""
echo "Setup complete. Try: npm test"

#!/usr/bin/env bash
# CI-ONLY: matrix per-fixture variant — local single-fixture invocation is covered by
# step [0/15] clean-state simulation when MASSU_PREPUSH_CLEAN=1
#
# Extracted from .github/workflows/fresh-install-matrix.yml `fresh-install` job
# (P1-003, plan-2026-05-18-pre-push-ci-parity). Takes fixture name as $1 and
# optional mode as $2 ('local' or 'published'). Local build is the candidate
# code; published variant catches drift between local build and what npm serves.
#
# Pre-push-light does NOT call this script (matrix invocation is impractical
# locally). The vitest drift-guard and pattern-scanner Check 26 recognize the
# `# CI-ONLY:` first-comment-line as an explicit opt-out.

set -euo pipefail
IFS=$'\n\t'

FIXTURE="${1:?usage: ci-fresh-install.sh <fixture-name> [local|published]}"
MODE="${2:-local}"
REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Validate FIXTURE against expected fixture-name pattern to prevent path
# traversal via untrusted $1 (LOW security finding 2026-05-18). Fixture dirs
# on disk are all lowercase-kebab-case; reject anything outside that shape.
if ! [[ "$FIXTURE" =~ ^[a-z][a-z0-9_-]*$ ]]; then
  echo "FAIL: invalid fixture name '$FIXTURE' (expected: ^[a-z][a-z0-9_-]*$)"
  exit 1
fi

FIXTURE_DIR="${REPO_ROOT}/packages/core/src/__tests__/fixtures/fresh-install/${FIXTURE}"
CLI="${REPO_ROOT}/packages/core/dist/cli.js"

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "FAIL: fixture directory $FIXTURE_DIR does not exist"
  exit 1
fi

case "$MODE" in
  local|published) ;;
  *) echo "FAIL: unknown mode '$MODE' (expected: local | published)"; exit 1 ;;
esac

if [ "$MODE" = "local" ] && [ ! -f "$CLI" ]; then
  echo "FAIL: $CLI missing — did you run npm run build in packages/core?"
  exit 1
fi

WORK=$(mktemp -d)
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT INT TERM

cp -R "${FIXTURE_DIR}/." "${WORK}/"
pushd "${WORK}" >/dev/null

if [ "$MODE" = "local" ]; then
  node "${CLI}" init --ci
else
  npx -y @massu/core@1 init --ci
fi

test -f massu.config.yaml

# Local mode runs the full invariant suite; published mode is a smoke test
# (skip schema_version + monorepo_roots assertions since they're verified in
# local mode for every fixture).
if [ "$MODE" = "local" ]; then
  grep -q '^schema_version: 2' massu.config.yaml
  # No placeholder strings must leak through.
  ! grep -qE 'TODO|FIXME|placeholder|PLACEHOLDER' massu.config.yaml

  # paths.source must exist on disk (bug fix: 2026-04-20).
  SRC=$(awk '/^paths:/{flag=1; next} flag && /^  source:/{print $2; exit}' massu.config.yaml)
  if [ "${SRC}" != "." ] && [ -n "${SRC}" ]; then
    test -d "${SRC}" || { echo "paths.source=${SRC} missing on disk"; exit 1; }
  fi

  # Fixture-specific invariant: monorepo shapes must emit monorepo_roots.
  case "${FIXTURE}" in
    multi-runtime|nx-monorepo|pnpm-workspaces|rush-monorepo)
      grep -q 'monorepo_roots:' massu.config.yaml \
        || { echo "expected paths.monorepo_roots for monorepo fixture"; exit 1; }
      ;;
  esac
fi

popd >/dev/null
echo "PASS: ci-fresh-install on $FIXTURE ($MODE)"

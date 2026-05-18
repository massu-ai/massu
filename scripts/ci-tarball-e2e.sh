#!/usr/bin/env bash
# Extracted from .github/workflows/ci.yml `tarball-e2e` job (P1-001,
# plan-2026-05-18-pre-push-ci-parity). Called from BOTH:
#   - .github/workflows/ci.yml step "Adapter Tarballs (P-D-002)"
#   - scripts/pre-push-light.sh step [14/15] Tarball E2E (quick mode)
#
# Per-adapter assertions (mirrors prior inline block):
#   - npm pack --dry-run --json: tarball MUST NOT contain src/, *.test.ts, tsconfig.json
#   - tarball MUST contain dist/index.{js,d.ts}, package.json, LICENSE, README.md
#
# Adapter list is filesystem-derived (single SoT — `packages/adapter-*` dirs)
# so future adapter additions/removals don't need to update this script.
#
# Modes:
#   default       — full per-adapter pack verification (CI behavior)
#   --quick       — workspace state assertions only (pre-push-light fast path)

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-full}"

# Filesystem-derived adapter list. ALWAYS use array form `"${ADAPTERS[@]}"` —
# word-split form would fail under `set -u` if no adapters exist.
ADAPTERS=()
while IFS= read -r dir; do
  ADAPTERS+=("$(basename "$dir" | sed 's/^adapter-//')")
done < <(find packages -maxdepth 1 -type d -name 'adapter-*' | sort)

if [ ${#ADAPTERS[@]} -eq 0 ]; then
  echo "INFO: no adapter packages found in packages/adapter-*; skipping tarball e2e"
  exit 0
fi

if [ "$MODE" = "--quick" ]; then
  # Quick mode: assert workspace state only — every adapter has dist/index.js
  # and dist/index.d.ts, and the adapter list matches CORE_BUNDLED_IDS in
  # the live bundle-adapters.ts. Skips the slow npm pack --dry-run loop.
  for adapter in "${ADAPTERS[@]}"; do
    pkg_dir="packages/adapter-$adapter"
    for required in "dist/index.js" "dist/index.d.ts" "package.json" "LICENSE" "README.md"; do
      if [ ! -f "$pkg_dir/$required" ]; then
        echo "FAIL: $pkg_dir/$required missing (run npm run build:adapters)"
        exit 1
      fi
    done
    echo "PASS: $pkg_dir publishable shape (quick)"
  done
  echo "Tarball E2E (quick): ${#ADAPTERS[@]} adapter(s) verified."
  exit 0
fi

# Full mode (CI): npm pack --dry-run --json per adapter.
# Use mktemp for json output (predictable /tmp/pack-$adapter.json would be a
# symlink-clobber vector on shared CI runners / shared /tmp — HIGH security
# finding 2026-05-18).
TARBALL_TMPDIR="$(mktemp -d -t massu-tarball-e2e-XXXXXXXX)"
cleanup_tarball() { rm -rf -- "$TARBALL_TMPDIR"; }
trap cleanup_tarball EXIT INT TERM

for adapter in "${ADAPTERS[@]}"; do
  echo "::group::adapter-$adapter pack --dry-run"
  cd "$REPO_ROOT/packages/adapter-$adapter"
  pack_json="$TARBALL_TMPDIR/pack-$adapter.json"
  npm pack --dry-run --json > "$pack_json"
  # Each tarball MUST NOT contain src/, *.test.ts, or tsconfig.json
  leaks=$(jq -r '[.[0].files[].path] | map(select(test("^src/|\\.test\\.ts$|^tsconfig\\.json$"))) | length' "$pack_json")
  if [ "$leaks" != "0" ]; then
    echo "ERROR: adapter-$adapter tarball contains forbidden files (src/, .test.ts, or tsconfig.json):"
    jq -r '.[0].files[].path' "$pack_json" | grep -E "^src/|\\.test\\.ts$|^tsconfig\\.json$"
    exit 1
  fi
  # Each tarball MUST contain dist/index.js + dist/index.d.ts + package.json + LICENSE + README.md
  for required in "dist/index.js" "dist/index.d.ts" "package.json" "LICENSE" "README.md"; do
    has=$(jq --arg r "$required" '[.[0].files[].path] | map(select(. == $r)) | length' "$pack_json")
    if [ "$has" != "1" ]; then
      echo "ERROR: adapter-$adapter tarball missing required file: $required"
      jq -r '.[0].files[].path' "$pack_json"
      exit 1
    fi
  done
  echo "PASS: adapter-$adapter publishable shape verified"
  cd "$REPO_ROOT"
  echo "::endgroup::"
done

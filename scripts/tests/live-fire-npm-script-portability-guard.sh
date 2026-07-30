#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# live-fire-npm-script-portability-guard.sh — CR-72 real-tree attack on the drift-guard
# packages/core/src/__tests__/npm-script-shell-portability-drift-guard.test.ts.
#
# A fixture-only mutation test is a regression test in disguise, and a regression test
# cannot find a false negative. So this plants the REAL defects into the REAL files and
# demands the REAL guard go RED — each for its OWN declared reason, not merely non-zero
# (a guard that fails for an unrelated reason is not proven).
#
# PLANTS
#   1. build:cli restored to its historical single-quoted, multi-line `--banner:js='…'`
#      — the exact string that failed CI run 30428800020 on windows-latest.
#   2. build-bundles.mjs given its own hardcoded externals array — the third-site drift
#      that bundle-adapters.ts used to carry.
#
# PAYLOAD SAFETY (G25/CR-88): every planted string is an esbuild flag or a JS array of
# package names. No shell metacharacter is combined with any destructive token, so if the
# guard under test were disabled these plants still DO NOTHING but sit in a file.
#
# Restoration is proven by sha256, not by `[ -e file ]` — existence is not restoration.
#
# Usage: bash scripts/tests/live-fire-npm-script-portability-guard.sh [--dry-run]
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "FATAL: unrecognised argument '$arg' (expected --dry-run)" >&2; exit 2 ;;
  esac
done

PKG="packages/core/package.json"
BUNDLES="packages/core/scripts/build-bundles.mjs"
GUARD="npm-script-shell-portability-drift-guard"

for f in "$PKG" "$BUNDLES"; do
  [ -r "$f" ] || { echo "FATAL: cannot read $f (M2)" >&2; exit 2; }
done

if [ "$DRY_RUN" = 1 ]; then
  echo "Would plant into: $PKG (single-quoted multi-line banner), $BUNDLES (hardcoded externals)."
  echo "Would run: npx vitest run $GUARD  (demanding RED for each plant, GREEN when clean)."
  echo "Would restore both files and verify byte-identical by sha256."
  exit 0
fi

PASSED=0; FAILED=0
ok()  { echo "  ${GREEN}OK${NC}   $1"; PASSED=$((PASSED + 1)); }
bad() { echo "  ${RED}FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

PKG_SHA0="$(sha "$PKG")"
BUNDLES_SHA0="$(sha "$BUNDLES")"
BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/portability-livefire.XXXXXX")" || exit 2
cp "$PKG" "$BACKUP/package.json"
cp "$BUNDLES" "$BACKUP/build-bundles.mjs"

restore() {
  cp "$BACKUP/package.json" "$PKG"
  cp "$BACKUP/build-bundles.mjs" "$BUNDLES"
}
cleanup() { restore; rm -rf "$BACKUP"; }
trap cleanup EXIT INT TERM

run_guard() {  # -> writes output to $1, returns vitest's exit status (NOT read through a pipe)
  local out="$1"
  ( cd "$REPO_ROOT/packages/core" && npx vitest run "$GUARD" ) > "$out" 2>&1
  return $?
}

echo "── live-fire: npm-script shell-portability drift-guard ──"

# ── NEGATIVE CONTROL FIRST: the guard must OPEN on a genuine pass. A brick gate gets
#    disabled, and "it refused" is meaningless if it refuses everything. ────────────────
run_guard "$BACKUP/clean.txt"; rc=$?
if [ "$rc" -eq 0 ]; then ok "NEGATIVE CONTROL: guard is GREEN on the clean tree (exit 0)"
else bad "NEGATIVE CONTROL: guard is RED on a clean tree (exit $rc) — it is a brick"; fi

# ── PLANT 1: the historical single-quoted, multi-line banner ─────────────────────────────
python3 - "$PKG" <<'PY'
import json, collections, sys
path = sys.argv[1]
p = json.load(open(path), object_pairs_hook=collections.OrderedDict)
p['scripts']['build:cli'] = (
    "esbuild --bundle --platform=node --format=esm --outfile=dist/cli.js src/cli.ts "
    "--external:yaml --banner:js='#!/usr/bin/env node\n"
    'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);\''
)
open(path, 'w').write(json.dumps(p, indent=2, ensure_ascii=False) + '\n')
PY
if [ "$(sha "$PKG")" = "$PKG_SHA0" ]; then
  bad "PLANT 1 did not modify $PKG — the plant is inert, nothing was proven"
else
  run_guard "$BACKUP/plant1.txt"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'single-quote' "$BACKUP/plant1.txt"; then
    ok "PLANT 1: guard went RED naming [single-quote] (exit $rc)"
  elif [ "$rc" -ne 0 ]; then
    bad "PLANT 1: guard went RED but never named [single-quote] — red for the wrong reason"
  else
    bad "PLANT 1: guard stayed GREEN on the exact defect that broke CI 30428800020"
  fi
fi
restore
if [ "$(sha "$PKG")" = "$PKG_SHA0" ]; then
  ok "RESTORE 1: $PKG byte-identical (sha256)"
else
  bad "RESTORE 1: $PKG differs from its pre-plant sha256"
fi

# ── PLANT 2: a second, hardcoded externals list ──────────────────────────────────────────
python3 - "$BUNDLES" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
needle = "    external: [...EXTERNALS],"
assert needle in s, "plant anchor not found — update the live-fire script"
s = s.replace(needle, "    external: ['better-sqlite3', 'yaml', 'zod'],", 1)
open(path, 'w').write(s)
PY
if [ "$(sha "$BUNDLES")" = "$BUNDLES_SHA0" ]; then
  bad "PLANT 2 did not modify $BUNDLES — the plant is inert, nothing was proven"
else
  run_guard "$BACKUP/plant2.txt"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'externals list' "$BACKUP/plant2.txt"; then
    ok "PLANT 2: guard went RED naming the duplicate externals list (exit $rc)"
  elif [ "$rc" -ne 0 ]; then
    bad "PLANT 2: guard went RED but never named the externals list — red for the wrong reason"
  else
    bad "PLANT 2: guard stayed GREEN on a second hardcoded externals list"
  fi
fi
restore
if [ "$(sha "$BUNDLES")" = "$BUNDLES_SHA0" ]; then
  ok "RESTORE 2: $BUNDLES byte-identical (sha256)"
else
  bad "RESTORE 2: $BUNDLES differs from its pre-plant sha256"
fi

echo
echo "  passed: $PASSED   failed: $FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "${RED}FAIL${NC}: the drift-guard is not proven. A gate that cannot fail is not a gate."
  exit 1
fi
echo "${GREEN}PASS${NC}: guard proven to fail on both real defects and to open on a clean tree."

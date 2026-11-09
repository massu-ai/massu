#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# live-fire-source-layout-guards.sh — attack the REAL guards in the REAL tree (CR-72).
#
# `plan-2026-08-13-index-builder-input-contracts` Q3+Q4 replaced ten compiled-in `src/`
# layout assumptions with one derived SoT (`packages/core/src/lib/source-layout.ts`) and a
# candidate-set contract. This plants each of those defects BACK INTO the real source files
# and demands the real vitest suite go RED **for that defect's own declared reason**. A RED
# for the wrong reason proves nothing about the check that was supposed to fire (G28/CR-91),
# and a mutation test that has never been mutated is a regression test in disguise — which
# cannot find a false negative.
#
# PROVE BEFORE YOU DESTROY: every touched file is snapshotted by sha256 into a scratch dir and
# restored from THAT COPY — never `git checkout --`, which reverts to the INDEX and would
# destroy uncommitted work in a file this script legitimately runs against while dirty.
# Each restore is ASSERTED byte-identical.
#
# ORACLE: every plant asserts the planted text is PRESENT and the original ABSENT before the
# suite runs. A plant that silently no-ops certifies the guard for free.
#
# PAYLOAD SAFETY (G25/CR-88): every plant is a text substitution inside a SQL predicate or a
# path check. No plant places a shell metacharacter next to a destructive token, and no
# fixture in the suites below deletes anything. If every guard here were disabled, nothing
# would be removed from disk.
#
# Usage: bash scripts/tests/live-fire-source-layout-guards.sh
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

CORE="packages/core"
SPECS=(
  "src/__tests__/source-layout-drift-guard.test.ts"
  "src/__tests__/index-builder-input-contracts.test.ts"
  "src/__tests__/source-layout.test.ts"
  "src/__tests__/page-deps.test.ts"
  "src/__tests__/index-rebuild-operation-count.test.ts"
)

# Files this run mutates. Snapshotted before anything else happens.
TARGETS=(
  "packages/core/src/import-resolver.ts"
  "packages/core/src/page-deps.ts"
  "packages/core/src/middleware-tree.ts"
  "packages/core/src/domains.ts"
  "packages/core/src/db.ts"
)

for f in "${TARGETS[@]}"; do
  [ -r "$f" ] || { echo "FATAL: cannot read $f (M2 — fail closed)" >&2; exit 2; }
done
for s in "${SPECS[@]}"; do
  [ -r "$CORE/$s" ] || { echo "FATAL: cannot read $CORE/$s (M2 — fail closed)" >&2; exit 2; }
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/source-layout-livefire.XXXXXX")" || exit 2

# Indexed arrays, not associative: macOS ships bash 3.2, where `declare -A` is a syntax
# error AND `set -u` on the resulting unbound reference aborts only the ENCLOSING LOOP —
# so the first draft of this script printed two errors and still exited 0. A live-fire
# harness that reports success after failing to run is the exact defect it exists to catch.
SHA_BEFORE=()
echo "── snapshotting ${#TARGETS[@]} target file(s) into $SCRATCH"
for f in "${TARGETS[@]}"; do
  cp "$f" "$SCRATCH/$(basename "$f")" || exit 2
  SHA_BEFORE+=("$(shasum -a 256 < "$f" | awk '{print $1}')")
  if git diff --quiet -- "$f" && git diff --cached --quiet -- "$f"; then :; else
    echo "   ${YELLOW}NOTE${NC}: $f has UNCOMMITTED changes. They are snapshotted at"
    echo "         $SCRATCH/$(basename "$f") and restored byte-for-byte. If this run is"
    echo "         killed, recover with 'cp $SCRATCH/$(basename "$f") $f' —"
    echo "         NOT 'git checkout --', which would discard them."
  fi
done
if [ "${#SHA_BEFORE[@]}" -ne "${#TARGETS[@]}" ]; then
  echo "${RED}FATAL${NC}: snapshotted ${#SHA_BEFORE[@]} of ${#TARGETS[@]} targets — refusing to plant" >&2
  exit 2
fi

restore_all() {
  local rc=0 i f now
  for i in "${!TARGETS[@]}"; do
    f="${TARGETS[$i]}"
    cp "$SCRATCH/$(basename "$f")" "$f"
    now="$(shasum -a 256 < "$f" | awk '{print $1}')"
    if [ "$now" != "${SHA_BEFORE[$i]}" ]; then
      echo "${RED}FATAL${NC}: restore of $f did NOT return it byte-identical." >&2
      echo "        expected ${SHA_BEFORE[$i]}" >&2
      echo "        actual   $now" >&2
      echo "        Recover with: cp $SCRATCH/$(basename "$f") $f" >&2
      rc=1
    fi
  done
  return $rc
}
trap 'restore_all || true' EXIT

# ── Plants. One row per defect the fix removed: file │ original │ planted │ reason regex ──
# The reason regex is matched against the vitest output and must name the check that fires,
# not merely "something failed".
PLANT_FILE=(); PLANT_FROM=(); PLANT_TO=(); PLANT_WHY=(); PLANT_REASON=(); PLANT_RUNNER=()

# $6 (optional) selects the checker: "vitest" (default) or "tsc". A property enforced by the
# TYPE SYSTEM cannot be proven by running tests — the core test tree is not type-checked, so a
# vitest run would stay green on a planted type error and certify a dead guard.
add_plant() {
  PLANT_FILE+=("$1"); PLANT_FROM+=("$2"); PLANT_TO+=("$3"); PLANT_WHY+=("$4"); PLANT_REASON+=("$5")
  PLANT_RUNNER+=("${6:-vitest}")
}

add_plant \
  "packages/core/src/import-resolver.ts" \
  "const filesPredicate = sourceFilePredicate();" \
  "const filesPredicate = { sql: \"path LIKE 'src/%'\", params: [] };" \
  "the original defect: a candidate set rooted at a compiled-in src/" \
  "sql-like-src-literal"

add_plant \
  "packages/core/src/import-resolver.ts" \
  "  assertSourceCandidateSet(codegraphDb, 'buildImportIndex');" \
  "  void assertSourceCandidateSet;" \
  "the Q3 contract removed — a violated input contract goes quiet again" \
  "a violated input contract is LOUD"

add_plant \
  "packages/core/src/page-deps.ts" \
  "    .replace(new RegExp(\`^\${prefix}\`), '')" \
  "    .replace(/^src\\/app/, '')" \
  "route derivation re-anchored on a compiled-in src/app" \
  "regex-anchored-on-src"

add_plant \
  "packages/core/src/middleware-tree.ts" \
  "isUnderSourceDir(imp.target_file)" \
  "imp.target_file.startsWith('src/')" \
  "the import-tree recursion guard drifts away from the query that fed it" \
  "startswith-src-literal"

add_plant \
  "packages/core/src/domains.ts" \
  "  const srcSource = sourceDirPredicate('source_file');" \
  "  const srcSource = { sql: 'source_file LIKE ?', params: [getConfig().paths.source + '/%'] };" \
  "one declared dir treated as the whole source set" \
  "paths-source-as-the-whole-set"

# Q4's acceptance is "a second identical dispatch performs NO rebuild, asserted by operation
# count". That claim is only worth as much as the gate behind it, so the gate gets planted too:
# with the staleness comparison forced to `true` the builders run on every dispatch again,
# which is precisely the shipped defect Q2 removed.
add_plant \
  "packages/core/src/db.ts" \
  "  return codegraphIndexedAtToEpochMs(latestIndexed.latest) > new Date(lastBuild.value).getTime();" \
  "  return true;" \
  "the staleness predicate answers true unconditionally again (the Q2 defect)" \
  "a repeat dispatch performs NO rebuild"

# A plant into a file that is NOT snapshotted would be LEFT IN THE TREE by the restore loop,
# because restore_all only walks TARGETS. That is a live weapon pointed at the working copy,
# and the author noticing is not a control — so the harness refuses to start instead.
for i in "${!PLANT_FILE[@]}"; do
  found=0
  for t in "${TARGETS[@]}"; do
    [ "$t" = "${PLANT_FILE[$i]}" ] && { found=1; break; }
  done
  if [ "$found" -ne 1 ]; then
    echo "${RED}FATAL${NC}: plant $((i + 1)) targets ${PLANT_FILE[$i]}, which is not in TARGETS." >&2
    echo "        It would be planted and never restored. Add it to TARGETS." >&2
    exit 2
  fi
done

apply_plant() {
  # Text substitution via python so the payload is never re-interpreted by a shell.
  PLANT_TARGET="$1" PLANT_SRC="$2" PLANT_DST="$3" python3 - <<'PY'
import os, sys
path, src, dst = os.environ['PLANT_TARGET'], os.environ['PLANT_SRC'], os.environ['PLANT_DST']
s = open(path).read()
if s.count(src) != 1:
    print(f"ORACLE-FAIL: expected exactly 1 occurrence of the original in {path}, found {s.count(src)}", file=sys.stderr)
    sys.exit(3)
open(path, 'w').write(s.replace(src, dst, 1))
PY
}

# ORACLE — the plant must actually be in the file, and the original must be gone.
assert_planted() {
  PLANT_TARGET="$1" PLANT_SRC="$2" PLANT_DST="$3" python3 - <<'PY'
import os, sys
path, src, dst = os.environ['PLANT_TARGET'], os.environ['PLANT_SRC'], os.environ['PLANT_DST']
s = open(path).read()
if dst not in s:
    print(f"ORACLE-FAIL: planted text absent from {path} — the plant no-opped", file=sys.stderr)
    sys.exit(3)
if src in s:
    print(f"ORACLE-FAIL: original text still present in {path} — the plant did not displace it", file=sys.stderr)
    sys.exit(3)
PY
}

run_suite() {
  local log="$1"
  ( cd "$REPO_ROOT/$CORE" && npx vitest run "${SPECS[@]}" ) > "$log" 2>&1
  echo $?
}

run_tsc() {
  local log="$1"
  ( cd "$REPO_ROOT/$CORE" && npx tsc --noEmit ) > "$log" 2>&1
  echo $?
}

run_checker() {
  case "$2" in
    tsc) run_tsc "$1" ;;
    *)   run_suite "$1" ;;
  esac
}

PASS=0; FAIL=0

# ── GENUINE GREEN control, first. A gate that refuses everything is a brick, and a brick
# ── gets bypassed. Establish that the unplanted tree PASSES before reading any RED as signal.
echo
echo "── [control] unplanted tree must PASS"
GREEN_LOG="$SCRATCH/control.log"
GREEN_EXIT="$(run_suite "$GREEN_LOG")"
GREEN_TSC_LOG="$SCRATCH/control-tsc.log"
GREEN_TSC_EXIT="$(run_tsc "$GREEN_TSC_LOG")"
if [ "$GREEN_TSC_EXIT" -ne 0 ]; then
  echo "   ${RED}FAIL${NC}: tsc is ALREADY red on the unplanted tree (exit $GREEN_TSC_EXIT)."
  echo "         A type-error plant's RED would be unattributable. See $GREEN_TSC_LOG"
  tail -20 "$GREEN_TSC_LOG" >&2
  exit 1
fi
if [ "$GREEN_EXIT" -eq 0 ]; then
  echo "   ${GREEN}PASS${NC}: exit 0 on the unplanted tree — the suite is not a brick"
  PASS=$((PASS + 1))
else
  echo "   ${RED}FAIL${NC}: unplanted tree exits $GREEN_EXIT. Every RED below would be"
  echo "         unattributable, so the run stops here. See $GREEN_LOG"
  tail -30 "$GREEN_LOG" >&2
  exit 1
fi

for i in "${!PLANT_FILE[@]}"; do
  f="${PLANT_FILE[$i]}"
  echo
  echo "── [plant $((i + 1))/${#PLANT_FILE[@]}] $f — ${PLANT_WHY[$i]}"

  if ! apply_plant "$f" "${PLANT_FROM[$i]}" "${PLANT_TO[$i]}"; then
    echo "   ${RED}FAIL${NC}: could not apply the plant (see ORACLE-FAIL above)"
    FAIL=$((FAIL + 1)); restore_all || exit 2; continue
  fi
  if ! assert_planted "$f" "${PLANT_FROM[$i]}" "${PLANT_TO[$i]}"; then
    echo "   ${RED}FAIL${NC}: plant oracle refused — a silent no-op would certify the guard for free"
    FAIL=$((FAIL + 1)); restore_all || exit 2; continue
  fi

  LOG="$SCRATCH/plant-$((i + 1)).log"
  EXIT="$(run_checker "$LOG" "${PLANT_RUNNER[$i]}")"

  if [ "$EXIT" -eq 0 ]; then
    echo "   ${RED}FAIL${NC}: suite stayed GREEN with the defect planted — the guard is DEAD"
    FAIL=$((FAIL + 1))
  elif grep -qF "${PLANT_REASON[$i]}" "$LOG"; then
    echo "   ${GREEN}PASS${NC}: RED (exit $EXIT) naming its own reason — \"${PLANT_REASON[$i]}\""
    PASS=$((PASS + 1))
  else
    echo "   ${RED}FAIL${NC}: RED (exit $EXIT) but WITHOUT \"${PLANT_REASON[$i]}\" —"
    echo "         a red for the wrong reason proves nothing about the intended check."
    grep -E "^ (FAIL|✓|×)" "$LOG" | head -10 >&2
    FAIL=$((FAIL + 1))
  fi

  restore_all || exit 2
done

echo
if ! restore_all; then
  echo "${RED}FATAL${NC}: final restore failed. Files are in $SCRATCH" >&2
  exit 2
fi
echo "── restore verified byte-identical for ${#TARGETS[@]} file(s):"
for i in "${!TARGETS[@]}"; do
  echo "   ${SHA_BEFORE[$i]}  ${TARGETS[$i]}"
done

echo
echo "RESULT: passed=$PASS failed=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "${RED}LIVE-FIRE FAILED${NC}"
  exit 1
fi
echo "${GREEN}LIVE-FIRE PASSED${NC} — every planted defect drove the suite RED for its own reason"
exit 0

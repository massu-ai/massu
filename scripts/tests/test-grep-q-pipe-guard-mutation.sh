#!/usr/bin/env bash
# scripts/tests/test-grep-q-pipe-guard-mutation.sh
#
# CR-72 / M4 real-tree mutation proof for the gate-script grep-q pipeline drift-guard
# (packages/core/src/__tests__/gate-script-grep-q-pipeline-drift-guard.test.ts).
#
# The guard exists to catch the broken-pipe-false-verdict class: `<streaming-command> | grep -q`
# under `set -o pipefail` (incident 2026-07-16, pattern-scanner Check 26 red on CI for weeks).
# A guard nobody attacked is a brick that emits the same silence as a working one. So we PLANT
# the exact defect it exists to catch — IN THE REAL TREE (a fixture-only mutation test is a
# regression test in disguise, and a regression test cannot find a false negative) — run the
# REAL guard, and demand:
#
#   1. CLEAN         — on the untouched tree the guard is GREEN (proves it OPENS; a brick that
#                      always-fails would fail here too).
#   2. DANGER → RED  — plant `git log | grep -q X` into the real scanner → guard exits NON-ZERO.
#   3. SAFE → GREEN  — plant `echo "$x" | grep -q X` (the allowed builtin form) → guard STAYS
#                      GREEN (proves the guard is specific, not a blanket `| grep -q` ban that
#                      would force needless churn on safe echo/printf sites).
#
# Every plant is restored (content AND mtime — a restored-content-but-not-mtime trips the
# workspace-build-freshness gate) in a `trap … EXIT`, and `git status --porcelain` for the
# touched file is asserted EMPTY at the START and the END (a SIGKILL will not fire the trap, so
# a start assertion is the only way to tell "my plant leaked" from "the tree was already dirty").
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SCANNER="scripts/massu-pattern-scanner.sh"
GUARD_RUN=(npx vitest run gate-script-grep-q-pipeline-drift-guard)

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'
PASS=0; FAIL=0
_ok()  { printf '  %sOK%s   %s\n' "$GREEN" "$NC" "$1"; PASS=$((PASS + 1)); }
_bad() { printf '  %sFAIL%s %s\n' "$RED"   "$NC" "$1"; FAIL=$((FAIL + 1)); }

porcelain() { git status --porcelain -- "$SCANNER" 2>/dev/null; }

# ── The tree MUST be clean before we plant. A leaked plant from a prior SIGKILL is otherwise
#    indistinguishable from a real bug (CR-72 start-assert). ──
if [ -n "$(porcelain)" ]; then
  echo "${RED}FATAL${NC}: $SCANNER already dirty before the test — refusing to run:" >&2
  porcelain >&2
  exit 2
fi

# Save exact bytes + mtime for restore (CR-70: never `git checkout` — that would discard the
# parent session's uncommitted work; restore from a private copy instead).
SAVE="$(mktemp)"
cp -p "$SCANNER" "$SAVE"
restore() {
  cp "$SAVE" "$SCANNER"
  touch -r "$SAVE" "$SCANNER"   # restore mtime so the freshness gate is not tripped
  rm -f "$SAVE"
}
trap restore EXIT

run_guard() { ( cd "$REPO_ROOT/packages/core" && "${GUARD_RUN[@]}" ) >/dev/null 2>&1; }

# 1. CLEAN → GREEN (the guard must OPEN on a genuine pass).
if run_guard; then _ok "CLEAN: guard is GREEN on the untouched tree (it opens)."; else _bad "CLEAN: guard FAILED on a clean tree — it is a brick or the tree is dirty."; fi

# 2. DANGER → RED. Plant a streaming-command producer piped into grep -q.
printf '\nif git log --oneline 2>/dev/null | grep -q "PLANTED_MUTATION_MARKER"; then :; fi\n' >> "$SCANNER"
if run_guard; then _bad "DANGER: guard stayed GREEN on a planted \`git … | grep -q\` — IT IS DEAD."; else _ok "DANGER: guard went RED on the planted streaming-command pipe. This is a gate."; fi
cp "$SAVE" "$SCANNER"; touch -r "$SAVE" "$SCANNER"   # restore before the next plant

# 3. SAFE → GREEN. The allowed echo/printf builtin form must NOT be flagged.
printf '\nif echo "$SOME_VAR" | grep -q "PLANTED_SAFE_MARKER"; then :; fi\n' >> "$SCANNER"
if run_guard; then _ok "SAFE: guard stayed GREEN on \`echo … | grep -q\` (specific, not a blanket ban)."; else _bad "SAFE: guard flagged \`echo … | grep -q\` — it over-fires and would force needless churn."; fi
cp "$SAVE" "$SCANNER"; touch -r "$SAVE" "$SCANNER"

# ── End-assert the tree is clean (the plant did not leak). ──
if [ -n "$(porcelain)" ]; then
  echo "${RED}FATAL${NC}: $SCANNER left dirty after the test — a plant leaked:" >&2
  porcelain >&2
  FAIL=$((FAIL + 1))
fi

echo "─────────────────────────────────────────────"
printf 'grep-q pipe guard mutation: %s%d passed%s, %s%d failed%s\n' "$GREEN" "$PASS" "$NC" "$RED" "$FAIL" "$NC"
[ "$FAIL" -eq 0 ] || exit 1
echo "${GREEN}PASS${NC}: the grep-q pipe drift-guard is a real gate — RED on danger, GREEN on safe + clean."

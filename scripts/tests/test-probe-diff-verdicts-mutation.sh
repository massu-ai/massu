#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# CR-72 mutation proof for scripts/lib/probe-diff-verdicts.py.
#
# WHY THIS EXISTS. 58bddfa9 fixed a real class: a probe that INDUCES a FATAL truncates its
# own sweep, and the first draft marked every gate downstream of the abort as REQUIRED — one
# real requirement becoming hundreds of fabricated ones, looking like a rich successful
# measurement. The fix landed with NOTHING that goes red if it regresses. This is that thing.
#
# The logic was extracted out of a shell heredoc specifically so it could be fed FIXTURES.
# A rule that cannot be fed a fixture cannot be proven to fire.
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'
DIFF="$REPO_ROOT/scripts/lib/probe-diff-verdicts.py"
[ -r "$DIFF" ] || { echo "${RED}FATAL${NC}: missing $DIFF" >&2; exit 2; }

T="$(mktemp -d "${TMPDIR:-/tmp}/probe-diff-mutation.XXXXXX")" || exit 2
trap 'rm -rf "$T"' EXIT INT TERM

PASS=0; FAIL=0
check() { # $1 label, $2 expected-substring/int, $3 actual
  printf '  %-56s ' "$1"
  if [ "$2" = "$3" ]; then echo "${GREEN}OK${NC} ($3)"; PASS=$((PASS+1));
  else echo "${RED}FAIL${NC} expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi
}

# A 10-gate baseline, all OK.
: > "$T/base.tsv"
for i in $(seq 1 10); do printf 'gate-%02d\tOK\n' "$i" >> "$T/base.tsv"; done

echo "── 1. IDENTICAL run: no candidates, and no fabricated requirements ──"
cp "$T/base.tsv" "$T/same.tsv"
out="$(python3 "$DIFF" "$T/base.tsv" "$T/same.tsv" "$T/c1.tsv" 2>&1)"; rc=$?
check "exit 0" 0 "$rc"
check "candidate rows" 0 "$(grep -c '' "$T/c1.tsv" 2>/dev/null || true)"

echo
echo "── 2. ONE genuine flip: exactly one candidate, not eleven ──"
sed 's/^gate-04\tOK$/gate-04\tFAIL/' "$T/base.tsv" > "$T/flip.tsv"
python3 "$DIFF" "$T/base.tsv" "$T/flip.tsv" "$T/c2.tsv" >/dev/null 2>&1
check "candidate rows" 1 "$(grep -c '' "$T/c2.tsv" 2>/dev/null || true)"
check "names the flipped gate" "gate-04" "$(cut -f1 "$T/c2.tsv")"

echo
echo "── 3. TRUNCATION — the defect 58bddfa9 fixed. Sweep aborts after gate-02. ──"
head -2 "$T/base.tsv" > "$T/trunc.tsv"
out="$(python3 "$DIFF" "$T/base.tsv" "$T/trunc.tsv" "$T/c3.tsv" 2>&1)"; rc=$?
check "exit 0 (reports, does not crash)" 0 "$rc"
check "vanished counted SEPARATELY from flipped" \
      "1" "$(printf '%s' "$out" | grep -c 'flipped 0 + vanished 8' || true)"
check "TRUNCATION SUSPECTED announced" \
      "1" "$(printf '%s' "$out" | grep -c 'TRUNCATION SUSPECTED' || true)"
# The load-bearing property: they are CANDIDATES, marked __VANISHED__, never adjudicated.
check "all 8 marked __VANISHED__ (not a verdict)" \
      "8" "$(cut -f3 "$T/c3.tsv" | grep -c '__VANISHED__' || true)"
check "zero rows claim a real withdrawn verdict" \
      "0" "$(cut -f3 "$T/c3.tsv" | grep -cE '^(OK|FAIL)$' || true)"

echo
echo "── 4. FAIL CLOSED on unreadable / empty input (M2) ──"
# Test the exit code DIRECTLY. Reading $? inside a later command substitution is fragile:
# it depends on argument-expansion order and silently reports 0 the moment anything else runs
# in between — a self-inflicted blind gate in the test that hunts blind gates (SC2181).
if python3 "$DIFF" "$T/nope.tsv" "$T/base.tsv" "$T/c4.tsv" >/dev/null 2>&1; then
  check "missing baseline -> non-zero" 1 0
else
  check "missing baseline -> non-zero" 1 1
fi
: > "$T/empty.tsv"
if python3 "$DIFF" "$T/empty.tsv" "$T/base.tsv" "$T/c5.tsv" >/dev/null 2>&1; then
  check "empty baseline -> non-zero (scanned 0 is not a pass)" 1 0
else
  check "empty baseline -> non-zero (scanned 0 is not a pass)" 1 1
fi

echo
echo "── 5. NEGATIVE CONTROL — prove the fixtures can actually make it fail ──"
# Without this, "it refused" and "it never ran" look identical (G7 aimed at the test itself).
python3 - "$T" <<'PY'
import subprocess, sys
t = sys.argv[1]
# Feed a withdrawn map that FLIPS every gate; a working differ must emit 10 candidates.
open(f"{t}/allflip.tsv", "w").write("".join(f"gate-{i:02d}\tFAIL\n" for i in range(1, 11)))
subprocess.run([sys.executable, "scripts/lib/probe-diff-verdicts.py",
                f"{t}/base.tsv", f"{t}/allflip.tsv", f"{t}/c6.tsv"],
               capture_output=True, check=True)
n = sum(1 for _ in open(f"{t}/c6.tsv"))
print(n)
PY
n6="$(python3 -c "print(sum(1 for _ in open('$T/c6.tsv')))" 2>/dev/null || echo 0)"
check "all-flip fixture yields 10 candidates" 10 "$n6"

echo
echo "═════════════════════════════════════════════════════════════"
echo "  checks passed : $PASS"
echo "  checks FAILED : $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "${RED}FAIL${NC}: the truncation-refusal is not proven. A fix with nothing that goes"
  echo "      red when it regresses is a fix that will regress unnoticed."
  exit 1
fi
echo "${GREEN}PASS${NC}: truncation is reported as truncation, flips as flips, and neither is"
echo "      silently adjudicated."
exit 0

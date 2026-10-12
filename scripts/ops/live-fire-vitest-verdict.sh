#!/usr/bin/env bash
# CR-72 attacker for scripts/lib/vitest-verdict.sh.
#
# ⛔ WHY THIS HARNESS IS NOT OPTIONAL. Four attackers now route their did-it-run verdict through
# that one library. A defect in it breaks all four QUIETLY — a `vv_ran` that always returns true
# turns every DID-NOT-RUN into a pass, and a `vv_ran` that always returns false turns every real
# RED into "proves nothing", which is precisely the brick that put a REQUIRED check red for ten
# consecutive CI runs. Concentration is the price of consolidation, and the attacker is the
# receipt.
#
# THE CASE THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT IS THE ANSI ONE. Every hand-rolled
# predicate this library replaces passed on a developer's plain output and failed on CI's
# coloured output, so a fixture set without colour in it proves nothing about CI.
#
# ⛔ NO `rm -rf` AND NO INTERPOLATED DELETE PATH (G17). The scratch dir is mktemp'd and removed
# by a trap on a path this script created.
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO/scripts/lib/vitest-verdict.sh"
[ -r "$LIB" ] || { echo "FATAL: cannot read $LIB" >&2; exit 2; }
# shellcheck source-path=SCRIPTDIR/../lib source=vitest-verdict.sh
. "$LIB"

SCRATCH="$(mktemp -d)" || exit 2
trap 'rm -rf "$SCRATCH"' EXIT INT TERM

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

# ANSI-coloured exactly as vitest emits it in CI (measured from run 35984272403).
ansi_tests_failed() {
  printf '\033[2m      Tests \033[22m \033[1m\033[31m1 failed\033[39m\033[22m\033[2m | \033[22m\033[1m\033[32m11 passed\033[39m\033[22m\033[90m (12)\033[39m\n'
}
ansi_files_passed() {
  printf '\033[2m Test Files \033[22m \033[1m\033[32m1 passed\033[39m\033[22m\033[90m (1)\033[39m\n'
}

# ── verdict cases: <label> <fixture-writer> <raw-status> <expected-verdict> ────────────────
drive() {
  local label="$1" writer="$2" raw="$3" want="$4"
  local f got
  f="$SCRATCH/$label.log"
  : > "$f"
  "$writer" >> "$f"
  vv_classify "$f" "$raw"; got=$?
  if [ "$got" = "$want" ]; then ok "$label -> $got"; else bad "$label -> $got (wanted $want)"; fi
}

w_plain_pass()   { printf ' Test Files  1 passed (1)\n      Tests  12 passed (12)\n'; }
w_plain_fail()   { printf ' Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)\n'; }
w_ansi_pass()    { ansi_files_passed; }
w_ansi_fail()    { ansi_tests_failed; }
w_empty()        { :; }
w_startup_error(){ printf 'Error: Cannot find module vitest\n    at Module._resolveFilename\n'; }
w_prose_only()   { printf 'No test files found, exiting with code 1\n'; }

echo "=== 1. the three verdicts, on PLAIN output (what a laptop emits) ==="
drive plain-pass  w_plain_pass  0 0
drive plain-fail  w_plain_fail  1 1

echo
echo "=== 2. THE CASE THAT WAS MISSING: the SAME runs, ANSI-coloured (what CI emits) ==="
drive ansi-pass   w_ansi_pass   0 0
drive ansi-fail   w_ansi_fail   1 1

echo
echo "=== 3. genuinely DID-NOT-RUN must still be 2, or the fix has traded one blindness for another ==="
drive empty         w_empty         1 2
drive startup-error w_startup_error 1 2
drive prose-only    w_prose_only    1 2

echo
echo "=== 4. the counts and the human summary survive colour ==="
F="$SCRATCH/ansi-fail.log"
[ "$(vv_count "$F" 'Tests')" = "1" ] \
  && ok "vv_count Tests reads 1 through the colour codes" \
  || bad "vv_count Tests read '$(vv_count "$F" 'Tests')' (wanted 1)"
F2="$SCRATCH/ansi-pass.log"
[ "$(vv_count "$F2" 'Test Files')" = "1" ] \
  && ok "vv_count 'Test Files' reads 1 through the colour codes" \
  || bad "vv_count 'Test Files' read '$(vv_count "$F2" 'Test Files')' (wanted 1)"
case "$(vv_summary "$F")" in
  *'Tests 1 failed'*) ok "vv_summary is ANSI-free and readable" ;;
  *) bad "vv_summary returned '$(vv_summary "$F")'" ;;
esac

echo
echo "=== 5. M2 — an unreadable log is an ERROR (2), never a silent 'never ran' ==="
vv_ran "$SCRATCH/does-not-exist.log" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "vv_ran on a missing file returns 2 (error), not 1" \
                || bad "vv_ran on a missing file returned $rc (wanted 2)"
vv_count "$SCRATCH/does-not-exist.log" 'Tests' >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "vv_count on a missing file returns 2" \
                || bad "vv_count on a missing file returned $rc (wanted 2)"

echo
echo "=== 6. MUTATION — break vv_ran in a COPY and demand the ANSI case flips ==="
# A copy, because a library the whole repo sources must never be mutated in place (CR-70).
cp "$LIB" "$SCRATCH/mutant.sh" || exit 2
# python, not sed: the line to mutate CONTAINS a `|` (the `(Test Files|Tests)` alternation), and
# a `|`-delimited sed expression silently matches nothing against it. The first draft of this
# case did exactly that and reported "could not plant" — which is the right refusal, and is why
# a mutation must be VERIFIED to have landed rather than assumed (CR-72).
python3 - "$SCRATCH/mutant.sh" <<'MUTPY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
needle = "  grep -qE '^ *(Test Files|Tests) +[0-9]' <<<\"$plain\"\n"
assert s.count(needle) == 1, 'mutation anchor found %d times' % s.count(needle)
io.open(p, 'w', encoding='utf-8').write(s.replace(needle, '  false\n'))
MUTPY
if /usr/bin/grep -qE '^  false$' "$SCRATCH/mutant.sh"; then
  ( set +u; . "$SCRATCH/mutant.sh"; vv_classify "$SCRATCH/ansi-fail.log" 1 ) >/dev/null 2>&1
  mrc=$?
  [ "$mrc" -eq 2 ] && ok "with vv_ran forced false, a real RED is misread as DID-NOT-RUN (the original bug, reproduced)" \
                   || bad "mutant returned $mrc; the mutation did not change the verdict"
  # AND THE OPPOSITE MUTATION: vv_ran forced TRUE must turn a genuine never-ran into a verdict,
  # because that is the other way this library can go quietly wrong for all four callers.
  cp "$LIB" "$SCRATCH/mutant2.sh" || exit 2
  python3 - "$SCRATCH/mutant2.sh" <<'MUTPY2'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
needle = "  grep -qE '^ *(Test Files|Tests) +[0-9]' <<<\"$plain\"\n"
assert s.count(needle) == 1
io.open(p, 'w', encoding='utf-8').write(s.replace(needle, '  true\n'))
MUTPY2
  ( set +u; . "$SCRATCH/mutant2.sh"; vv_classify "$SCRATCH/empty.log" 1 ) >/dev/null 2>&1
  m2rc=$?
  [ "$m2rc" -eq 1 ] && ok "with vv_ran forced true, a suite that never ran is misread as a real FAIL (the other blindness)" \
                    || bad "mutant2 returned $m2rc (wanted 1)"
else
  bad "could not plant the vv_ran mutation — this case proves nothing (not a passing gate)"
fi

echo
printf 'passed: %s   failed: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
[ "$pass" -eq 14 ] || { printf 'M1: expected 13 cases, ran %s — refusing to report a pass\n' "$pass" >&2; exit 2; }
echo "ALL 14 CASES PASS — the verdict survives colour, still catches a suite that never ran, and goes wrong when broken."

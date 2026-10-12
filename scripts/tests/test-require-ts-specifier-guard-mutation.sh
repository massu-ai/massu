#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# CR-72 live-fire for the require()-of-a-TypeScript-specifier drift-guard.
#
# Plants the REAL defect in the REAL tree, runs the REAL guard, demands RED for
# its own declared reason, restores from the BYTES IT SAW (never from the index —
# `git checkout --` reverts to the INDEX, which is not necessarily what was on
# disk), and asserts the tree came back byte-identical by sha256.
#
# Also proves the gate OPENS on a genuine pass: a permanently-red gate gets
# deleted, and a gate that cannot go green is indistinguishable from a broken one.
set -euo pipefail

# G29: this script builds no sandbox repo and is reachable from the pre-push
# battery, so it ASSERTS the repository rather than scrubbing git's environment.
# A blanket scrub is the documented disarm for hook-reachable scripts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXPECTED_GIT_DIR="$REPO_ROOT/.git"
ACTUAL_GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"
if [ "$ACTUAL_GIT_DIR" != "$EXPECTED_GIT_DIR" ]; then
  echo "FATAL: git resolves to '$ACTUAL_GIT_DIR', expected '$EXPECTED_GIT_DIR'." >&2
  echo "       GIT_DIR is leaking from the caller; refusing to run." >&2
  exit 1
fi

GUARD='packages/core/src/__tests__/require-ts-specifier-drift-guard.test.ts'
VICTIM='packages/core/src/__tests__/hooks-stdout-convention.test.ts'
VICTIM_ABS="$REPO_ROOT/$VICTIM"

fail=0
note() { printf '  %s\n' "$*"; }
check() {
  local label="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s\n' "$label"
    fail=1
  fi
}

[ -f "$VICTIM_ABS" ] || { echo "FATAL: plant target missing: $VICTIM" >&2; exit 1; }

BEFORE_SHA="$(shasum -a 256 "$VICTIM_ABS" | awk '{print $1}')"
BACKUP="$(mktemp -t require-ts-guard-mutation-XXXXXX)"
cp "$VICTIM_ABS" "$BACKUP"

restore() {
  # Restore from the bytes this script actually SAW, under a trap, so an
  # interrupt cannot leave the plant in the working tree.
  cp "$BACKUP" "$VICTIM_ABS"
  rm -f "$BACKUP"
}
trap restore EXIT INT TERM

# ⛔ THE SUBJECT'S PATH WAS DECLARED IN $GUARD AND THE RUNNER SELECTED A SUBSTRING.
# `vitest run require-ts-specifier-drift-guard` is a NAME FILTER: a correlate of "the guard
# under attack", not the guard itself (G28 -- a scope predicate must BE the property). It can
# widen silently if another test file ever contains that string, and then a failure anywhere
# in the widened set reads as "the guard went RED" (memory
# a-startup-error-scored-as-a-red-gate). $GUARD was assigned and read nowhere, so the
# authoritative path was in hand and something else was consulted.
[ -f "$REPO_ROOT/$GUARD" ] || { echo "FATAL: subject missing: $GUARD" >&2; exit 1; }
GUARD_REL="${GUARD#packages/core/}"
# shellcheck source-path=SCRIPTDIR/../lib source=vitest-verdict.sh
. "$REPO_ROOT/scripts/lib/vitest-verdict.sh"

# How many test FILES a run judged. Neither a path nor a substring guarantees "exactly the
# subject", so every run below asserts this instead of trusting the selector.
# Via scripts/lib/vitest-verdict.sh: the sed that used to be here was ANSI-blind, so in CI it
# returned EMPTY and these "judged exactly the subject" assertions would all have failed on a
# run that judged exactly the subject. Added this session and never seen under colour.
subject_files() { vv_count "$1" 'Test Files'; }

run_guard() {
  # vv_run forces colour OFF and returns the three-valued verdict; this harness only needs the
  # raw pass/fail, so the verdict is echoed for the caller exactly as before. 2 (DID-NOT-RUN) is
  # deliberately distinguishable from 1 here — a suite that never started is not a RED gate.
  #
  # The capture is REACHABLE today only because every caller is a `$(run_guard …)` command
  # substitution, and bash does not inherit errexit into substitutions (no `inherit_errexit` in
  # bash 3.2 — the shell this runs under). That is the owning cross-repo plan
  # 2026-09-25-set-e-status-capture-is-dead-code.md [CLAIM-6], verdict CONFIRMED, whose
  # disposition is "the site is rewritten or declared". REWRITTEN here rather than declared: an
  # explicit `|| rc=$?` is correct under every errexit state, so a future direct (non-substituted)
  # call cannot silently turn this into dead code.
  local rc=0
  vv_run "$REPO_ROOT/packages/core" "$1" "$GUARD_REL" || rc=$?
  echo "$rc"
}

echo '== 1/4  baseline must be GREEN (a permanently-red gate gets deleted) =='
BASE_LOG="$(mktemp -t require-ts-guard-base-XXXXXX)"
BASE_RC="$(run_guard "$BASE_LOG")"
check "baseline exits 0 (rc=$BASE_RC)" "$([ "$BASE_RC" = "0" ] && echo 1 || echo 0)"
[ "$BASE_RC" = "0" ] || sed -n '1,40p' "$BASE_LOG"
check "the baseline run judged EXACTLY the subject, 1 test file (files=$(subject_files "$BASE_LOG"))" "$([ "$(subject_files "$BASE_LOG")" = "1" ] && echo 1 || echo 0)"

echo '== 2/4  plant the REAL defect and demand RED =='
# The exact shape that broke CI on 2026-08-09/10.
printf '\n// AV-PLANT (live-fire, removed by trap)\nconst __plant = require(%s../hooks/lib/write-hook-message.ts%s);\nvoid __plant;\n' "'" "'" \
  >> "$VICTIM_ABS"
PLANT_SHA="$(shasum -a 256 "$VICTIM_ABS" | awk '{print $1}')"
check "the plant actually changed the file (negative control)" \
  "$([ "$PLANT_SHA" != "$BEFORE_SHA" ] && echo 1 || echo 0)"

PLANT_LOG="$(mktemp -t require-ts-guard-plant-XXXXXX)"
PLANT_RC="$(run_guard "$PLANT_LOG")"
check "planted tree exits NON-ZERO (rc=$PLANT_RC)" \
  "$([ "$PLANT_RC" != "0" ] && echo 1 || echo 0)"
check "the planted run judged EXACTLY the subject, 1 test file (files=$(subject_files "$PLANT_LOG"))" "$([ "$(subject_files "$PLANT_LOG")" = "1" ] && echo 1 || echo 0)"

echo '== 3/4  RED for its OWN declared reason, not some incidental error =='
# "It went red" is not enough — a syntax error, a missing module, or an unrelated
# assertion would also be red. Pin the guard's own message and the planted path.
if grep -q 'runtime require() of a TypeScript specifier' "$PLANT_LOG"; then
  check 'failure message names the defect class' 1
else
  check 'failure message names the defect class' 0
  note "guard output did not contain the expected message; tail follows:"
  sed -n '1,40p' "$PLANT_LOG"
fi
if grep -q "$VICTIM" "$PLANT_LOG"; then
  check 'failure message names the planted FILE' 1
else
  check 'failure message names the planted FILE' 0
fi
# The denominator assertion must NOT be what failed — that would mean the sweep
# broke rather than the rule firing.
if grep -q 'reads every tracked source file' "$PLANT_LOG" \
   && grep -qE '× .*reads every tracked source file' "$PLANT_LOG"; then
  check 'the denominator check did NOT fail (the RULE fired, not the sweep)' 0
else
  check 'the denominator check did NOT fail (the RULE fired, not the sweep)' 1
fi

echo '== 4/4  restore, and prove the tree is byte-identical =='
restore
trap - EXIT INT TERM
AFTER_SHA="$(shasum -a 256 "$VICTIM_ABS" | awk '{print $1}')"
check "restored sha256 == original ($BEFORE_SHA)" \
  "$([ "$AFTER_SHA" = "$BEFORE_SHA" ] && echo 1 || echo 0)"

RESTORED_LOG="$(mktemp -t require-ts-guard-restored-XXXXXX)"
RESTORED_RC="$(run_guard "$RESTORED_LOG")"
check "guard GREEN again after restore (rc=$RESTORED_RC)" \
  "$([ "$RESTORED_RC" = "0" ] && echo 1 || echo 0)"
check "the restored run judged EXACTLY the subject, 1 test file (files=$(subject_files "$RESTORED_LOG"))" "$([ "$(subject_files "$RESTORED_LOG")" = "1" ] && echo 1 || echo 0)"

rm -f "$BASE_LOG" "$PLANT_LOG" "$RESTORED_LOG"

if [ "$fail" = "0" ]; then
  echo 'RESULT: PASS — the guard can FAIL on the real defect and OPENS on a clean tree.'
  exit 0
fi
echo 'RESULT: FAIL'
exit 1

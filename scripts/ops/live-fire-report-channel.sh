#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, run the REAL suites, demand RED for
# each declared reason, restore, prove byte-identical, prove they OPEN again.
#
# SUBJECT: the test-reporting channel — `src/__tests__/helpers/report.ts` and the drift guard
# `src/__tests__/no-console-log-in-tests.test.ts`.
#
# THE DEFECT, measured 2026-09-21 on the real vitest config, one file, three channels:
#
#     console.log('PROBE_CONSOLE_LOG')        -> ABSENT from the run output
#     process.stdout.write('PROBE_STDOUT\n')  -> present
#     process.stderr.write('PROBE_STDERR\n')  -> present
#
# Seven sites across five files reported denominators through the absent one, each carrying a
# comment saying it printed so a reviewer could read it. Five more announced that a test was
# SKIPPING ITSELF and then passed — a test that gives up into an invisible channel is
# indistinguishable from one that ran and found nothing.
#
# ⛔ WHY THIS PARTICULAR ATTACK IS THE ONLY ONE THAT PROVES ANYTHING. "The line was printed"
# and "the line was swallowed" differ ONLY in the captured output of a real run. No assertion
# inside the suite can tell them apart — the swallowing happens above the test. So the proof
# is: see the line, plant `console.log` in its place, watch the line DISAPPEAR.
#
# ⛔ NO `rm -rf`, NO INTERPOLATED DELETE PATH (G17); cleanup lives in a FUNCTION, not inside a
# `trap '...'` string, because this machine's payload-safety guard refuses a shell
# metacharacter beside a destructive token inside one literal (G25/CR-88).
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

CALIB="packages/core/src/__tests__/rule-candidate-detector-calibration.test.ts"
GUARDF="packages/core/src/__tests__/no-console-log-in-tests.test.ts"
CALIB_T="src/__tests__/rule-candidate-detector-calibration.test.ts"
GUARD_T="src/__tests__/no-console-log-in-tests.test.ts"
for f in "$CALIB" "$GUARDF"; do
  [ -f "$f" ] || { echo "FATAL: $f not found" >&2; exit 2; }
done

CALIB_SHA="$(shasum -a 256 "$CALIB" | cut -d' ' -f1)"
GUARD_SHA="$(shasum -a 256 "$GUARDF" | cut -d' ' -f1)"
BK_CALIB="$(mktemp)" || exit 2
BK_GUARD="$(mktemp)" || exit 2
cp "$CALIB" "$BK_CALIB" || exit 2
cp "$GUARDF" "$BK_GUARD" || exit 2
restore_all() {
  cp "$BK_CALIB" "$CALIB" 2>/dev/null
  cp "$BK_GUARD" "$GUARDF" 2>/dev/null
}
cleanup() {
  restore_all
  rm -f "$BK_CALIB"
  rm -f "$BK_GUARD"
}
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -12; FAIL=$((FAIL+1)); }
run()       { OUT="$(cd packages/core && npx vitest run "$CALIB_T" 2>&1)"; RC=$?; }
run_guard() { OUT="$(cd packages/core && npx vitest run "$GUARD_T" 2>&1)"; RC=$?; }

echo "=== 0. BASELINE — the reported line is VISIBLE in the captured run output ==="
run
if [ "$RC" -eq 0 ]; then ok "calibration suite green"; else bad "RED before any plant" "$OUT"; exit 1; fi
BEFORE_HITS="$(printf '%s' "$OUT" | grep -c '\[calibration\] positives=')"
if [ "$BEFORE_HITS" -ge 1 ]; then ok "the denominator surfaces ($BEFORE_HITS line(s) captured)"
else bad "the reported line is NOT in the output — report() does not work" "$OUT"; exit 1; fi

echo "=== 1. PLANT: report() -> console.log. The line must VANISH while the test still passes ==="
# THE central proof. A swallowed report does not fail anything — that is the entire defect.
python3 - "$CALIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = "      report(`[calibration] positives="
new = "      console.log(`[calibration] positives="
assert old in s, 'plant-1 anchor missing'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('  planted: the report goes back through console.log')
PY
[ $? -eq 0 ] || exit 1
run
AFTER_HITS="$(printf '%s' "$OUT" | grep -c '\[calibration\] positives=')"
if [ "$AFTER_HITS" -eq 0 ] && [ "$RC" -eq 0 ]; then
  ok "console.log is SWALLOWED — $BEFORE_HITS line(s) became 0, and the suite still exits 0"
else
  bad "could not reproduce the swallow (hits=$AFTER_HITS rc=$RC) — the premise is wrong" "$OUT"
fi

echo "=== 2. and the DRIFT GUARD must catch that same plant ==="
# Step 1 proves the channel is silent. This proves the silence cannot be introduced quietly.
run_guard
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q 'rule-candidate-detector-calibration'; then
  ok "the guard goes RED and NAMES the offending file"
else
  bad "a real console.log slipped past the guard (rc=$RC)" "$OUT"
fi
restore_all

echo "=== 3. PLANT: the guard's exemption predicate reads a COMMENT ==="
# The self-masking shape, and the defect this guard actually shipped with for one iteration:
# a file that MENTIONS `vi.spyOn(console, 'log')` in prose must NOT become exempt.
python3 - "$CALIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = "      report(`[calibration] positives="
new = "      // mentions vi.spyOn(console, 'log') in prose only\n      console.log(`[calibration] positives="
assert old in s, 'plant-3 anchor missing'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('  planted: a console.log beside a PROSE mention of the exemption predicate')
PY
[ $? -eq 0 ] || exit 1
run_guard
if [ "$RC" -ne 0 ]; then
  ok "a prose mention does NOT buy an exemption — still RED"
else
  bad "the guard exempted a file on a COMMENT — it is self-maskable (rc=$RC)" "$OUT"
fi
restore_all

echo "=== 4. NEGATIVE CONTROL: a console.log inside a STRING is not a call ==="
# A gate that reads prose as code is one people learn to ignore (CR-83). Prove it stays quiet.
python3 - "$CALIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = "      report(`[calibration] positives="
new = "      const __fixture = 'console.log(1);';\n      void __fixture;\n      report(`[calibration] positives="
assert old in s, 'plant-4 anchor missing'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('  planted: console.log as test DATA inside a string literal')
PY
[ $? -eq 0 ] || exit 1
run_guard
if [ "$RC" -eq 0 ]; then
  ok "a string literal stays SILENT — the guard does not cry wolf"
else
  bad "the guard flagged a string literal — it reads prose as code" "$OUT"
fi
restore_all

echo "=== 5. RESTORE — byte-identical, and both suites OPEN again ==="
A="$(shasum -a 256 "$CALIB" | cut -d' ' -f1)"
B="$(shasum -a 256 "$GUARDF" | cut -d' ' -f1)"
if [ "$CALIB_SHA" = "$A" ] && [ "$GUARD_SHA" = "$B" ]; then ok "both files restored byte-identical"
else bad "RESTORE FAILED (calib $CALIB_SHA -> $A; guard $GUARD_SHA -> $B)"; fi
run
if [ "$RC" -eq 0 ]; then ok "calibration suite OPENS"; else bad "still RED after restore" "$OUT"; fi
FINAL_HITS="$(printf '%s' "$OUT" | grep -c '\[calibration\] positives=')"
if [ "$FINAL_HITS" = "$BEFORE_HITS" ]; then ok "the denominator is visible again ($FINAL_HITS)"
else bad "report line count changed ($BEFORE_HITS -> $FINAL_HITS)"; fi
run_guard
if [ "$RC" -eq 0 ]; then ok "drift guard OPENS"; else bad "guard still RED after restore" "$OUT"; fi

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

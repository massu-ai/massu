#!/usr/bin/env bash
set -uo pipefail
#
# CR-72 attacker for scripts/lib/assert.sh.
#
# WHY THIS SHIPS BEFORE ANY CALL SITE IS CONVERTED. The library is about to become the assertion
# contract for ~32 harness and gate scripts. A defect in it breaks all of them AT ONCE and does so
# QUIETLY: a `check` that always reports ok is a suite that always passes, and every one of those
# files exits 0. Concentration risk is the real risk here, so the library is attacked first and the
# conversion happens after.
#
# It does three things a fixture-only test cannot:
#   1. asserts each entry point in BOTH directions (a regression test cannot find a false negative);
#   2. asserts the two REFUSAL paths — no command to run, and zero assertions — because those are
#      the blind-gate cases where "could not check" must not collapse into "passed";
#   3. MUTATES THE REAL FILE with defects that would make it report a false PASS, demands the probe
#      misbehave, then restores it and proves the bytes are unchanged by sha256.
#
# It also PROBES a claim the library's own comment makes rather than trusting it: that the
# here-string in check_rc_contains survives an output larger than the pipe buffer.
#
# NOTE ON THE CLEANUP SHAPE: the EXIT trap names a FUNCTION and the function body puts each command
# on its own line. An earlier draft used `trap 'restore; rm -f "$BACKUP"' EXIT`, which the G25
# payload-safety gate refused at write time — a shell metacharacter beside a destructive token
# inside one literal is the shape that executed `rm -rf ~` on this machine on 2026-07-24/25 when a
# plant enabled a shell. The gate was right; this is the structural form, not an exemption.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/assert.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$2" | sed 's/^/       /' | tail -12
  fi
}

[ -r "$LIB" ] || { printf 'FATAL: cannot read %s\n' "$LIB" >&2; exit 2; }
BASE_SHA="$(shasum -a 256 "$LIB" | cut -d' ' -f1)"
BACKUP="$(mktemp)"
: "${BACKUP:?mktemp produced an empty path}"
cp "$LIB" "$BACKUP" || { printf 'FATAL: backup failed\n' >&2; exit 2; }

restore() {
  cp "$BACKUP" "$LIB"
}
_cleanup() {
  restore
  rm -f "$BACKUP"
}
trap _cleanup EXIT

echo "=============================================================="
echo "  live-fire: scripts/lib/assert.sh"
echo "=============================================================="
echo "  baseline sha256: ${BASE_SHA:0:16}"

# probe <body> — run a body with the library sourced, in a child shell; emits stdout+stderr.
probe() {
  bash -c "set -uo pipefail; . '$LIB'; $1" 2>&1
}
# probe_rc <body> — the child's exit status, output discarded.
probe_rc() {
  bash -c "set -uo pipefail; . '$LIB'; $1" >/dev/null 2>&1
  printf '%s' "$?"
}

# ── 1. BOTH DIRECTIONS ON EVERY ENTRY POINT ───────────────────────────────────────────────────
echo
echo "-- 1: each entry point, both directions --"

OUT="$(probe 'check_cmd "true passes" true; assert_summary q')"
if grep -q 'true passes' <<<"$OUT" && grep -q '1 passed, 0 failed' <<<"$OUT"; then
  pass "check reports PASS on a succeeding command"
else fail "check on a succeeding command" "$OUT"; fi

OUT="$(probe 'check_cmd "false fails" false; assert_summary q')"
if grep -q '0 passed, 1 failed' <<<"$OUT"; then
  pass "check reports FAIL on a failing command"
else fail "check on a failing command" "$OUT"; fi

OUT="$(probe 'check_cmd "arg form" test -n "nonempty"; assert_summary q')"
if grep -q '1 passed, 0 failed' <<<"$OUT"; then
  pass "check passes the assertion as ARGV (the contract that kills SC2319)"
else fail "check argv form" "$OUT"; fi

OUT="$(probe 'check_not "false is refused" false; assert_summary q')"
if grep -q '1 passed, 0 failed' <<<"$OUT"; then
  pass "check_not reports PASS when the command fails"
else fail "check_not on a failing command" "$OUT"; fi

OUT="$(probe 'check_not "true is caught" true; assert_summary q')"
if grep -q '0 passed, 1 failed' <<<"$OUT"; then
  pass "check_not reports FAIL when the command succeeds"
else fail "check_not on a succeeding command" "$OUT"; fi

OUT="$(probe 'check_eq "eq" 7 7; assert_summary q')"
if grep -q 'eq (7)' <<<"$OUT" && grep -q '1 passed, 0 failed' <<<"$OUT"; then
  pass "check_eq reports PASS and echoes the value"
else fail "check_eq equal" "$OUT"; fi

OUT="$(probe 'check_eq "ne" 7 9; assert_summary q')"
if grep -q 'expected \[7\] got \[9\]' <<<"$OUT" && grep -q '0 passed, 1 failed' <<<"$OUT"; then
  pass "check_eq reports FAIL and PRINTS BOTH VALUES"
else fail "check_eq unequal must print both values" "$OUT"; fi

OUT="$(probe 'check_rc_contains "rc+needle" 0 hello 0 "say hello there"; assert_summary q')"
if grep -q '1 passed, 0 failed' <<<"$OUT"; then
  pass "check_rc_contains passes when rc AND needle match"
else fail "check_rc_contains both match" "$OUT"; fi

OUT="$(probe 'check_rc_contains "wrong needle" 0 absent 0 "say hello there"; assert_summary q')"
if grep -q '0 passed, 1 failed' <<<"$OUT"; then
  pass "check_rc_contains FAILS on right rc but missing needle"
else fail "check_rc_contains needle miss" "$OUT"; fi

OUT="$(probe 'check_rc_contains "wrong rc" 0 hello 3 "say hello there"; assert_summary q')"
if grep -q '0 passed, 1 failed' <<<"$OUT"; then
  pass "check_rc_contains FAILS on right needle but wrong rc"
else fail "check_rc_contains rc miss" "$OUT"; fi

# ── 2. THE REFUSAL PATHS — where a blind gate would report success ─────────────────────────────
echo
echo "-- 2: refusal paths (the blind-gate cases) --"

OUT="$(probe 'check_cmd "nothing to run"; assert_summary q' || true)"
if grep -q 'ERROR' <<<"$OUT" && ! grep -q '0 failed' <<<"$OUT"; then
  pass "check with NO command is an ERROR, never a pass"
else fail "check with no command must not report ok" "$OUT"; fi

RC="$(probe_rc 'check_cmd "nothing to run"')"
if [ "$RC" != "0" ]; then
  pass "check with NO command returns non-zero (rc=$RC)"
else fail "check with no command returned 0"; fi

OUT="$(probe 'assert_summary "empty suite"' || true)"
if grep -q 'ZERO assertions' <<<"$OUT"; then
  pass "assert_summary refuses a suite that asserted NOTHING"
else fail "assert_summary on zero assertions" "$OUT"; fi

RC="$(probe_rc 'assert_summary "empty suite"')"
if [ "$RC" = "2" ]; then
  pass "assert_summary exits 2 on zero assertions (distinct from 1 = a real failure)"
else fail "assert_summary zero-assertion exit code" "got rc=$RC, wanted 2"; fi

RC="$(probe_rc 'check_cmd "a" true; check_cmd "b" false; assert_summary q')"
if [ "$RC" = "1" ]; then
  pass "assert_summary exits 1 when an assertion failed"
else fail "assert_summary failure exit code" "got rc=$RC, wanted 1"; fi

RC="$(probe_rc 'check_cmd "a" true; assert_summary q')"
if [ "$RC" = "0" ]; then
  pass "assert_summary exits 0 when every assertion passed (it OPENS)"
else fail "assert_summary all-pass exit code" "got rc=$RC, wanted 0"; fi

OUT="$(probe 'check_eq "short" 1; assert_summary q' || true)"
if grep -q 'ERROR' <<<"$OUT"; then
  pass "check_eq with too few arguments is an ERROR"
else fail "check_eq arity" "$OUT"; fi

OUT="$(probe 'check_rc_contains "short" 0 x; assert_summary q' || true)"
if grep -q 'ERROR' <<<"$OUT"; then
  pass "check_rc_contains with too few arguments is an ERROR"
else fail "check_rc_contains arity" "$OUT"; fi

# ── 2b. THE LEGACY NAME IS POISONED, AND IT MUST NOT EXECUTE ITS ARGUMENT ─────────────────────
echo
echo "-- 2b: the legacy \`check\` name refuses, and never runs the marshalled value --"
# THE PROBE IS BOUNDED ON PURPOSE. If the poison were broken, `check "d" yes` would execute
# `yes` and emit output forever — that is exactly the failure this case exists to catch, and it
# already burned 5GB once. `head -c` closes the pipe, so a regression costs a SIGPIPE, not a disk.
OUT="$(probe 'check "legacy marshalled call" yes' 2>&1 | head -c 4000)"
if grep -q 'LEGACY assertion contract' <<<"$OUT" && grep -q 'check_cmd' <<<"$OUT"; then
  pass "legacy \`check\` errors and names the migration target"
else fail "legacy check did not refuse" "$OUT"; fi

BYTES="$(probe 'check "legacy marshalled call" yes' 2>&1 | head -c 200000 | wc -c | tr -d ' ')"
if [ "$BYTES" -lt 2000 ]; then
  pass "legacy \`check\` did NOT execute \`yes\` (output $BYTES bytes, bounded read)"
else fail "legacy check EXECUTED its argument" "output was $BYTES bytes — the poison is not working"; fi

RC="$(probe_rc 'check "legacy" yes')"
if [ "$RC" != "0" ]; then
  pass "legacy \`check\` returns non-zero (rc=$RC)"
else fail "legacy check returned 0"; fi

# ── 3. PROBE THE LIBRARY'S OWN CLAIM ABOUT THE PIPE BUFFER ────────────────────────────────────
echo
echo "-- 3: probe the here-string claim (not trust the comment) --"
# The library asserts a here-string avoids the SIGPIPE false-negative that `printf … | grep -qF`
# suffers past the ~64KB pipe buffer. 200KB of output, needle at the very END so an early exit
# cannot short-circuit it.
OUT="$(probe 'BIG="$(head -c 200000 /dev/zero | tr "\0" "x")"; BIG="$BIG NEEDLE_AT_END";
             check_rc_contains "big body" 0 NEEDLE_AT_END 0 "$BIG"; assert_summary q')"
if grep -q '1 passed, 0 failed' <<<"$OUT"; then
  pass "check_rc_contains survives a 200KB body (the here-string claim HOLDS)"
else fail "200KB body — the pipe-buffer claim does NOT hold" "$OUT"; fi

# ── 4. MUTATE THE REAL FILE ───────────────────────────────────────────────────────────────────
echo
echo "-- 4: plant defects in the REAL library; each must be caught --"

mutate() {  # mutate <old> <new> ; edits $LIB in place, refuses a non-unique anchor
  python3 - "$LIB" "$1" "$2" <<'PY'
import io, sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
n = s.count(old)
if n != 1:
    sys.stderr.write('PLANT-NOT-UNIQUE count=%d\n' % n)
    sys.exit(3)
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
}

# M1 — check always reports ok. The catastrophic one: 32 suites would pass forever.
M1_OLD='  if "$@"; then
    assert_ok "$desc"
    return 0
  fi
  assert_bad "$desc"
  return 1'
M1_NEW='  assert_ok "$desc"
  return 0'
if mutate "$M1_OLD" "$M1_NEW"; then
  OUT="$(probe 'check_cmd "false fails" false; assert_summary q')"
  if grep -q '0 passed, 1 failed' <<<"$OUT"; then
    fail "MUTATION check-always-ok was NOT caught — the attacker is blind" "$OUT"
  else
    pass "MUTATION check-always-ok -> a failing command reported as PASS (caught)"
  fi
  restore
else
  fail "could not plant M1 (anchor not unique)"
fi

# M2 — assert_summary accepts zero assertions. Reinstates the vacuous pass this library removes.
if mutate '  if [ "$total" -eq 0 ]; then' '  if false; then'; then
  RC="$(probe_rc 'assert_summary "empty suite"')"
  if [ "$RC" = "2" ]; then
    fail "MUTATION zero-assertion-allowed was NOT caught" "rc still 2"
  else
    pass "MUTATION zero-assertion-allowed -> empty suite now exits $RC (caught)"
  fi
  restore
else
  fail "could not plant M2 (anchor not unique)"
fi

# M3 — check with no command reports ok instead of erroring.
M3_OLD='  if [ "$#" -lt 2 ]; then
    # M2: an assertion with nothing to run is an ERROR. Reporting ok here is precisely the
    # blind-gate failure — "could not check" and "checked and it passed" must never be one value.
    ASSERT_FAIL=$((ASSERT_FAIL + 1))'
M3_NEW='  if [ "$#" -lt 2 ]; then
    assert_ok "$desc"
    return 0'
if mutate "$M3_OLD" "$M3_NEW"; then
  OUT="$(probe 'check_cmd "nothing to run"; assert_summary q' || true)"
  if grep -q '1 passed, 0 failed' <<<"$OUT"; then
    pass "MUTATION no-command-reports-ok -> caught"
  else
    fail "MUTATION no-command-reports-ok was NOT caught" "$OUT"
  fi
  restore
else
  fail "could not plant M3 (anchor not unique)"
fi

# ── 5. RESTORE IS BYTE-IDENTICAL ──────────────────────────────────────────────────────────────
echo
echo "-- 5: the tree is unchanged --"
FINAL_SHA="$(shasum -a 256 "$LIB" | cut -d' ' -f1)"
if [ "$FINAL_SHA" = "$BASE_SHA" ]; then
  pass "assert.sh restored byte-identically (${FINAL_SHA:0:16})"
else
  fail "assert.sh DIFFERS after restore" "$BASE_SHA -> $FINAL_SHA; original kept at $BACKUP"
fi

# ── 6. AND IT STILL OPENS ─────────────────────────────────────────────────────────────────────
RC="$(probe_rc 'check_cmd "a" true; check_cmd "b" test -n x; check_eq "c" 1 1; assert_summary q')"
if [ "$RC" = "0" ]; then
  pass "the restored library still OPENS on a genuine pass (a brick gets disabled)"
else
  fail "restored library does not open" "rc=$RC"
fi

echo
echo "=============================================================="
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]

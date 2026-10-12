#!/usr/bin/env bash
# shellcheck shell=bash
#
# ONE assertion contract for this repo's shell harnesses.
#
# ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
# Measured 2026-09-24 across `git ls-files '*.sh'`: 32 files defined at least one of ok/bad/check,
# with 37 DISTINCT definitions among the three names and 7 different counter variable names
# (PASS/PASSED/pass/FAIL/FAILED/fail/fails) across ~150 increment sites. Eight of the eleven
# `check()` definitions were semantically identical and differed only in HOW THE CALLER MARSHALS A
# BOOLEAN — five took an exit status (`[ "$2" -eq 0 ]`), three took the string `yes`.
#
# That marshalling is the defect. It forces the caller to write
#
#     [ -n "$TGZ" ]
#     check "npm pack produced a tarball" $?
#
# and `$?` after a CONDITION is SC2319 — it refers to the condition, not to any command, so a
# refactor that inserts one line between them silently inverts the assertion. shellcheck flags 28
# such sites; a further 51 pass `$?` after a real command, which is the identical shape and which
# the linter does not flag. Fixing what the tool reports would leave two thirds of the class alive.
#
# ── THE CONTRACT: THE HELPER TAKES THE ASSERTION, NOT ITS STATUS ───────────────────────────────
#
#     check "npm pack produced a tarball"  test -n "$TGZ"
#     check "extraction has NO .git"       test ! -e "$PKG/.git"
#     check "the guard names what it scanned"  grep -q 'scanned' "$OUT_FILE"
#
# `$?` never transits a call site, so SC2319 becomes structurally IMPOSSIBLE in this family rather
# than fixed 28 times. A new harness gets the property by sourcing this file.
#
# ── THE LIBRARY OWNS THE COUNTERS ──────────────────────────────────────────────────────────────
# Deliberately namespaced `ASSERT_PASS`/`ASSERT_FAIL` so they cannot collide with any of the seven
# names already in use while files are being converted one at a time. A converted file stops
# declaring counters and calls `assert_summary` instead of hand-rolling the tally.
#
# ── IT REFUSES TO REPORT A VACUOUS PASS ────────────────────────────────────────────────────────
# `assert_summary` with ZERO assertions is an ERROR, not a pass (M1: a harness that asserted
# nothing has not verified anything, and today those exit 0). `check` with no command to run is an
# ERROR, not a pass (M2: an unrunnable assertion must never substitute to success).
#
# Attacked by scripts/ops/live-fire-assert-lib.sh — it plants defects that would make this report a
# false PASS and demands each one is caught. A `check` that always reports ok is a suite that always
# passes, and 32 files would inherit that at once.

# Colour only when stdout is a terminal, so captured output stays byte-comparable in fixtures.
if [ -t 1 ]; then
  _A_GREEN=$'\033[0;32m'; _A_RED=$'\033[0;31m'; _A_NC=$'\033[0m'
else
  _A_GREEN=''; _A_RED=''; _A_NC=''
fi

ASSERT_PASS=0
ASSERT_FAIL=0

# assert_ok <description>
assert_ok() {
  ASSERT_PASS=$((ASSERT_PASS + 1))
  printf '  %s✓%s %s\n' "$_A_GREEN" "$_A_NC" "${1:-<no description>}"
}

# assert_bad <description> [captured-output-to-quote]
# The optional second argument is indented and tail-trimmed, which is the one genuinely useful
# behaviour among the fifteen bad() variants: three of them dumped output at tail -12, two at -10,
# two at -8. Standardised on 12 — the largest, because a truncated diagnostic is the reason someone
# re-runs the harness by hand.
assert_bad() {
  ASSERT_FAIL=$((ASSERT_FAIL + 1))
  printf '  %s✗%s %s\n' "$_A_RED" "$_A_NC" "${1:-<no description>}"
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$2" | sed 's/^/      /' | tail -12
  fi
}

# check_cmd <description> <command> [args...]
# Runs the command and inspects ITS OWN status. No status ever transits the call site.
#
# ⛔ NAMED `check_cmd`, NOT `check`, AND THAT IS LOAD-BEARING — measured 2026-09-24.
# The legacy contract was also spelled `check` and took a MARSHALLED VALUE
# (`check "desc" $?` or `check "desc" "$(... && echo yes || echo no)"`). If both contracts
# share one name, a PARTIALLY converted file hands the legacy string to a function that
# RUNS ITS ARGUMENT — and `yes` is a real program. A half-converted harness produced 5GB of
# `y` in about two minutes before it was killed. Arity cannot tell the contracts apart
# (`check_cmd "d" true` is a legitimate one-argument call), so the only structural remedy is
# a distinct name plus the poisoned `check` defined at the bottom of this file.
check_cmd() {
  local desc="${1:-}"
  if [ "$#" -lt 2 ]; then
    # M2: an assertion with nothing to run is an ERROR. Reporting ok here is precisely the
    # blind-gate failure — "could not check" and "checked and it passed" must never be one value.
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    printf '  %sERROR%s check_cmd called with no command to run: %s\n' \
      "$_A_RED" "$_A_NC" "${desc:-<no description>}" >&2
    return 2
  fi
  shift
  if "$@"; then
    assert_ok "$desc"
    return 0
  fi
  assert_bad "$desc"
  return 1
}

# check_not <description> <command> [args...]   — the command MUST fail
check_not() {
  local desc="${1:-}"
  if [ "$#" -lt 2 ]; then
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    printf '  %sERROR%s check_not called with no command to run: %s\n' \
      "$_A_RED" "$_A_NC" "${desc:-<no description>}" >&2
    return 2
  fi
  shift
  if "$@"; then
    assert_bad "$desc"
    return 1
  fi
  assert_ok "$desc"
  return 0
}

# check_eq <description> <expected> <actual>
# Replaces the one variant that compares two values and PRINTS them. Keeping that is deliberate:
# an equality assertion whose failure does not show the actual value makes the operator re-run the
# harness to learn anything, which is why that variant existed.
check_eq() {
  if [ "$#" -lt 3 ]; then
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    printf '  %sERROR%s check_eq needs <desc> <expected> <actual>: %s\n' \
      "$_A_RED" "$_A_NC" "${1:-<no description>}" >&2
    return 2
  fi
  if [ "$2" = "$3" ]; then
    assert_ok "$1 ($3)"
    return 0
  fi
  assert_bad "$1" "expected [$2] got [$3]"
  return 1
}

# check_rc_contains <description> <want-rc> <needle> <actual-rc> <captured-output>
# Replaces the variant that read $RC and $OUT from the ENCLOSING SCOPE. They are arguments here:
# a helper reading its caller's locals is invisible coupling, and it is why that variant could not
# be shared. A HERE-STRING, never `printf … | grep -qF` — under `pipefail` a body past the pipe
# buffer makes printf take SIGPIPE when grep exits early and the pipeline returns 141, a
# size-dependent false negative in the assertion itself.
check_rc_contains() {
  if [ "$#" -lt 5 ]; then
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    printf '  %sERROR%s check_rc_contains needs <desc> <want-rc> <needle> <rc> <output>: %s\n' \
      "$_A_RED" "$_A_NC" "${1:-<no description>}" >&2
    return 2
  fi
  local desc="$1" want="$2" needle="$3" rc="$4" out="$5"
  if [ "$rc" -eq "$want" ] && grep -qF -- "$needle" <<<"$out"; then
    assert_ok "$desc"
    return 0
  fi
  assert_bad "$desc" "$(printf 'wanted rc=%s containing: %s\ngot rc=%s:\n%s' \
    "$want" "$needle" "$rc" "$out")"
  return 1
}

# ⛔ THE LEGACY NAME IS POISONED ON PURPOSE.
# A file that sources this library but still carries an un-migrated `check "desc" $?` or
# `check "desc" "$(… echo yes …)"` call MUST fail loudly and immediately. Without this, the
# new contract would EXECUTE the legacy argument: `yes` is a real program, and one
# half-converted harness emitted 5GB of `y` in ~2 minutes. On this machine a disk-space
# CRITICAL is not a theoretical hazard (G8), so the failure is made impossible rather than
# merely detectable (G21 / Rule 25).
#
# An UNCONVERTED file is unaffected: it never sources this library. A file that deliberately
# keeps its own local `check` is also unaffected, because its definition comes after the
# source and overrides this one.
check() {
  printf '%sERROR%s `check` is the LEGACY assertion contract and is intentionally disabled.\n' \
    "$_A_RED" "$_A_NC" >&2
  printf '       This file sources scripts/lib/assert.sh, so it must use the contract that\n' >&2
  printf '       takes the ASSERTION rather than a marshalled status:\n' >&2
  printf '         check_cmd "<description>" <command> [args...]\n' >&2
  printf '         check_not "<description>" <command> [args...]\n' >&2
  printf '         check_eq  "<description>" <expected> <actual>\n' >&2
  printf '       Offending call described as: %s\n' "${1:-<no description>}" >&2
  ASSERT_FAIL=$((ASSERT_FAIL + 1))
  return 2
}

# assert_summary [label]
# Prints the tally and returns 0 only if at least one assertion ran AND none failed.
# ZERO assertions is an ERROR: a harness that asserted nothing has verified nothing, and every
# hand-rolled tally this replaces exited 0 in that state.
assert_summary() {
  local label="${1:-assertions}"
  local total=$((ASSERT_PASS + ASSERT_FAIL))
  if [ "$total" -eq 0 ]; then
    printf '%sERROR%s %s: ZERO assertions ran — nothing was verified, which is not a pass.\n' \
      "$_A_RED" "$_A_NC" "$label" >&2
    return 2
  fi
  printf '%s: %d passed, %d failed (of %d)\n' "$label" "$ASSERT_PASS" "$ASSERT_FAIL" "$total"
  [ "$ASSERT_FAIL" -eq 0 ]
}

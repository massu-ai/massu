#!/usr/bin/env bash
# scripts/lib/vitest-verdict.sh — ONE place that runs a vitest suite and says what happened.
#
# ⛔ WHY THIS EXISTS. Four harnesses each hand-rolled the same predicate over captured vitest
# output, and all four were ANSI-BLIND:
#
#   scripts/tests/test_verification_laws_guard_goes_red.sh      grep -qE '^ *(Test Files|Tests) +[0-9]'
#   scripts/ops/live-fire-ruleset-parity-blindness.sh           grep -qE '^ *Tests +[0-9]'      (x3)
#   scripts/tests/test-require-ts-specifier-guard-mutation.sh   sed -nE 's/^ *Test Files +([0-9]+)…'
#   scripts/ops/live-fire-stack-fixtures.sh                     the literal "Test Files  1 passed"
#
# vitest COLOURS its summary in CI, so the bytes are
#   \e[2m      Tests \e[22m\e[1m\e[31m1 failed\e[39m…
# and every one of those patterns fails to match — while matching perfectly on a developer's
# machine, where the same command emits no colour. MEASURED 2026-09-24: plain -> MATCHED,
# ANSI -> NO MATCH, ANSI-stripped -> MATCHED.
#
# The consequence was not a near miss. `test_verification_laws_guard_goes_red.sh` reported
# "the suite NEVER RAN — this attack proves nothing" for ten attacks that had each run and
# reddened EXACTLY as intended (`Tests 1 failed | 11 passed (12)` appears in the CI log
# immediately above each of those lines), so a REQUIRED check was a BRICK for ten consecutive
# CI runs and the pull request sat BLOCKED on it. A brick gets bypassed (CR-72), and the
# harness could not certify anything while it was one.
#
# ⛔ THE FIX IS DETERMINISM AT THE SOURCE, not a better regex. `vv_run` forces colour OFF, so
# the captured bytes are identical on a laptop and in CI; the ANSI strip in `vv_classify` is
# defence in depth for output this library did not produce. A regex that must cope with
# whatever the environment decided to emit is a bug waiting for a different environment.
#
# THREE-VALUED, and that is the whole point: PASSED / FAILED / DID-NOT-RUN.
#   0 = the suite ran and passed     1 = the suite ran and FAILED its assertions
#   2 = the suite NEVER RAN (startup error, no test files, missing runner)
# "I could not measure" and "the gate is dead" must never be one value.
#
# Sourced, never executed: `# shellcheck source=lib/vitest-verdict.sh`
# shellcheck shell=bash

# vv_strip_ansi <file> — the file's text with SGR/CSI sequences removed, on stdout.
# M2: an unreadable file is an ERROR, never an empty stream that later reads as "never ran".
vv_strip_ansi() {
  local f="${1:?vv_strip_ansi: no file given}"
  [ -r "$f" ] || { echo "vv_strip_ansi: cannot read $f" >&2; return 2; }
  LC_ALL=C /usr/bin/sed -E $'s/\033\\[[0-9;]*[A-Za-z]//g' "$f"
}

# vv_ran <file> — 0 if vitest printed a summary (so it EXECUTED), 1 if it printed none.
# The discriminator is vitest's own `Test Files` / `Tests` summary, which it emits whenever it
# ran and omits on a startup failure.
vv_ran() {
  local f="${1:?vv_ran: no file given}" plain
  plain="$(vv_strip_ansi "$f")" || return 2
  # A HERE-STRING, not `printf … | grep -q`: under `pipefail` a body larger than the pipe
  # buffer makes printf take SIGPIPE when grep exits early, and the pipeline returns 141 —
  # a size-dependent false negative in exactly the check that must never be wrong.
  grep -qE '^ *(Test Files|Tests) +[0-9]' <<<"$plain"
}

# vv_count <file> <Test Files|Tests> — the first number on that summary line, or empty.
vv_count() {
  local f="${1:?vv_count: no file given}" which="${2:?vv_count: no summary name given}" plain
  plain="$(vv_strip_ansi "$f")" || return 2
  /usr/bin/sed -nE "s/^ *${which} +([0-9]+).*/\\1/p" <<<"$plain" | tail -1
}

# vv_summary <file> — the last summary line, ANSI-free and whitespace-squeezed, for humans.
vv_summary() {
  local f="${1:?vv_summary: no file given}" plain
  plain="$(vv_strip_ansi "$f")" || return 2
  grep -E '^ *(Test Files|Tests) +[0-9]' <<<"$plain" | tail -1 | tr -s ' '
}

# vv_classify <file> <raw-exit-status> — the three-valued verdict, from bytes already captured.
# PURE: no subprocess of its own beyond reading the file, so an attacker can drive it with
# fixtures (including ANSI ones) instead of having to provoke a real startup failure.
vv_classify() {
  local f="${1:?vv_classify: no file given}" raw="${2:?vv_classify: no exit status given}"
  if ! vv_ran "$f"; then return 2; fi
  [ "$raw" -eq 0 ] && return 0
  return 1
}

# vv_run <dir> <log-file> <vitest-arg...> — run a suite from <dir> with colour OFF, capture
# everything into <log-file>, and return the three-valued verdict.
#
# NO_COLOR and FORCE_COLOR=0 are both set because picocolors (vitest's colour layer) honours
# NO_COLOR while some CI images set FORCE_COLOR, and the later wins if it is left standing.
vv_run() {
  local dir="${1:?vv_run: no dir given}" log="${2:?vv_run: no log given}"
  shift 2
  [ "$#" -gt 0 ] || { echo "vv_run: no vitest arguments given" >&2; return 2; }
  ( cd "$dir" && NO_COLOR=1 FORCE_COLOR=0 npx vitest run "$@" ) > "$log" 2>&1
  local raw=$?
  vv_classify "$log" "$raw"
}

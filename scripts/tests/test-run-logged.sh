#!/usr/bin/env bash
#
# test-run-logged.sh — ATTACK test for scripts/run-logged.sh (CR-72).
#
# This does NOT read the helper's source and agree with it. It RUNS the helper
# with real commands and asserts real behavior: that a failing command produces
# a failing helper exit AND a truthful `__RUN_EXIT__=1` sentinel, that a passing
# command OPENS (exit 0), and that missing args ERROR loudly (exit 2).
#
# If the helper ever stops reporting the command's REAL exit — the exact defect
# that turned a RED pre-push into a false "0 failures" — one of these cases goes
# RED.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../run-logged.sh"
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_T}"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

if [[ ! -f "${HELPER}" ]]; then
  fail "helper not found at ${HELPER}"
fi

# ── Case A: a command that exits 1 ──────────────────────────────────────────
# The helper's OWN exit must be 1, the log's last line must be __RUN_EXIT__=1,
# and the captured output must contain the command's stdout ("hi").
logA="${TMPDIR_T}/a.log"
set +e
bash "${HELPER}" "${logA}" -- bash -c 'echo hi; exit 1' >/dev/null
exitA=$?
set -e 2>/dev/null || true
[[ "${exitA}" -eq 1 ]] || fail "Case A: helper exit expected 1, got ${exitA}"
lastA="$(tail -n 1 "${logA}")"
[[ "${lastA}" == "__RUN_EXIT__=1" ]] || fail "Case A: last log line expected '__RUN_EXIT__=1', got '${lastA}'"
grep -q '^hi$' "${logA}" || fail "Case A: log missing captured command output 'hi'"
echo "PASS: Case A — failing command → helper exit 1, sentinel __RUN_EXIT__=1, output captured"

# ── Case B: a command that exits 0 (prove the gate OPENS on success) ─────────
logB="${TMPDIR_T}/b.log"
bash "${HELPER}" "${logB}" -- bash -c 'echo ok; exit 0' >/dev/null
exitB=$?
[[ "${exitB}" -eq 0 ]] || fail "Case B: helper exit expected 0, got ${exitB}"
lastB="$(tail -n 1 "${logB}")"
[[ "${lastB}" == "__RUN_EXIT__=0" ]] || fail "Case B: last log line expected '__RUN_EXIT__=0', got '${lastB}'"
echo "PASS: Case B — passing command → helper exit 0, sentinel __RUN_EXIT__=0"

# ── Case C: missing command args → loud ERROR (exit 2), never silent ─────────
set +e
bash "${HELPER}" "${TMPDIR_T}/c.log" >/dev/null 2>&1
exitC=$?
set -e 2>/dev/null || true
[[ "${exitC}" -eq 2 ]] || fail "Case C: missing args expected exit 2, got ${exitC}"
echo "PASS: Case C — missing args → loud ERROR exit 2"

echo "ALL PASS: test-run-logged.sh (3/3 cases)"

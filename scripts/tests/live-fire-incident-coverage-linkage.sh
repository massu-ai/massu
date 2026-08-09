#!/usr/bin/env bash
# Live-fire attack on the CR-62 incident-coverage gate's LINKAGE predicate.
#
# ── Why this uses REAL HISTORY instead of a planted commit ─────────────────────
# The plan for this work (cited from the incident record, not here — an internal doc
# path in a synced file blocks the public-mirror leak guard) asks for a plant: "a commit whose RANGE carries an unrelated incident but whose
# own content carries none and whose sha nothing cites". That commit already exists —
# it is the live 2026-08-08 failure, `807f05eb`, sitting in a range with the unrelated
# `acd2fa2a docs(incident): the mirror was stale`. Fabricating a synthetic twin would
# be strictly weaker evidence AND would require mutating the repo, so this harness
# drives the REAL gate over REAL ranges and mutates nothing. Read-only is asserted at
# the end, not assumed.
#
# Every case demands its verdict FOR ITS OWN DECLARED REASON — a gate that goes red
# for an unrelated reason proves nothing, and one that goes red on compliant work is a
# brick that gets disabled (CR-72).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

GATE="scripts/massu-incident-coverage.sh"
[ -f "$GATE" ] || { echo "FATAL: $GATE missing — cannot attack a gate that is not there"; exit 2; }

# The fixture commits. If any has been rewritten out of history this harness must FAIL
# LOUDLY rather than silently verify nothing (M2) — a vacuous pass is the whole disease.
FIXTURES="807f05ebc7defd1bb34dc0b17e80bd4a4a49c65c c1584e27809bb4145a39b04dbc5d318e2d231ad7 acd2fa2a 456039c0 e10e7953 8cc6e6e2"
for f in $FIXTURES; do
  git cat-file -e "${f}^{commit}" 2>/dev/null || {
    echo "FATAL: fixture commit $f is not in this history — the harness cannot verify anything."
    exit 2
  }
done

# THE GATE'S ENTIRE WRITE SURFACE, enumerated by command rather than assumed:
#   $ grep -nE '>>|[^0-9&]> ' scripts/massu-incident-coverage.sh | grep -v '^\s*[0-9]*:\s*#'
#   51:    >> "$REPO_ROOT/.massu-incident-coverage-bypass.log"
# One append, on the bypass path. Everything else is reads.
#
# ⚠ THIS USED TO HASH `git status --porcelain` FOR THE WHOLE TREE. That is a claim
# about the MACHINE, not about the gate — any concurrent write anywhere in the repo
# trips it. It went red once inside the pre-push battery while passing standalone,
# which is the same shape as a wall-clock budget: it fails in both directions and
# depends on ambient state rather than on the property under test (G27). State the
# property directly: the gate must not modify the files IT can write.
SHA_BEFORE="$(shasum -a 256 "$GATE" | cut -d' ' -f1)"
LOG_STATE_BEFORE="absent"
[ -f "$REPO_ROOT/.massu-incident-coverage-bypass.log" ] \
  && LOG_STATE_BEFORE="$(shasum -a 256 "$REPO_ROOT/.massu-incident-coverage-bypass.log" | cut -d' ' -f1)"

pass=0; fail=0

# $1 label, $2 range, $3 expected exit, $4 required substring, $5 ratchet epoch
expect() {
  local label="$1" range="$2" want="$3" needle="$4" epoch="$5"
  local out rc=0
  out="$(MASSU_INCIDENT_LINKAGE_FROM="$epoch" bash "$GATE" "$range" 2>&1)" || rc=$?
  if [ "$rc" -ne "$want" ]; then
    fail=$((fail+1)); printf '  FAIL %-52s wanted exit %s, got %s\n' "$label" "$want" "$rc"
    printf '%s\n' "$out" | sed 's/^/         /' | head -8
  elif ! printf '%s' "$out" | grep -qF "$needle"; then
    fail=$((fail+1)); printf '  FAIL %-52s exit %s but not for "%s"\n' "$label" "$rc" "$needle"
    printf '%s\n' "$out" | sed 's/^/         /' | head -8
  else
    pass=$((pass+1)); printf '  ok   %-52s exit %s, for its own reason\n' "$label" "$rc"
  fi
}

echo "=== THE HOLE — an UNRELATED incident in the range must discharge NOTHING ==="
# 456039c0..807f05eb = { acd2fa2a (unrelated incident), 807f05eb (unrecorded fix) }.
# This is the exact push shape that returned PASS on 2026-08-08.
expect "unrelated incident does not discharge the fix" \
  '456039c0..807f05eb' 1 '807f05eb' 0

echo
echo "=== IT OPENS — both discharge routes, each for ITS OWN route ==="
expect "route (a) CONTAINMENT — fix carries its own incident" \
  '8cc6e6e2..e10e7953' 0 'containment 1' 0
expect "route (b) CITATION — an incident commit names the sha" \
  '456039c0..c1584e27' 0 'citation 1' 0

echo
echo "=== THE RATCHET IS REAL — pre-epoch commits keep the weaker discharge ==="
# The SAME range that fails above must PASS under the shipped epoch, and must SAY so.
# Without this the ratchet would be an unmeasured claim; with it, the exemption is
# visible and can be watched shrink to zero (G18).
expect "pre-ratchet commit falls back to range-existence" \
  '456039c0..807f05eb' 0 'pre-ratchet range-existence 1' 9999999999

echo
echo "=== NEGATIVE CONTROLS — the ORIGINAL behaviour must survive ==="
# No incident anywhere in the range was always a failure and still must be.
expect "no incident anywhere still FAILS" \
  '807f05eb~1..807f05eb' 1 '807f05eb' 0
# A range with no obligated fix commit must not invent work.
expect "range with no obligated commit PASSES" \
  '807f05eb..29fa7d15' 0 '0 obligated' 0
# The documented bypass must still work, and must still be loud.
#
# The bypass path APPENDS to a real audit log. A harness that leaves entries behind
# would forge that trail — an operator reading it later cannot tell a test run from a
# genuine bypass. So the log is snapshotted and restored to EXACTLY its prior state,
# including not existing at all. (Caught by the read-only assertion below on this
# harness's own first run: it reported `working tree CHANGED`.)
BYPASS_LOG="$REPO_ROOT/.massu-incident-coverage-bypass.log"
BYPASS_LOG_EXISTED=0; BYPASS_LOG_SNAP=""
if [ -f "$BYPASS_LOG" ]; then
  BYPASS_LOG_EXISTED=1
  BYPASS_LOG_SNAP="$(mktemp -t incident-bypass-log-XXXXXX)" || exit 2
  cp "$BYPASS_LOG" "$BYPASS_LOG_SNAP"
fi
restore_bypass_log() {
  if [ "$BYPASS_LOG_EXISTED" -eq 1 ]; then
    cp "$BYPASS_LOG_SNAP" "$BYPASS_LOG"; rm -f "$BYPASS_LOG_SNAP"
  else
    rm -f "$BYPASS_LOG"
  fi
}
trap restore_bypass_log EXIT

BYPASS_OUT="$(MASSU_SKIP_INCIDENT_COVERAGE=1 bash "$GATE" '456039c0..807f05eb' 2>&1)"; BYPASS_RC=$?
if [ "$BYPASS_RC" -eq 0 ] && grep -qF 'bypassed via' <<< "$BYPASS_OUT"; then
  pass=$((pass+1)); printf '  ok   %-52s exit 0, and it announces itself\n' "documented bypass still works"
else
  fail=$((fail+1)); printf '  FAIL %-52s rc=%s\n' "documented bypass still works" "$BYPASS_RC"
fi

restore_bypass_log; trap - EXIT

echo
echo "=== READ-ONLY — the gate must not modify the files IT can write ==="
SHA_AFTER="$(shasum -a 256 "$GATE" | cut -d' ' -f1)"
LOG_STATE_AFTER="absent"
[ -f "$REPO_ROOT/.massu-incident-coverage-bypass.log" ] \
  && LOG_STATE_AFTER="$(shasum -a 256 "$REPO_ROOT/.massu-incident-coverage-bypass.log" | cut -d' ' -f1)"
[ "$SHA_BEFORE" = "$SHA_AFTER" ] \
  && { pass=$((pass+1)); printf '  ok   %-52s %s…\n' "gate script unchanged" "${SHA_BEFORE:0:16}"; } \
  || { fail=$((fail+1)); printf '  FAIL %-52s %s != %s\n' "gate script CHANGED" "${SHA_BEFORE:0:16}" "${SHA_AFTER:0:16}"; }
if [ "$LOG_STATE_BEFORE" = "$LOG_STATE_AFTER" ]; then
  pass=$((pass+1)); printf '  ok   %-52s (%s)\n' "bypass audit log restored exactly" "${LOG_STATE_BEFORE:0:16}"
else
  fail=$((fail+1))
  printf '  FAIL %-52s %s -> %s\n' "bypass audit log NOT restored" "$LOG_STATE_BEFORE" "$LOG_STATE_AFTER"
  printf '         a harness that leaves entries in a real audit trail forges it.\n'
fi

echo
echo "-------------------------------------------"
echo "  passed: $pass    failed: $fail"
[ "$fail" -eq 0 ] || exit 1
echo "  RESULT: PASS"

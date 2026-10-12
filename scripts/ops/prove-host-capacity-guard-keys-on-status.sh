#!/usr/bin/env bash
# Prove the REPAIRED host-capacity branching, by extracting the REAL guard out of
# scripts/pre-push-light.sh and driving it — never by re-implementing it (a test that
# re-implements its subject drifts into agreement with its subject's bugs, G15).
#
# Four cases, and the fourth is the one the old code got wrong:
#   rc=0 OK            -> RUN the gate
#   rc=2 UNMEASURABLE  -> RUN the gate (not yet armed must never be stricter than no gate)
#   rc=3 DEGRADED      -> REFUSE the gate as UNMEASURED
#   rc/state DISAGREE  -> FAIL CLOSED   <- previously fell through to PERMISSIVE
set -uo pipefail

REPO="${REPO:-$HOME/massu-internal}"
SRC="$REPO/scripts/pre-push-light.sh"
[ -r "$SRC" ] || { printf 'M2: cannot read %s\n' "$SRC" >&2; exit 2; }

# Extract the real hc_gate_guard function body from the real file.
GUARD_SRC="$(/usr/bin/awk '/^hc_gate_guard\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SRC")"
case "$GUARD_SRC" in
  *'hc_gate_guard() {'*) : ;;
  *) printf 'M2: could not extract hc_gate_guard from %s — refusing to judge\n' "$SRC" >&2; exit 2 ;;
esac
# POSITIVE CONTROL on the extraction: the guard must reference the NUMERIC status, which is the
# whole point of the repair. If it does not, the extraction grabbed the wrong thing or the fix
# regressed, and either way this harness must not report a pass.
case "$GUARD_SRC" in
  *'HC_RC'*) : ;;
  *) printf 'M2: extracted guard does not mention HC_RC — the fix is absent or this grabbed the wrong function\n' >&2; exit 2 ;;
esac
printf 'extracted hc_gate_guard: %s lines, references HC_RC\n\n' "$(printf '%s\n' "$GUARD_SRC" | grep -c .)"

pass=0; fail=0
drive() {  # drive <rc> <state> <expect-run|expect-refuse>
  local rc="$1" state="$2" expect="$3" out got
  # Build the guard's whole environment INSIDE the eval. Set as plain assignments beside it they
  # were invisible to static analysis -- three SC2034s on a file written to fix an SC2034 finding
  # (G10: the fix is a new instance until proven otherwise) -- and, more to the point, the values
  # the guard sees now arrive in ONE place instead of straddling the eval boundary. printf %q so
  # a state like '' or 'DEGRADED(1.9x)' survives re-parsing intact.
  local prelude
  prelude="$(printf 'HC_RC=%q; HC_STATE=%q; HC_LINE=%q\n' "$rc" "$state" "$state (synthetic)")"
  out="$(
    eval "$prelude
$GUARD_SRC"
    if hc_gate_guard "synthetic gate" >/dev/null 2>&1; then echo RUN; else echo REFUSE; fi
  )"
  got="$out"
  if [ "$got" = "$expect" ]; then
    printf '  ok    rc=%-2s state=%-13s -> %s\n' "$rc" "$state" "$got"; pass=$((pass+1))
  else
    printf '  FAIL  rc=%-2s state=%-13s -> %s (wanted %s)\n' "$rc" "$state" "$got" "$expect"; fail=$((fail+1))
  fi
}

echo "[guard] the three legitimate states"
drive 0 OK           RUN
drive 2 UNMEASURABLE RUN
drive 3 DEGRADED     REFUSE

echo
echo "[guard] the case the OLD code got wrong: a reworded/empty verdict must NOT read as 'host is fine'"
# Under the old text-keyed guard, HC_STATE != "DEGRADED" was TRUE for every one of these, so the
# gate RAN. Keyed on rc=3 the degraded host is still refused no matter how the line is worded.
drive 3 ''                REFUSE
drive 3 'degraded'        REFUSE
drive 3 'DEGRADED(1.9x)'  REFUSE

echo
printf 'passed: %s   failed: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
[ "$pass" -eq 6 ] || { printf 'M1: expected 6 cases, ran %s — refusing to report a pass\n' "$pass" >&2; exit 2; }
echo "ALL 6 CASES PASS — the guard is keyed on the numeric status and a reworded verdict cannot make it permissive."

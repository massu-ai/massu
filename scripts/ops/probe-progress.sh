#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# probe-progress.sh — report where probe-gate-requires.sh actually is, and an ETA DERIVED
# from the observed rate rather than asserted.
#
# CR-68: a constant about the outside world is a CLAIM — ship the measuring script, not the
# number. "About an hour" is an unprobed capability claim; this prints what it counted and
# how it extrapolated, so the estimate can be checked instead of believed.
#
# Also M1: it reports the DENOMINATOR (gates expected) beside the numerator (verdicts seen).
# If it cannot find the run, it says so LOUDLY rather than printing a reassuring 0%.
#
# Usage: scripts/ops/probe-progress.sh [--watch]
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

RED=$'\033[0;31m'; NC=$'\033[0m'

WATCH=0
[ "${1:-}" = "--watch" ] && WATCH=1

report() {
  local scratch expected seen phase running started elapsed
  # shellcheck disable=SC2012  # mktemp -d names are alphanumeric by construction
  scratch="$(ls -dt "${TMPDIR:-/tmp}"/gate-requires-probe.* 2>/dev/null | head -1)"

  if pgrep -f 'probe-gate-requires' >/dev/null 2>&1; then running="yes"; else running="no"; fi

  if [ -z "${scratch:-}" ] || [ ! -d "$scratch" ]; then
    # FAIL LOUD: "no scratch dir" is not "0% done", and must not read as progress.
    echo "${RED}CANNOT SEE${NC}: no gate-requires-probe.* scratch dir under ${TMPDIR:-/tmp}."
    echo "             probe running: $running"
    echo "             If running=no, the probe either finished (check git diff on"
    echo "             scripts/lib/gate-requires.json) or died before creating scratch."
    return 1
  fi

  expected="$(python3 -c 'import json,sys;print(len(json.load(open("scripts/lib/gate-registry.json"))["gates"]))' 2>/dev/null || echo '?')"

  echo "scratch      : $scratch"
  echo "probe running: $running"
  echo "registry     : $expected gates (the denominator)"

  local f
  for f in "$scratch"/*.out; do
    [ -e "$f" ] || continue
    seen="$(grep -cE '^(OK|FAIL) +\[' "$f" 2>/dev/null || true)"
    phase="$(grep -oE 'DEFEAT|GUARD DEFEAT|Running [0-9]+ defect job' "$f" 2>/dev/null | tail -1)"
    started="$(date -r "$f" +%s 2>/dev/null || echo 0)"
    elapsed=$(( $(date +%s) - started ))
    printf '  %-22s verdicts %4s / %-4s  last-write %4ds ago  phase: %s\n' \
      "$(basename "$f")" "$seen" "$expected" "$elapsed" "${phase:-<pre-defeat>}"

    # ETA only when there is a RATE to extrapolate from. No verdicts => no estimate,
    # stated as such rather than filled in with a plausible number.
    if [ "${seen:-0}" -gt 5 ] && [ "$expected" != "?" ]; then
      python3 - "$seen" "$expected" "$started" <<'PY'
import sys, time
seen, expected, started = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
# `started` is the file's last-write time, which is NOT the phase start; treat this as a
# coarse lower bound and say so, rather than presenting it as a schedule.
print(f"      -> {seen}/{expected} verdicts ({100*seen/expected:.0f}%). "
      f"Rate-based ETA needs two samples; run --watch to get one.")
PY
    fi
  done
  return 0
}

if [ "$WATCH" -eq 1 ]; then
  prev_seen=0; prev_t=0
  while true; do
    date -u +"── %FT%TZ ──"
    report
    # shellcheck disable=SC2012  # mktemp -d names are alphanumeric by construction
    scratch="$(ls -dt "${TMPDIR:-/tmp}"/gate-requires-probe.* 2>/dev/null | head -1)"
    if [ -n "${scratch:-}" ]; then
      now_seen=$(cat "$scratch"/*.out 2>/dev/null | grep -cE '^(OK|FAIL) +\[' || true)
      [ -n "${now_seen:-}" ] || now_seen=0
      now_t=$(date +%s)
      if [ "$prev_t" -gt 0 ] && [ "$now_seen" -gt "$prev_seen" ]; then
        python3 - "$prev_seen" "$now_seen" "$prev_t" "$now_t" \
          "$(python3 -c 'import json;print(len(json.load(open("scripts/lib/gate-registry.json"))["gates"]))')" <<'PY'
import sys
p_seen, n_seen, p_t, n_t, total = map(int, sys.argv[1:6])
rate = (n_seen - p_seen) / max(1, n_t - p_t)
remaining = total - n_seen
if rate > 0:
    print(f"   MEASURED rate {rate*60:.1f} verdicts/min over {n_t-p_t}s "
          f"-> {remaining} left ≈ {remaining/rate/60:.0f} min for THIS sweep")
PY
      fi
      prev_seen=$now_seen; prev_t=$now_t
    fi
    pgrep -f 'probe-gate-requires' >/dev/null 2>&1 || { echo "probe no longer running — stopping watch."; break; }
    sleep 60
  done
else
  report
fi

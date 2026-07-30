#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# verify-scaling-ratio-under-load.sh — prove the scaling-ratio guard is LOAD-INDEPENDENT.
#
# WHY. G27/CR-90 replaced wall-clock budgets with scaling ratios because a budget asserts
# the MACHINE, not the code. On 2026-07-29 the replacement flaked anyway: template-engine
# TPL-SEC-05 reported ratio 10.02 and 10.84 against a bound of 8 inside the pre-push
# battery, while passing 3/3 in isolation on the same commit. Cause:
# helpers/scaling.ts kept min(small) and min(large) INDEPENDENTLY, which biases the
# quotient upward because the 4x-longer run is likelier never to catch a quiet window.
#
# A test that only ever runs quiet cannot prove load-independence — that is the blind-gate
# law aimed at the verification. So this GENERATES contention and demands green under it.
#
# SAFETY: the load generators are `sh -c 'while :; do :; done'` — pure CPU spin, no I/O, no
# filesystem access, no destructive token anywhere. They are killed by an EXIT trap and by
# an absolute deadline, so an abandoned run cannot leave the machine loaded.
#
# Usage: bash scripts/tests/verify-scaling-ratio-under-load.sh [--loaders N] [--runs N]
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'

LOADERS=0
RUNS=3
while [ $# -gt 0 ]; do
  case "$1" in
    --loaders) LOADERS="${2:?--loaders needs N}"; shift ;;
    --runs)    RUNS="${2:?--runs needs N}"; shift ;;
    *) echo "FATAL: unrecognised argument '$1' (expected --loaders N | --runs N)" >&2; exit 2 ;;
  esac
  shift
done

if [ "$LOADERS" -eq 0 ]; then
  # Default: enough spinners to contend on this host without wedging it.
  CORES="$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  LOADERS=$(( CORES > 4 ? CORES / 2 : 2 ))
fi

PIDS=""
stop_load() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  PIDS=""
}
trap stop_load EXIT INT TERM

echo "── scaling-ratio load independence ──"
echo "  host cores : $(sysctl -n hw.ncpu 2>/dev/null || echo '?')"
echo "  loaders    : $LOADERS   runs: $RUNS"

for _ in $(seq 1 "$LOADERS"); do
  sh -c 'while :; do :; done' &
  PIDS="$PIDS $!"
done
sleep 2

# M1 — prove the load actually exists. Without this, a green run might mean the loaders
# never started, i.e. the proof did not run at all.
ALIVE=0
for p in $PIDS; do kill -0 "$p" 2>/dev/null && ALIVE=$((ALIVE + 1)); done
echo "  loaders alive (positive control): $ALIVE of $LOADERS"
if [ "$ALIVE" -lt "$LOADERS" ]; then
  echo "${RED}FAIL${NC}: load generators did not start — this proves nothing." >&2
  exit 1
fi

PASSED=0; FAILED=0
for i in $(seq 1 "$RUNS"); do
  ( cd "$REPO_ROOT/packages/core" && npx vitest run template-engine -t "quadratic" ) \
    > "/tmp/scaling-under-load-$i.txt" 2>&1
  rc=$?
  ratio="$(grep -oE 'ratio [0-9.]+' "/tmp/scaling-under-load-$i.txt" | head -1)"
  if [ "$rc" -eq 0 ]; then
    echo "  ${GREEN}PASS${NC}  run $i under load (exit 0) ${ratio:+[$ratio]}"
    PASSED=$((PASSED + 1))
  else
    echo "  ${RED}FAIL${NC}  run $i under load (exit $rc) ${ratio:-<no ratio line>}"
    FAILED=$((FAILED + 1))
  fi
done

stop_load
echo
echo "  passed: $PASSED   failed: $FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "${RED}FAIL${NC}: the ratio guard is still load-sensitive; it asserts the machine, not the code."
  exit 1
fi
echo "${GREEN}PASS${NC}: ratio held under $LOADERS-way contention across $RUNS runs."

#!/usr/bin/env bash
# CI-ONLY: the full CONTROL→PLANT→ORACLE→DEFEAT anti-vacuity sweep re-runs each
# scanner once per fail-point; the measured wall-clock (834s @ AV_CONCURRENCY=8 on
# a 28-core host — CR-68) is far too slow for the ~90s pre-push budget. Pre-push
# mirrors only the fast `--completeness-only` gate (step [22/22]); this full sweep
# runs on every push in CI. See CR-50 / VR-CI-PARITY.
#
# scripts/ci-anti-vacuity.sh — the G-6 meta-gate, wired fail-closed into CI (P6).
#
# WHY THIS EXISTS (the class it closes): until this wiring landed, the anti-vacuity
# runner had ZERO real invocations anywhere (CL-4) — the meta-gate that exists to
# catch built-and-never-enabled code was itself built and never enabled. A guard CI
# does not run is decoration. This runs it on every push and fails the build RED the
# instant any scanner fail-point stops being able to fail on its own planted defect.
#
# Fail-closed: `set -euo pipefail` + the runner's own non-zero exit (1 = a gate stayed
# GREEN on its planted defect = decoration; 2 = FATAL, e.g. an unreadable registry or
# a zero-denominator discovery) both abort this script non-zero → the CI job goes RED.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Step 0 — build the dist/ artifacts the vitest dist-guard oracles spawn (R12-1) ──────────
# The Wave-1b vitest-guard `dist-artifact` oracles (session-start-drift / cli-dispatcher /
# session-start-watcher) `spawnSync('node', [dist/hooks/*.js | dist/cli.js])`, and those
# artifacts are gitignored build output — the CI Test/Type-Check jobs build only adapters, so a
# fresh runner has NO dist/. Without this build the dist-guard oracles abort LOUD on a missing
# artifact (the M3 alive-locally-dead-in-CI trap). Wiring the build HERE, in the same job that
# runs the sweep, keeps the CI job stable across the Wave-1a→1b boundary (Wave 1b adds the
# vitest kinds to the SAME runner + registry; no CI re-wire needed).
#
# NOTE (honest state, not laundered): in Wave 1a the runner sweeps ONLY the 107 shell
# fail-points — no vitest guard is registered yet — so nothing in THIS wave consumes dist/.
# The build is present now because R12-1 makes it a mandatory part of P6's one-time CI wiring;
# it becomes load-bearing when Wave 1b registers the first dist-artifact vitest oracle.
echo "── [ci-anti-vacuity] Step 0: building dist (build:hooks + build:cli) for dist-guard oracles ──"
( cd packages/core && npm run build:hooks && npm run build:cli )

# ── Step 1 — the full anti-vacuity DEFEAT sweep, fail-closed ─────────────────────────────────
# AV_CONCURRENCY is honored by the runner (default: cores-2, soft-cap 16). CI sets it via the
# workflow env; re-measure the wall-clock against the actual CI runner and tune (CR-68 — the
# runner prints its own wall-clock; ship the measuring tool, not a guessed constant).
echo "── [ci-anti-vacuity] Step 1: full CONTROL→PLANT→ORACLE→DEFEAT sweep (AV_CONCURRENCY=${AV_CONCURRENCY:-auto}) ──"
# M1 — a gate whose CI failure you cannot DIAGNOSE is half-built. Capture the sweep so that, on
# failure, the distinguishing lines (which guard stayed GREEN / FATAL'd / the tally) are written to
# $GITHUB_STEP_SUMMARY — retrievable via the API even when the raw job-log blob is unavailable
# (as it was for run 29623783685, where the sweep failed only on the Linux runner and the blob 404'd).
SWEEP_OUT="$(mktemp)"
set +e
bash scripts/massu-gate-anti-vacuity.sh 2>&1 | tee "$SWEEP_OUT"
SWEEP_RC=${PIPESTATUS[0]}
set -e
if [ "$SWEEP_RC" -ne 0 ]; then
  {
    echo "### ❌ Anti-Vacuity sweep FAILED (exit ${SWEEP_RC})"
    echo ""
    echo "Distinguishing lines (which guard/fail-point did not go RED, or FATAL'd):"
    echo '```'
    sed -E $'s/\033\\[[0-9;]*m//g' "$SWEEP_OUT" \
      | grep -E 'IT IS DECORATION|stayed .*GREEN|FATAL|── [a-z0-9].*—|FAIL  ?\[|FAIL: |CONTROL: |ORACLE did|PLANT: |no ORACLE|no defect|proven can-fail|failures  *:|Unknown|npm error|Error:' \
      | tail -80
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY:-/dev/stderr}"
  echo "── [ci-anti-vacuity] Step 1 FAILED (exit ${SWEEP_RC}); failure summary written to the job step summary. ──" >&2
  exit "$SWEEP_RC"
fi

echo "── [ci-anti-vacuity] PASS: every discovered fail-point proved it can fail. ──"

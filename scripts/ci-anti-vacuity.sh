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

# ── Step 0 — build EVERY artifact the sweep's gates need (R12-1; W-1 of
#    plan-2026-07-26-anti-vacuity-9-unproven-gates) ────────────────────────────────────────────
# The vitest-guard `dist-artifact` oracles (session-start-drift / cli-dispatcher /
# session-start-watcher) `spawnSync('node', [dist/hooks/*.js | dist/cli.js])`, and those
# artifacts are gitignored build output, so a fresh runner has NO dist/.
#
# W-1 CORRECTION: this comment previously read "the CI Test/Type-Check jobs build only adapters",
# which is precisely BACKWARDS about what THIS job was missing, and is the sentence that made the
# gap invisible for ten days. The sibling jobs each run `npm run build:adapters` (ci.yml — the
# Type Check job and the Test job); THIS job ran neither. `build:hooks`/`build:cli` mark the
# workspace adapters `--external:`, so dist/hooks/*.js and dist/cli.js resolve
# `@massu/adapter-*` at RUNTIME from node_modules -> packages/adapter-*, whose dist/ `npm ci`
# does NOT build. Result: 4 of the 9 gates reported "not proven can-fail" when they were in fact
# failing CLOSED on an artifact this job never produced.
#
# ORDER MATTERS: build:bundle-adapters CONSUMES packages/adapter-*/dist, so it must follow
# build:adapters; build:hooks/build:cli leave the adapters external and resolve them at runtime.
echo "── [ci-anti-vacuity] Step 0: building adapters + adapter bundle + dist (hooks/cli) ──"
npm run build:adapters
( cd packages/core && npm run build:bundle-adapters )
( cd packages/core && npm run build:hooks && npm run build:cli )

# ASSERT THE END STATE — never infer it from `npm run` exit 0 (CR-69 / G12). `npm run` can exit 0
# having emitted nothing, and a missing artifact downstream is rendered by the sweep as
# "not proven can-fail", i.e. indistinguishable from decoration. Fail LOUD, with the remedy.
_av_require_artifact() {
  # $1 = path, $2 = remedy command
  if [ ! -e "$1" ]; then
    echo "FATAL: [ci-anti-vacuity] Step 0 produced no '$1'." >&2
    echo "       The build command exited 0 without emitting it." >&2
    echo "       REMEDY: $2" >&2
    exit 2
  fi
}
# X-1: the required set is DERIVED from scripts/lib/gate-requires.json, never re-typed here.
# This block previously hardcoded five `_av_require_artifact` calls naming the same artifacts
# and remedies the vocabulary now holds — two authoring sites for one fact, which is the exact
# drift class this plan exists to close, sitting inside the plan's own CI step. A precondition
# added to the vocabulary and not mirrored here would have been provisioned by nobody.
_AV_REQUIRES_SOT="scripts/lib/gate-requires.json"
if [ ! -r "$_AV_REQUIRES_SOT" ]; then
  echo "FATAL: [ci-anti-vacuity] cannot read $_AV_REQUIRES_SOT — refusing to run the sweep" >&2
  echo "       with an unknown precondition contract (M2: unreadable is an ERROR, not empty)." >&2
  exit 2
fi
_AV_CHECKED=0
_AV_TOTAL="$(python3 -c 'import json;print(len(json.load(open("scripts/lib/gate-requires.json"))["vocabulary"]))')"
while IFS=$'\t' read -r _name _probe _remedy; do
  [ -n "${_name:-}" ] || continue
  _AV_CHECKED=$((_AV_CHECKED + 1))
  if ! bash -c "$_probe" >/dev/null 2>&1; then
    echo "FATAL: [ci-anti-vacuity] Step 0 left precondition '$_name' UNSATISFIED." >&2
    echo "       probe : $_probe" >&2
    echo "       REMEDY: $_remedy" >&2
    exit 2
  fi
done < <(python3 - "$_AV_REQUIRES_SOT" <<'PY'
import json, sys
sot = json.load(open(sys.argv[1]))
vocab = sot.get("vocabulary") or {}
if not vocab:
    sys.exit("FATAL: gate-requires.json vocabulary is EMPTY — refusing to verify nothing (M1).")
for name, spec in sorted(vocab.items()):
    print("\t".join([name, spec["probe"], spec["remedy"]]))
PY
)
# M1: report the DENOMINATOR and ASSERT it. "checked 0 of 0, all present" must never pass.
if [ "$_AV_CHECKED" -eq 0 ] || [ "$_AV_CHECKED" -ne "$_AV_TOTAL" ]; then
  echo "FATAL: [ci-anti-vacuity] verified $_AV_CHECKED of $_AV_TOTAL declared precondition(s)." >&2
  echo "       A preflight that did not read every entry cannot report them all present." >&2
  exit 2
fi
echo "── [ci-anti-vacuity] Step 0: verified $_AV_CHECKED of $_AV_TOTAL declared precondition(s) ──"

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
      | grep -E 'IT IS DECORATION|stayed .*GREEN|FATAL|── [a-z0-9].*—|FAIL  ?\[|FAIL: |CONTROL: |ORACLE did|PLANT: |no ORACLE|no defect|proven can-fail|failures  *:|PRECONDITION MISSING|remedy  *:|blocks  *:|preflight  *:|validated [0-9]+ of [0-9]+|Unknown|npm error|Error:' \
      | tail -80
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY:-/dev/stderr}"
  echo "── [ci-anti-vacuity] Step 1 FAILED (exit ${SWEEP_RC}); failure summary written to the job step summary. ──" >&2
  exit "$SWEEP_RC"
fi

echo "── [ci-anti-vacuity] PASS: every discovered fail-point proved it can fail. ──"

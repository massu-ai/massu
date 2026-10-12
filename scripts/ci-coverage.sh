#!/usr/bin/env bash
#
# ci-coverage.sh - Real-coverage gate for CI + pre-push parity (CR-50 / VR-CI-PARITY).
#
# plan-2026-06-03-website-lib-test-coverage P0-006. Delegates to the single SoT gate
# scripts/massu-test-coverage.sh (v8 instrumented line% vs coverage-floors.json) so CI
# and pre-push-light run byte-identical coverage enforcement — no second copy of the
# parsing/threshold logic (CR-46 no N+1 alias map).
#
# Called from BOTH .github/workflows/ci.yml (test job) and scripts/pre-push-light.sh
# (step [17/17]). NOT a CI-ONLY script.
#
# Exit 0 = every package >= its floor. Exit 1 = below floor / failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CONSUME the reports the Tests gate's instrumented run already produced — never re-run the
# suites. `MASSU_COVERAGE_SKIP_RUN` is the comparator's own documented switch
# (massu-test-coverage.sh:19), so this is wiring, not new logic, and the floors + the
# single-comparator contract are untouched.
#
# FAILS CLOSED on a missing report: massu-test-coverage.sh fails the package with
# "coverage-summary.json not generated" rather than passing, and `npm run test:instrumented`
# deletes the coverage directories BEFORE running, so a stale summary from an earlier push
# can never be consumed as if this run had produced it.
exec env MASSU_COVERAGE_SKIP_RUN=1 bash "$SCRIPT_DIR/massu-test-coverage.sh"

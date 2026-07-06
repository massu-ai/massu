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

exec bash "$SCRIPT_DIR/massu-test-coverage.sh"

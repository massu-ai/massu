#!/bin/bash
# =============================================================================
# TDD Runner: Single Test File Execution
# =============================================================================
# Purpose: Wrapper for vitest single-file runs with clear status output.
#          Used by /massu-tdd command for RED/GREEN/IMPROVE cycle.
#
# Usage: ./scripts/tdd-runner.sh [test-file-path]
# Example: ./scripts/tdd-runner.sh packages/core/src/__tests__/analytics.test.ts
#
# Reference: Massu Phase 9 - Infrastructure Scripts
# =============================================================================

if [ -z "$1" ]; then
  echo "Usage: ./scripts/tdd-runner.sh <test-file>"
  echo "Example: ./scripts/tdd-runner.sh packages/core/src/__tests__/analytics.test.ts"
  exit 1
fi

TEST_FILE="$1"

if [ ! -f "$TEST_FILE" ]; then
  echo "[ERROR] Test file not found: $TEST_FILE"
  exit 1
fi

echo "=============================================="
echo "TDD RUNNER: $TEST_FILE"
echo "=============================================="
echo ""

# Run vitest with verbose reporter for clear output
npx vitest run --reporter=verbose "$TEST_FILE"
EXIT_CODE=$?

echo ""
echo "=============================================="
if [ $EXIT_CODE -eq 0 ]; then
  echo "STATUS: GREEN (all tests passed)"
else
  echo "STATUS: RED (tests failed - exit code: $EXIT_CODE)"
fi
echo "=============================================="

exit $EXIT_CODE

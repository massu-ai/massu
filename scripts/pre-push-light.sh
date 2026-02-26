#!/bin/bash
#
# pre-push-light.sh - Fast pre-push verification (~90 seconds)
#
# Runs quick checks to catch common issues before pushing:
# 1. Pattern Scanner - ESM patterns, config access, code quality
# 2. Security Scanner - Secrets, eval, SQL injection patterns
# 3. Hook Build - Compile all hooks with esbuild
# 4. TypeScript - Type errors (noEmit)
# 5. Tests - Full vitest suite
#
# Usage: ./scripts/pre-push-light.sh
#

set -e

echo "=============================================="
echo "MASSU PUSH LIGHT - Fast Pre-Push Verification"
echo "=============================================="
echo ""

FAILED=0
START_TIME=$(date +%s)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Pattern Scanner (~5s)
echo -n "[1/5] Pattern Scanner... "
if bash "$SCRIPT_DIR/massu-pattern-scanner.sh" > /tmp/massu-pattern-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-pattern-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-pattern-scanner.log | head -10
  FAILED=1
fi

# 2. Security Scanner (~5s)
echo -n "[2/5] Security Scanner... "
if bash "$SCRIPT_DIR/massu-security-scanner.sh" > /tmp/massu-security-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-security-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-security-scanner.log | head -10
  FAILED=1
fi

# 3. Hook Build (~5s)
echo -n "[3/5] Hook Build... "
if (cd "$PROJECT_ROOT/packages/core" && npm run build:hooks) > /tmp/massu-hook-build.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-hook-build.log"
  tail -10 /tmp/massu-hook-build.log
  FAILED=1
fi

# 4. TypeScript (~30s)
echo -n "[4/5] TypeScript... "
TSC_OUTPUT=$((cd "$PROJECT_ROOT/packages/core" && npx tsc --noEmit) 2>&1)
if [ $? -eq 0 ]; then
  echo "PASS"
else
  echo "FAIL"
  echo "$TSC_OUTPUT" | grep -E "error TS" | head -10
  FAILED=1
fi

# 5. Tests (~50s)
echo -n "[5/5] Tests... "
if (cd "$PROJECT_ROOT" && npm test) > /tmp/massu-tests.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-tests.log"
  grep -E "FAIL|Error" /tmp/massu-tests.log | head -10
  FAILED=1
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=============================================="
echo "Duration: ${DURATION}s"
echo "=============================================="

if [ $FAILED -eq 0 ]; then
  echo ""
  echo "ALL CHECKS PASSED - Safe to push"
  echo ""
  exit 0
else
  echo ""
  echo "CHECKS FAILED - Fix issues before pushing"
  echo ""
  exit 1
fi

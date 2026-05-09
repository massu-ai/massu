#!/bin/bash
#
# pre-push-light.sh - Fast pre-push verification (~90 seconds)
#
# Runs quick checks to catch common issues before pushing:
# 1. Pattern Scanner       - ESM patterns, config access, code quality
# 2. Security Scanner      - Secrets, eval, SQL injection patterns
# 3. Hook Build            - Compile all hooks with esbuild
# 4. TypeScript            - Type errors (noEmit)
# 5. Tests                 - Full vitest suite
# 6. Plan Status Validator - Plan 1.5.8 schema validator
# 7. Plan Commit Drift     - Plan 1.5.8 commit drift scanner
#
# Usage: ./scripts/pre-push-light.sh
#

# Plan 1.5.8 P3-002a: swap `set -e` for `set -uo pipefail` so the
# post-loop diagnostic block survives any failed inline command and so
# this script's safety idiom matches its closest sibling
# (massu-pattern-scanner.sh:10). The `if ... ; then ... else FAILED=1; fi`
# accumulator pattern below already short-circuits errors correctly.
set -uo pipefail

echo "=============================================="
echo "MASSU PUSH LIGHT - Fast Pre-Push Verification"
echo "=============================================="
echo ""

FAILED=0
START_TIME=$(date +%s)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 0. Node version pre-flight (Plan 1.5.8 hardening — Gate 3 incident 2026-05-09)
# better-sqlite3 hard-binds to Node ABI; Node v26 lacks v8::PropertyCallbackInfo<T>::This,
# breaking native rebuild. Pin to packages/core/package.json engines `>=20.0.0 <26.0.0`.
NODE_VERSION=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ -n "$NODE_VERSION" ]; then
  if [ "$NODE_VERSION" -lt 20 ] || [ "$NODE_VERSION" -ge 26 ]; then
    echo "[0/7] Node version pre-flight... FAIL"
    echo "  Node v${NODE_VERSION}.x is incompatible with better-sqlite3."
    echo "  Required: Node >=20 <26 (per packages/core/package.json engines + .nvmrc)."
    echo "  Fix: brew install node@22 && export PATH=\"/opt/homebrew/opt/node@22/bin:\$PATH\""
    echo "       (or use nvm: nvm use \$(cat .nvmrc))"
    FAILED=1
  else
    echo "[0/7] Node version pre-flight... PASS (v${NODE_VERSION}.x)"
  fi
fi

# 1. Pattern Scanner (~5s)
echo -n "[1/7] Pattern Scanner... "
if bash "$SCRIPT_DIR/massu-pattern-scanner.sh" > /tmp/massu-pattern-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-pattern-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-pattern-scanner.log | head -10
  FAILED=1
fi

# 2. Security Scanner (~5s)
echo -n "[2/7] Security Scanner... "
if bash "$SCRIPT_DIR/massu-security-scanner.sh" > /tmp/massu-security-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-security-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-security-scanner.log | head -10
  FAILED=1
fi

# 3. Hook Build (~5s)
echo -n "[3/7] Hook Build... "
if (cd "$PROJECT_ROOT/packages/core" && npm run build:hooks) > /tmp/massu-hook-build.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-hook-build.log"
  tail -10 /tmp/massu-hook-build.log
  FAILED=1
fi

# 4. TypeScript (~30s)
echo -n "[4/7] TypeScript... "
# Wrap in `if !` so the post-loop block survives a tsc failure under
# `set -uo pipefail` (no `set -e`); the pre-existing `$? -eq 0` form
# silently broke when the `set -e` flag was removed in P3-002a.
if TSC_OUTPUT=$((cd "$PROJECT_ROOT/packages/core" && npx tsc --noEmit) 2>&1); then
  echo "PASS"
else
  echo "FAIL"
  echo "$TSC_OUTPUT" | grep -E "error TS" | head -10
  FAILED=1
fi

# 5. Tests (~50s)
echo -n "[5/7] Tests... "
if (cd "$PROJECT_ROOT" && npm test) > /tmp/massu-tests.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-tests.log"
  grep -E "FAIL|Error" /tmp/massu-tests.log | head -10
  FAILED=1
fi

# 6. Plan Status Validator (~2s) — Plan 1.5.8 P3-002
echo -n "[6/7] Plan Status Validator... "
if bash "$SCRIPT_DIR/massu-plan-status-validator.sh" > /tmp/massu-plan-status.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-plan-status.log"
  grep -E "^\s*FAIL:" /tmp/massu-plan-status.log | head -10
  FAILED=1
fi

# 7. Plan Commit Drift (~2s) — Plan 1.5.8 P3-002
echo -n "[7/7] Plan Commit Drift... "
if bash "$SCRIPT_DIR/massu-plan-commit-drift.sh" > /tmp/massu-plan-drift.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-plan-drift.log"
  grep -E "^\s*FAIL:" /tmp/massu-plan-drift.log | head -10
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

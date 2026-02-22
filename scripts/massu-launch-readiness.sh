#!/usr/bin/env bash
# errexit (-e) intentionally omitted: script tracks violations via counter and uses || true patterns
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBSITE_ROOT="${1:-/Users/eko3/massu-internal/website}"
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== Massu Launch Readiness Check ==="

# 1. MCP repo quality gates
echo "--- MCP Server Checks ---"
echo "Check 1: Pattern scanner"
bash "$REPO_ROOT/scripts/massu-pattern-scanner.sh" || FAILURES=$((FAILURES + 1))

echo "Check 2: Security scanner"
bash "$REPO_ROOT/scripts/massu-security-scanner.sh" || FAILURES=$((FAILURES + 1))

echo "Check 3: Type check"
(cd "$REPO_ROOT/packages/core" && npx tsc --noEmit) || FAILURES=$((FAILURES + 1))

echo "Check 4: Unit tests"
(cd "$REPO_ROOT" && npm test) || FAILURES=$((FAILURES + 1))

echo "Check 5: Integration tests"
(cd "$REPO_ROOT" && npm run test:integration) || FAILURES=$((FAILURES + 1))

echo "Check 6: Hook compilation"
(cd "$REPO_ROOT/packages/core" && npm run build:hooks) || FAILURES=$((FAILURES + 1))

echo "Check 7: Tooling self-test"
bash "$REPO_ROOT/scripts/massu-verify-tooling.sh" || FAILURES=$((FAILURES + 1))

echo "Check 8: npm audit (CR-9: ALL severities)"
(cd "$REPO_ROOT" && npm audit) || FAILURES=$((FAILURES + 1))

echo "Check 9: Git hooks installed"
if [ -f "$REPO_ROOT/.husky/pre-commit" ] && [ -f "$REPO_ROOT/.husky/pre-push" ]; then
  pass "Git hooks installed"
else
  fail "Git hooks not installed"
fi

# 10-12. Website checks (only if website repo exists)
if [ -d "$WEBSITE_ROOT" ]; then
  echo "--- Website Checks ---"
  echo "Check 10: Website integration tests"
  (cd "$WEBSITE_ROOT" && npx vitest run src/__tests__/integration/) || FAILURES=$((FAILURES + 1))

  echo "Check 11: Website type check"
  (cd "$WEBSITE_ROOT" && npx tsc --noEmit) || FAILURES=$((FAILURES + 1))

  echo "Check 12: npm audit (website, CR-9: ALL severities)"
  (cd "$WEBSITE_ROOT" && npm audit) || FAILURES=$((FAILURES + 1))
else
  echo "SKIP: Website repo not found at $WEBSITE_ROOT"
fi

# Summary
echo ""
echo "=== Launch Readiness Summary ==="
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}FAIL: $FAILURES check(s) failed - NOT ready for launch${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All checks passed - ready for launch${NC}"
  exit 0
fi

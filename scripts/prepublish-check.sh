#!/usr/bin/env bash
#
# prepublish-check.sh - Pre-publish validation for @massu/core
#
# Validates package metadata before npm publish.
# Exit 0 = PASS, Exit 1 = FAIL
#
# Usage: bash scripts/prepublish-check.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_ROOT/packages/core/package.json"
PKG_LICENSE="$REPO_ROOT/packages/core/LICENSE"
VIOLATIONS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }

echo "=== Massu Prepublish Check ==="
echo ""

# Check 1: Repository URL
echo "Check 1: Repository URL"
if grep -q 'massu-ai/massu' "$PKG_JSON"; then
  pass "Repository URL contains massu-ai/massu"
else
  fail "Repository URL does not contain massu-ai/massu"
fi

# Check 2: No old URLs
echo "Check 2: No old URLs"
if grep -q 'ethankowen-73/massu' "$PKG_JSON"; then
  fail "Old URL ethankowen-73/massu found in package.json"
else
  pass "No old URLs found"
fi

# Check 3: LICENSE exists
echo "Check 3: LICENSE file"
if [ -f "$PKG_LICENSE" ]; then
  pass "LICENSE file exists at packages/core/LICENSE"
else
  fail "LICENSE file missing at packages/core/LICENSE"
fi

# Check 4: types field
echo "Check 4: types field"
if grep -q '"types"' "$PKG_JSON"; then
  # types field exists - verify it points to a valid path
  TYPES_PATH=$(node -e "console.log(require('$PKG_JSON').types || '')" 2>/dev/null)
  if [ -n "$TYPES_PATH" ] && [ -f "$REPO_ROOT/packages/core/$TYPES_PATH" ]; then
    pass "types field points to valid path: $TYPES_PATH"
  else
    fail "types field points to invalid path: $TYPES_PATH"
  fi
else
  pass "types field absent (no .d.ts files shipped)"
fi

echo ""
if [ "$VIOLATIONS" -eq 0 ]; then
  echo -e "${GREEN}All prepublish checks passed${NC}"
  exit 0
else
  echo -e "${RED}$VIOLATIONS prepublish check(s) failed${NC}"
  exit 1
fi

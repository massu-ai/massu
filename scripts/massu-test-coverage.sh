#!/usr/bin/env bash
#
# massu-test-coverage.sh - Massu Test Coverage Gap Analysis
#
# Cross-references source modules against test files to find coverage gaps.
# Covers both packages/core/src/ and website/src/lib/.
# Exit 0 = >= 80% coverage, Exit 1 = < 80% coverage
#
# Usage: bash scripts/massu-test-coverage.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_SRC="$REPO_ROOT/packages/core/src"
CORE_TESTS="$REPO_ROOT/packages/core/src/__tests__"
WEBSITE_LIB="$REPO_ROOT/website/src/lib"
WEBSITE_TESTS="$REPO_ROOT/website/src/__tests__"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }
info() { echo -e "  ${BLUE}INFO${NC}: $1"; }

echo "=== Massu Test Coverage Gap Analysis ==="
echo ""

TOTAL_MODULES=0
TOTAL_COVERED=0

# -------------------------------------------------------
# Section 1: packages/core/src/ modules
# -------------------------------------------------------
echo "--- packages/core/src/ ---"
echo ""
printf "  %-40s %s\n" "MODULE" "TEST FILE"
printf "  %-40s %s\n" "------" "---------"

CORE_COVERED=0
CORE_TOTAL=0

if [ -d "$CORE_SRC" ]; then
  while IFS= read -r SRC_FILE; do
    BASE_NAME=$(basename "$SRC_FILE" .ts)
    CORE_TOTAL=$((CORE_TOTAL + 1))

    # Check for a matching test file (exact match)
    FOUND_TEST=""
    if [ -d "$CORE_TESTS" ]; then
      if [ -f "$CORE_TESTS/${BASE_NAME}.test.ts" ]; then
        FOUND_TEST="${BASE_NAME}.test.ts"
      fi
    fi

    if [ -n "$FOUND_TEST" ]; then
      CORE_COVERED=$((CORE_COVERED + 1))
      printf "  %-40s ${GREEN}%s${NC}\n" "$BASE_NAME.ts" "$FOUND_TEST"
    else
      printf "  %-40s ${RED}%s${NC}\n" "$BASE_NAME.ts" "MISSING"
    fi
  done < <(find "$CORE_SRC" -maxdepth 1 -name "*.ts" -type f \
    -not -name "*.d.ts" \
    | sort)
fi

echo ""
if [ "$CORE_TOTAL" -gt 0 ]; then
  CORE_PCT=$((CORE_COVERED * 100 / CORE_TOTAL))
  if [ "$CORE_PCT" -ge 80 ]; then
    pass "packages/core: $CORE_COVERED/$CORE_TOTAL modules covered ($CORE_PCT%)"
  elif [ "$CORE_PCT" -ge 50 ]; then
    warn "packages/core: $CORE_COVERED/$CORE_TOTAL modules covered ($CORE_PCT%)"
  else
    fail "packages/core: $CORE_COVERED/$CORE_TOTAL modules covered ($CORE_PCT%)"
  fi
else
  info "packages/core: No source modules found"
fi

TOTAL_MODULES=$((TOTAL_MODULES + CORE_TOTAL))
TOTAL_COVERED=$((TOTAL_COVERED + CORE_COVERED))

echo ""

# -------------------------------------------------------
# Section 2: website/src/lib/ modules
# -------------------------------------------------------
echo "--- website/src/lib/ ---"
echo ""
printf "  %-40s %s\n" "MODULE" "TEST FILE"
printf "  %-40s %s\n" "------" "---------"

WEB_COVERED=0
WEB_TOTAL=0

if [ -d "$WEBSITE_LIB" ]; then
  while IFS= read -r SRC_FILE; do
    BASE_NAME=$(basename "$SRC_FILE" .ts)
    WEB_TOTAL=$((WEB_TOTAL + 1))

    # Check for a matching test file
    FOUND_TEST=""
    if [ -d "$WEBSITE_TESTS" ]; then
      if [ -f "$WEBSITE_TESTS/${BASE_NAME}.test.ts" ]; then
        FOUND_TEST="${BASE_NAME}.test.ts"
      elif [ -f "$WEBSITE_TESTS/${BASE_NAME}.test.tsx" ]; then
        FOUND_TEST="${BASE_NAME}.test.tsx"
      fi
    fi

    if [ -n "$FOUND_TEST" ]; then
      WEB_COVERED=$((WEB_COVERED + 1))
      printf "  %-40s ${GREEN}%s${NC}\n" "$BASE_NAME.ts" "$FOUND_TEST"
    else
      printf "  %-40s ${RED}%s${NC}\n" "$BASE_NAME.ts" "MISSING"
    fi
  done < <(find "$WEBSITE_LIB" -maxdepth 1 -name "*.ts" -type f \
    -not -name "*.d.ts" \
    | sort)
fi

echo ""
if [ "$WEB_TOTAL" -gt 0 ]; then
  WEB_PCT=$((WEB_COVERED * 100 / WEB_TOTAL))
  if [ "$WEB_PCT" -ge 80 ]; then
    pass "website/src/lib: $WEB_COVERED/$WEB_TOTAL modules covered ($WEB_PCT%)"
  elif [ "$WEB_PCT" -ge 50 ]; then
    warn "website/src/lib: $WEB_COVERED/$WEB_TOTAL modules covered ($WEB_PCT%)"
  else
    fail "website/src/lib: $WEB_COVERED/$WEB_TOTAL modules covered ($WEB_PCT%)"
  fi
else
  info "website/src/lib: No source modules found"
fi

TOTAL_MODULES=$((TOTAL_MODULES + WEB_TOTAL))
TOTAL_COVERED=$((TOTAL_COVERED + WEB_COVERED))

echo ""

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo "=== Test Coverage Summary ==="
if [ "$TOTAL_MODULES" -gt 0 ]; then
  TOTAL_PCT=$((TOTAL_COVERED * 100 / TOTAL_MODULES))
  echo "  Total modules:  $TOTAL_MODULES"
  echo "  With tests:     $TOTAL_COVERED"
  echo "  Without tests:  $((TOTAL_MODULES - TOTAL_COVERED))"
  echo ""
  if [ "$TOTAL_PCT" -ge 80 ]; then
    echo -e "  ${GREEN}PASS: Overall coverage $TOTAL_PCT% (threshold: 80%)${NC}"
    exit 0
  elif [ "$TOTAL_PCT" -ge 50 ]; then
    echo -e "  ${YELLOW}WARN: Overall coverage $TOTAL_PCT% (threshold: 80%)${NC}"
    exit 1
  else
    echo -e "  ${RED}FAIL: Overall coverage $TOTAL_PCT% (threshold: 80%)${NC}"
    exit 1
  fi
else
  echo -e "  ${YELLOW}WARN: No source modules found to check${NC}"
  exit 0
fi

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
# Handles both top-level `types` AND nested `exports["./X"].types` (conditional
# exports introduced in Phase 9b commit chain — `./adapter` subpath ships
# `dist/adapter.d.ts`). Pre-9b semantics: substring match on `"types"` would
# false-positive on nested keys.
echo "Check 4: types field"
TOP_TYPES=$(node -e "console.log(require('$PKG_JSON').types || '')" 2>/dev/null)
NESTED_TYPES=$(node -e "
  const pkg = require('$PKG_JSON');
  const out = [];
  for (const [k, v] of Object.entries(pkg.exports || {})) {
    if (typeof v === 'object' && v !== null && v.types) out.push(k + ':' + v.types);
  }
  console.log(out.join('\n'));
" 2>/dev/null)
if [ -n "$TOP_TYPES" ]; then
  if [ -f "$REPO_ROOT/packages/core/$TOP_TYPES" ]; then
    pass "top-level types field points to valid path: $TOP_TYPES"
  else
    fail "top-level types field points to invalid path: $TOP_TYPES"
  fi
elif [ -n "$NESTED_TYPES" ]; then
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    KEY="${entry%%:*}"
    PATH_VAL="${entry#*:}"
    if [ -f "$REPO_ROOT/packages/core/$PATH_VAL" ]; then
      pass "exports[\"$KEY\"].types points to valid path: $PATH_VAL"
    else
      fail "exports[\"$KEY\"].types points to invalid path: $PATH_VAL"
    fi
  done <<< "$NESTED_TYPES"
else
  pass "types field absent (no .d.ts files shipped)"
fi

# Check 5 (P-E-006): Pattern scanner PASS
echo "Check 5: Pattern Scanner (P-E-006)"
if bash "$REPO_ROOT/scripts/massu-pattern-scanner.sh" >/dev/null 2>&1; then
  pass "All 25 pattern checks PASS"
else
  fail "Pattern scanner reported violations (run massu-pattern-scanner.sh for details)"
fi

# Check 6 (P-E-006): Tier-coverage + TOOL_DB_NEEDS completeness tests PASS
echo "Check 6: tier-coverage + tool-db-needs-completeness tests"
if (cd "$REPO_ROOT/packages/core" && npx vitest run tier-coverage tool-db-needs-completeness 2>&1 | tail -5 | grep -q "passed"); then
  pass "tier-coverage + tool-db-needs-completeness tests PASS"
else
  fail "tier-coverage or tool-db-needs-completeness tests FAIL (publish would ship a stale TOOL_DB_NEEDS manifest)"
fi

# Check 7 (P-E-006): .mcp.json pinned (no floating @massu/core)
echo "Check 7: .mcp.json pin"
if grep -qE '@massu/core@[0-9]+\.[0-9]+\.[0-9]+' "$REPO_ROOT/.mcp.json"; then
  pass ".mcp.json pins @massu/core to a specific version"
else
  fail ".mcp.json is missing a specific @massu/core version pin (would resolve to npm latest, drift class)"
fi

# Check 8 (P-E-006): dist/ included in package.json files
echo "Check 8: dist/ included in tarball"
DIST_INCLUDED=$(node -e "const p=require('$PKG_JSON'); console.log(p.files && p.files.some(f => f.startsWith('dist/')) ? 'yes' : 'no')" 2>/dev/null)
if [ "$DIST_INCLUDED" = "yes" ]; then
  pass "dist/ included in package.json files array"
else
  fail "dist/ NOT included in package.json files array (tarball would be source-only)"
fi

echo ""
if [ "$VIOLATIONS" -eq 0 ]; then
  echo -e "${GREEN}All prepublish checks passed${NC}"
  exit 0
else
  echo -e "${RED}$VIOLATIONS prepublish check(s) failed${NC}"
  exit 1
fi

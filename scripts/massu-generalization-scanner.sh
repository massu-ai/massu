#!/usr/bin/env bash
#
# massu-generalization-scanner.sh - Generalization Violation Checker
#
# Checks ALL shipped files for generalization violations:
#   1. "limn" references in shipped directories
#   2. Hardcoded /Users/ paths in source/commands/hooks
#   3. Hardcoded Supabase project IDs in source
#   4. Hardcoded API endpoints outside config in source
#
# Exit 0 = PASS (no violations), Exit 1 = FAIL (violations found)
#
# Usage: bash scripts/massu-generalization-scanner.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/packages/core/src"
VIOLATIONS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }

echo "=== Massu Generalization Scanner ==="
echo ""

# -------------------------------------------------------
# Exclusion list (P4-002)
# These directories/files are excluded from ALL checks:
#   - docs/plans/          (plan documents reference old names)
#   - docs/PLAN-*          (legacy plan docs)
#   - .claude/commands/massu-internal-feature-parity.md (parity tracking)
#   - .claude/commands/massu-parity.md (parity tracking)
#   - website/content/articles/ (author bios)
#   - .claude/session-state/ (transient session state)
#   - node_modules/        (third-party code)
#   - dist/                (compiled output)
#   - .git/                (git internals)
#   - docs/plans/2026-02-25-limn-parity-port.md (parity plan)
# -------------------------------------------------------

# Helper: build grep exclusion flags for common dirs
COMMON_EXCLUDES="--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git"

# -------------------------------------------------------
# Check 1: No "limn" references in shipped directories
# -------------------------------------------------------
echo "Check 1: No 'limn' references in shipped files"

LIMN_DIRS=""
for dir in scripts .claude/reference .claude/patterns .claude/protocols .claude/checklists .claude/playbooks .claude/agents .claude/commands; do
  [ -d "$REPO_ROOT/$dir" ] && LIMN_DIRS="$LIMN_DIRS $REPO_ROOT/$dir"
done

if [ -n "$LIMN_DIRS" ]; then
  # shellcheck disable=SC2086
  LIMN_COUNT=$(grep -rin "limn" $LIMN_DIRS \
    --include="*.sh" --include="*.md" --include="*.ts" --include="*.js" \
    --include="*.yaml" --include="*.json" --include="*.txt" \
    $COMMON_EXCLUDES \
    2>/dev/null \
    | grep -v "internal-feature-parity" \
    | grep -v "massu-parity" \
    | grep -v "session-state" \
    | grep -v "node_modules" \
    | grep -v "limn-parity-port" \
    | grep -v "massu-generalization-scanner\.sh" \
    | wc -l | tr -d ' ')
  if [ "$LIMN_COUNT" -gt 0 ]; then
    fail "Found $LIMN_COUNT 'limn' references in shipped directories"
    # shellcheck disable=SC2086
    grep -rin "limn" $LIMN_DIRS \
      --include="*.sh" --include="*.md" --include="*.ts" --include="*.js" \
      --include="*.yaml" --include="*.json" --include="*.txt" \
      $COMMON_EXCLUDES \
      2>/dev/null \
      | grep -v "internal-feature-parity" \
      | grep -v "massu-parity" \
      | grep -v "session-state" \
      | grep -v "node_modules" \
      | grep -v "limn-parity-port" \
      | grep -v "massu-generalization-scanner\.sh" \
      | head -10
  else
    pass "No 'limn' references found in shipped directories"
  fi
else
  warn "No shipped directories found to check"
fi

# -------------------------------------------------------
# Check 2: No hardcoded /Users/ paths in source
# -------------------------------------------------------
echo "Check 2: No hardcoded /Users/ paths in source"

USERS_DIRS=""
for dir in packages/core/src .claude/commands scripts/hooks; do
  [ -d "$REPO_ROOT/$dir" ] && USERS_DIRS="$USERS_DIRS $REPO_ROOT/$dir"
done

if [ -n "$USERS_DIRS" ]; then
  # shellcheck disable=SC2086
  USERS_COUNT=$(grep -rn "/Users/" $USERS_DIRS \
    --include="*.ts" --include="*.sh" --include="*.md" \
    $COMMON_EXCLUDES \
    2>/dev/null \
    | grep -v "internal-feature-parity" \
    | grep -v "massu-parity" \
    | grep -v "session-state" \
    | grep -v "node_modules" \
    | grep -v '__tests__' \
    | grep -v '\.test\.ts:' \
    | grep -v '// .*Convert.*cwd\|// .*format:' \
    | grep -v 'massu-generalization-scanner' \
    | grep -v 'massu-push-light' \
    | wc -l | tr -d ' ')
  if [ "$USERS_COUNT" -gt 0 ]; then
    fail "Found $USERS_COUNT hardcoded /Users/ paths in source"
    # shellcheck disable=SC2086
    grep -rn "/Users/" $USERS_DIRS \
      --include="*.ts" --include="*.sh" --include="*.md" \
      $COMMON_EXCLUDES \
      2>/dev/null \
      | grep -v "internal-feature-parity" \
      | grep -v "massu-parity" \
      | grep -v "session-state" \
      | grep -v "node_modules" \
      | grep -v '__tests__' \
      | grep -v '\.test\.ts:' \
      | grep -v '// .*Convert.*cwd\|// .*format:' \
      | grep -v 'massu-generalization-scanner' \
      | grep -v 'massu-push-light' \
      | head -10
  else
    pass "No hardcoded /Users/ paths found"
  fi
else
  warn "No source directories found to check for /Users/ paths"
fi

# -------------------------------------------------------
# Check 3: No hardcoded Supabase project IDs in source
# (Optional - warn only)
# -------------------------------------------------------
echo "Check 3: No hardcoded Supabase project IDs in source"

if [ -d "$SRC_DIR" ]; then
  SUPABASE_COUNT=$(grep -rn "supabase\.co" "$SRC_DIR" \
    --include="*.ts" --include="*.js" \
    $COMMON_EXCLUDES \
    2>/dev/null \
    | grep -v '__tests__' \
    | grep -v '\.test\.ts:' \
    | grep -v 'node_modules' \
    | grep -v 'process\.env' \
    | grep -v 'getConfig' \
    | wc -l | tr -d ' ')
  if [ "$SUPABASE_COUNT" -gt 0 ]; then
    warn "Found $SUPABASE_COUNT hardcoded supabase.co references in source (should use config)"
    grep -rn "supabase\.co" "$SRC_DIR" \
      --include="*.ts" --include="*.js" \
      $COMMON_EXCLUDES \
      2>/dev/null \
      | grep -v '__tests__' \
      | grep -v '\.test\.ts:' \
      | grep -v 'node_modules' \
      | grep -v 'process\.env' \
      | grep -v 'getConfig' \
      | head -5
  else
    pass "No hardcoded Supabase project IDs found"
  fi
else
  warn "Source directory not found: $SRC_DIR"
fi

# -------------------------------------------------------
# Check 4: No hardcoded API endpoints outside config
# -------------------------------------------------------
echo "Check 4: No hardcoded API endpoints outside config in source"

if [ -d "$SRC_DIR" ]; then
  # Look for hardcoded URLs (http:// or https://) that aren't in config.ts or tests
  API_COUNT=$(grep -rn 'https\?://[a-zA-Z0-9]' "$SRC_DIR" \
    --include="*.ts" --include="*.js" \
    $COMMON_EXCLUDES \
    2>/dev/null \
    | grep -v '__tests__' \
    | grep -v '\.test\.ts:' \
    | grep -v 'node_modules' \
    | grep -v 'config\.ts' \
    | grep -v '// ' \
    | grep -v 'localhost' \
    | grep -v 'example\.com' \
    | grep -v 'schema\.org' \
    | grep -v 'json-schema' \
    | grep -v 'npmjs\.com\|npm\.org' \
    | grep -v 'github\.com' \
    | grep -v 'getConfig' \
    | grep -v 'process\.env' \
    | wc -l | tr -d ' ')
  if [ "$API_COUNT" -gt 0 ]; then
    warn "Found $API_COUNT potential hardcoded API endpoints in source (should use config)"
    grep -rn 'https\?://[a-zA-Z0-9]' "$SRC_DIR" \
      --include="*.ts" --include="*.js" \
      $COMMON_EXCLUDES \
      2>/dev/null \
      | grep -v '__tests__' \
      | grep -v '\.test\.ts:' \
      | grep -v 'node_modules' \
      | grep -v 'config\.ts' \
      | grep -v '// ' \
      | grep -v 'localhost' \
      | grep -v 'example\.com' \
      | grep -v 'schema\.org' \
      | grep -v 'json-schema' \
      | grep -v 'npmjs\.com\|npm\.org' \
      | grep -v 'github\.com' \
      | grep -v 'getConfig' \
      | grep -v 'process\.env' \
      | head -5
  else
    pass "No hardcoded API endpoints found"
  fi
else
  warn "Source directory not found: $SRC_DIR"
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo "=== Generalization Scanner Summary ==="
echo "  Checked: 'limn' refs, /Users/ paths, Supabase IDs, API endpoints"
echo "  Excluded: docs/plans/, session-state/, node_modules/, dist/, .git/"
echo "            internal-feature-parity, massu-parity, limn-parity-port"
if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}FAIL: $VIOLATIONS violation(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All generalization checks passed${NC}"
  exit 0
fi

#!/usr/bin/env bash
#
# massu-pattern-scanner.sh - Massu Pattern Compliance Checker
#
# Checks for coding pattern violations in the Massu codebase.
# Exit 0 = PASS (no violations), Exit 1 = FAIL (violations found)
#
# Usage: bash scripts/massu-pattern-scanner.sh [--quick]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/packages/core/src"
VIOLATIONS=0
QUICK_MODE="${1:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }

echo "=== Massu Pattern Scanner ==="
echo ""

# -------------------------------------------------------
# Check 1: No require() in source (ESM only)
# Excludes: hooks/ (bundled by esbuild, require is valid)
# -------------------------------------------------------
echo "Check 1: No require() in source files"
REQUIRE_COUNT=$(grep -rn 'require(' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '// require' \
  | grep -v '\.test\.ts:' \
  | grep -v 'hooks/' \
  | wc -l | tr -d ' ')
if [ "$REQUIRE_COUNT" -gt 0 ]; then
  fail "Found $REQUIRE_COUNT require() calls in src/ (use ESM imports)"
  grep -rn 'require(' "$SRC_DIR" --include="*.ts" \
    | grep -v '__tests__' | grep -v 'node_modules' | grep -v '\.test\.ts:' | grep -v 'hooks/' \
    | head -5
else
  pass "No require() calls found"
fi

# -------------------------------------------------------
# Check 2: No hardcoded tool prefixes (should use getConfig().toolPrefix)
# Detects string literals like 'massu_ or "massu_ that indicate hardcoded prefixes
# -------------------------------------------------------
echo "Check 2: No hardcoded tool prefixes in source"
HARDCODED_PREFIX_COUNT=$(grep -rn "'massu_\|\"massu_" "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | grep -v '// ' \
  | wc -l | tr -d ' ')
if [ "$HARDCODED_PREFIX_COUNT" -gt 0 ]; then
  warn "Found $HARDCODED_PREFIX_COUNT hardcoded tool prefix references (should use getConfig().toolPrefix)"
  grep -rn "'massu_\|\"massu_" "$SRC_DIR" --include="*.ts" \
    | grep -v '__tests__' | grep -v 'node_modules' | grep -v '\.test\.ts:' \
    | head -5
else
  pass "No hardcoded tool prefixes found"
fi

# -------------------------------------------------------
# Check 3: No process.exit() in library code
# Excludes: server.ts (entrypoint), hooks/ (standalone scripts),
#           *-runner.ts (standalone CLI scripts), cli.ts (CLI entry),
#           commands/ (CLI commands that need exit codes)
# -------------------------------------------------------
echo "Check 3: No process.exit() in library code"
PROCESS_EXIT_COUNT=$(grep -rn 'process\.exit' "$SRC_DIR" --include="*.ts" \
  | grep -v 'server\.ts' \
  | grep -v '__tests__' \
  | grep -v '\.test\.ts:' \
  | grep -v 'node_modules' \
  | grep -v 'hooks/' \
  | grep -v '\-runner\.ts' \
  | grep -v 'backfill-' \
  | grep -v 'cli\.ts' \
  | grep -v 'commands/' \
  | wc -l | tr -d ' ')
if [ "$PROCESS_EXIT_COUNT" -gt 0 ]; then
  fail "Found $PROCESS_EXIT_COUNT process.exit() calls in library code"
  grep -rn 'process\.exit' "$SRC_DIR" --include="*.ts" \
    | grep -v 'server\.ts' | grep -v '__tests__' | grep -v 'hooks/' | grep -v '\-runner\.ts' | grep -v 'backfill-' \
    | grep -v 'cli\.ts' | grep -v 'commands/' \
    | head -5
else
  pass "No process.exit() in library code"
fi

# -------------------------------------------------------
# Check 4: ESM exports only (no module.exports)
# -------------------------------------------------------
echo "Check 4: No module.exports in source"
MODULE_EXPORTS_COUNT=$(grep -rn 'module\.exports' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | wc -l | tr -d ' ')
if [ "$MODULE_EXPORTS_COUNT" -gt 0 ]; then
  fail "Found $MODULE_EXPORTS_COUNT module.exports (use ESM export)"
  grep -rn 'module\.exports' "$SRC_DIR" --include="*.ts" | grep -v '__tests__' | head -5
else
  pass "No module.exports found"
fi

# -------------------------------------------------------
# Check 5: Config via getConfig() only (no direct yaml.parse)
# Excludes: commands/doctor.ts (diagnostic tool that intentionally
#           parses YAML to verify config integrity before getConfig())
# -------------------------------------------------------
echo "Check 5: Config access via getConfig() only"
YAML_PARSE_COUNT=$(grep -rn 'yaml\.parse\|parseYaml\|parse.*yaml' "$SRC_DIR" --include="*.ts" \
  | grep -v 'config\.ts' \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | grep -v 'commands/doctor\.ts' \
  | wc -l | tr -d ' ')
if [ "$YAML_PARSE_COUNT" -gt 0 ]; then
  fail "Found $YAML_PARSE_COUNT direct YAML parse calls outside config.ts (use getConfig())"
  grep -rn 'yaml\.parse\|parseYaml' "$SRC_DIR" --include="*.ts" | grep -v 'config\.ts' | grep -v '__tests__' | grep -v 'commands/doctor\.ts' | head -5
else
  pass "Config access via getConfig() only"
fi

# -------------------------------------------------------
# Check 6: `as any` count below threshold
# -------------------------------------------------------
echo "Check 6: 'as any' usage below threshold"
AS_ANY_THRESHOLD=20
AS_ANY_COUNT=$(grep -rn 'as any' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v '\.test\.ts:' \
  | wc -l | tr -d ' ')
if [ "$AS_ANY_COUNT" -gt "$AS_ANY_THRESHOLD" ]; then
  fail "Found $AS_ANY_COUNT 'as any' casts (threshold: $AS_ANY_THRESHOLD)"
else
  pass "'as any' count ($AS_ANY_COUNT) within threshold ($AS_ANY_THRESHOLD)"
fi

# -------------------------------------------------------
# Check 7: Test files in __tests__/ directories
# -------------------------------------------------------
echo "Check 7: Test files in __tests__/ directories"
MISPLACED_TESTS=$(find "$SRC_DIR" -name "*.test.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$MISPLACED_TESTS" -gt 0 ]; then
  fail "Found $MISPLACED_TESTS test files outside __tests__/ directories"
  find "$SRC_DIR" -name "*.test.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*" | head -5
else
  pass "All test files in __tests__/ directories"
fi

# -------------------------------------------------------
# Check 8: No secrets in source
# Excludes: regex patterns that reference secret keywords
#           for redaction/detection purposes
# -------------------------------------------------------
echo "Check 8: No hardcoded secrets in source"
SECRETS_COUNT=$(grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' "$SRC_DIR" --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v 'process\.env' \
  | grep -v '\.test\.ts:' \
  | grep -v '\.replace(' \
  | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask' \
  | wc -l | tr -d ' ')
if [ "$SECRETS_COUNT" -gt 0 ]; then
  fail "Found $SECRETS_COUNT potential hardcoded secrets"
  grep -rn 'sk-[a-zA-Z0-9]\{20,\}\|password.*=.*["\x27][^"\x27]\{8,\}' "$SRC_DIR" --include="*.ts" \
    | grep -v '__tests__' | grep -v 'process\.env' | grep -v '\.replace(' \
    | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask' \
    | head -5
else
  pass "No hardcoded secrets found"
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo "=== Pattern Scanner Summary ==="
if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}FAIL: $VIOLATIONS violation(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All pattern checks passed${NC}"
  exit 0
fi

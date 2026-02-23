#!/usr/bin/env bash
#
# massu-verify-tooling.sh - Verify that all massu verification tools work
#
# Exit 0 = all tools functional, Exit 1 = broken tools found
# errexit (-e) intentionally omitted: script tracks violations via counter and uses || true patterns
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== Massu Tooling Self-Test ==="

# 1. All shell scripts have set -uo pipefail (or set -euo pipefail)
echo "Check 1: Shell scripts have strict mode"
for SCRIPT in "$REPO_ROOT"/scripts/massu-*.sh; do
  if ! grep -q 'set -[eu]*o pipefail' "$SCRIPT" 2>/dev/null; then
    fail "Missing strict mode: $(basename "$SCRIPT")"
  fi
done
[ "$FAILURES" -eq 0 ] && pass "All scripts have strict mode"

# 2. All command files have valid YAML frontmatter (--- on line 1 and line N)
echo "Check 2: Command files have YAML frontmatter"
PREV_FAILURES=$FAILURES
for CMD in "$REPO_ROOT"/.claude/commands/massu-*.md; do
  FIRST_LINE=$(head -1 "$CMD")
  if [ "$FIRST_LINE" != "---" ]; then
    fail "Missing frontmatter: $(basename "$CMD")"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All commands have frontmatter"

# 3. No duplicate name: fields in command files
echo "Check 3: No duplicate name: fields"
PREV_FAILURES=$FAILURES
for CMD in "$REPO_ROOT"/.claude/commands/massu-*.md; do
  COUNT=$(grep -c '^name:' "$CMD" 2>/dev/null)
  if [ "$COUNT" -gt 1 ]; then
    fail "Duplicate name: in $(basename "$CMD")"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "No duplicate name: fields"

# 4. All referenced directories exist
echo "Check 4: Referenced directories exist"
PREV_FAILURES=$FAILURES
for DIR in .claude/patterns .claude/incidents .claude/benchmarks .claude/session-state; do
  if [ ! -d "$REPO_ROOT/$DIR" ]; then
    fail "Missing directory: $DIR"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All referenced directories exist"

# 5. All referenced scripts exist
echo "Check 5: Referenced scripts exist"
PREV_FAILURES=$FAILURES
for SCRIPT in massu-pattern-scanner.sh massu-security-scanner.sh massu-verify-tooling.sh; do
  if [ ! -f "$REPO_ROOT/scripts/$SCRIPT" ]; then
    fail "Missing script: scripts/$SCRIPT"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All referenced scripts exist"

# 6. No grep -oP (GNU-only) in shell scripts
echo "Check 6: No GNU-only grep flags in shell scripts"
PREV_FAILURES=$FAILURES
GNU_GREP=$(grep -rn 'grep -[a-zA-Z]*oP\|grep -[a-zA-Z]*P ' "$REPO_ROOT"/scripts/*.sh 2>/dev/null | grep -v 'massu-verify-tooling.sh' | wc -l | tr -d ' ')
if [ "$GNU_GREP" -gt 0 ]; then
  fail "Found $GNU_GREP grep -P (GNU-only) usages in shell scripts"
else
  pass "No GNU-only grep flags in shell scripts"
fi

# 7. All CR-N references in commands resolve to CLAUDE.md
echo "Check 7: All CR-N references resolve"
PREV_FAILURES=$FAILURES
CR_REFS=$(grep -oh 'CR-[0-9]*' "$REPO_ROOT"/.claude/commands/*.md 2>/dev/null | sort -u)
for CR in $CR_REFS; do
  if ! grep -q "$CR" "$REPO_ROOT/.claude/CLAUDE.md" 2>/dev/null; then
    fail "Unresolved reference: $CR"
  fi
done
[ "$FAILURES" -eq "$PREV_FAILURES" ] && pass "All CR-N references resolve"

echo ""
echo "=== Tooling Self-Test Summary ==="
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}FAIL: $FAILURES issue(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All tooling checks passed${NC}"
  exit 0
fi

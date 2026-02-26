#!/bin/bash
# CLAUDE.md Structure Enforcement Script
# Checks for code blocks that are too long and verifies external references
# Run: ./scripts/check-claude-md-structure.sh

set -e

CLAUDE_MD="/Users/eko3/massu-internal/.claude/CLAUDE.md"
MAX_CODE_BLOCK_LINES=10
FAILED=0

echo "=============================================="
echo "CLAUDE.md Structure Check"
echo "=============================================="

# Check 1: Code blocks > MAX_CODE_BLOCK_LINES lines
echo ""
echo "[1/3] Checking for oversized code blocks (max $MAX_CODE_BLOCK_LINES lines)..."

# Extract code blocks and count lines
OVERSIZED=$(awk '
  /^```/ { in_block = !in_block; if (in_block) { lines = 0; start = NR } else { if (lines > '$MAX_CODE_BLOCK_LINES') print "Line " start ": " lines " lines" } next }
  in_block { lines++ }
' "$CLAUDE_MD")

if [ -n "$OVERSIZED" ]; then
  echo "  [WARN] Found oversized code blocks:"
  echo "$OVERSIZED" | while read line; do echo "    $line"; done
  echo "  Move these to pattern files and reference them."
  FAILED=1
else
  echo "  [PASS] All code blocks are $MAX_CODE_BLOCK_LINES lines or fewer"
fi

# Check 2: "See below" references without corresponding sections
echo ""
echo "[2/3] Checking for orphaned 'See below' references..."

SEE_BELOW_COUNT=$(grep -c "See below" "$CLAUDE_MD" 2>/dev/null || echo 0)
SEE_BELOW_COUNT=$(echo "$SEE_BELOW_COUNT" | tr -d '[:space:]')
if [ "$SEE_BELOW_COUNT" -gt 0 ] 2>/dev/null; then
  echo "  [WARN] Found $SEE_BELOW_COUNT 'See below' references"
  echo "  These should be replaced with links to external files."
  echo "  Pattern: 'See [patterns/file.md](patterns/file.md)'"
  FAILED=1
else
  echo "  [PASS] No 'See below' references found"
fi

# Check 3: Verify referenced files exist
echo ""
echo "[3/3] Checking that referenced pattern files exist..."

MISSING_FILES=""
while IFS= read -r ref; do
  # Extract file path from markdown links like [text](path)
  filepath=$(echo "$ref" | grep -oP '\]\([^)]+\.md' | sed 's/\](//' | head -1)
  if [ -n "$filepath" ]; then
    # Handle relative paths
    if [[ "$filepath" != /* ]]; then
      fullpath="/Users/eko3/massu-internal/.claude/$filepath"
    else
      fullpath="$filepath"
    fi
    if [ ! -f "$fullpath" ]; then
      MISSING_FILES="$MISSING_FILES\n  - $filepath"
    fi
  fi
done < <(grep -oP '\[[^\]]+\]\([^)]+\.md[^)]*\)' "$CLAUDE_MD" 2>/dev/null || true)

if [ -n "$MISSING_FILES" ]; then
  echo "  [WARN] Missing referenced files:$MISSING_FILES"
  FAILED=1
else
  echo "  [PASS] All referenced files exist"
fi

echo ""
echo "=============================================="
if [ "$FAILED" -eq 0 ]; then
  echo "[PASS] CLAUDE.md structure is correct"
  exit 0
else
  echo "[WARN] CLAUDE.md has structure issues (warnings above)"
  echo "These are warnings, not blocking errors."
  exit 0  # Don't block commits, just warn
fi

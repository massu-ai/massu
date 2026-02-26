#!/bin/bash
# CLAUDE.md Size Enforcement Script
# Prevents CLAUDE.md from growing beyond the size limit
# Run: ./scripts/check-claude-md-size.sh

set -e

MAX_SIZE=35000
CLAUDE_MD="/Users/eko3/massu-internal/.claude/CLAUDE.md"

# Check if file exists
if [ ! -f "$CLAUDE_MD" ]; then
  echo "[ERROR] CLAUDE.md not found at $CLAUDE_MD"
  exit 1
fi

CURRENT_SIZE=$(wc -c < "$CLAUDE_MD" | tr -d ' ')

echo "=============================================="
echo "CLAUDE.md Size Check"
echo "=============================================="
echo "Current size: $CURRENT_SIZE chars"
echo "Maximum size: $MAX_SIZE chars"

if [ "$CURRENT_SIZE" -gt "$MAX_SIZE" ]; then
  OVERAGE=$((CURRENT_SIZE - MAX_SIZE))
  echo ""
  echo "[FAIL] CLAUDE.md is too large!"
  echo "  Overage: $OVERAGE chars"
  echo ""
  echo "To fix, move detailed content to pattern files:"
  echo "  - CR explanations -> .claude/patterns/build-patterns.md"
  echo "  - Security rules -> .claude/patterns/security-patterns.md"
  echo "  - Verification details -> .claude/protocols/verification.md"
  echo ""
  echo "CLAUDE.md should contain:"
  echo "  - Rule tables with links"
  echo "  - One-line summaries"
  echo "  - NO code examples > 5 lines"
  exit 1
fi

HEADROOM=$((MAX_SIZE - CURRENT_SIZE))
echo "Headroom: $HEADROOM chars"
echo ""
echo "[PASS] CLAUDE.md size is within limits"

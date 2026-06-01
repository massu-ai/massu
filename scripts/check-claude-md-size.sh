#!/bin/bash
# CLAUDE.md Size Enforcement Script
# Prevents CLAUDE.md from growing beyond the size limit
# Run: ./scripts/check-claude-md-size.sh

set -e

# Budget re-baselined from 35000 by plan-2026-06-01-claude-md-size-compliance
# (option iii HYBRID). After moving the 16 `### CR-NN:` detail bodies to
# .claude/reference/canonical-rules-detail.md (scripts/claude-md-autosplit.sh),
# the lean-but-realistic core measures ~52KB (the inline CR/VR summary tables,
# the Workflow Commands inventory, and the Massu Development Patterns examples
# are the immovable floor). 55000 reflects that measured floor plus modest
# headroom — within the plan A-001 "~50–55 KB" justified-cap range. To reduce
# further, run: bash scripts/claude-md-autosplit.sh
MAX_SIZE=55000
# Resolve repo root via git so the script is portable across machines / usernames.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "[ERROR] Not inside a git repository — run this script from a Massu checkout"
  exit 1
fi
CLAUDE_MD="$REPO_ROOT/.claude/CLAUDE.md"

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
  echo "REMEDY: move the longform '### CR-NN:' detail bodies to the on-demand"
  echo "reference file by running:"
  echo "  bash scripts/claude-md-autosplit.sh --dry-run   # preview projected size"
  echo "  bash scripts/claude-md-autosplit.sh             # apply the move"
  echo ""
  echo "CLAUDE.md should contain:"
  echo "  - The canonical CR/VR summary tables (one line each)"
  echo "  - One-line pointers to .claude/reference/canonical-rules-detail.md"
  echo "  - NO longform per-rule prose (that lives in the reference file)"
  exit 1
fi

HEADROOM=$((MAX_SIZE - CURRENT_SIZE))
echo "Headroom: $HEADROOM chars"
echo ""
echo "[PASS] CLAUDE.md size is within limits"

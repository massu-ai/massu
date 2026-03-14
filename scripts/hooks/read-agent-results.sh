#!/usr/bin/env bash
# read-agent-results.sh — Read latest agent results for recovery after context overflow
# Usage: bash scripts/hooks/read-agent-results.sh [--latest N]
#
# Reads JSON files from .massu/agent-results/ and prints a summary.
# Used to recover verification state when a parent session crashes.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
RESULTS_DIR="$PROJECT_DIR/.massu/agent-results"
LATEST=${1:-5}

if [ ! -d "$RESULTS_DIR" ]; then
  echo "No agent results directory found: $RESULTS_DIR"
  exit 0
fi

JSON_FILES=$(find "$RESULTS_DIR" -name '*.json' -type f 2>/dev/null | sort -r | head -"$LATEST")

if [ -z "$JSON_FILES" ]; then
  echo "No agent result files found in $RESULTS_DIR"
  exit 0
fi

echo "========================================"
echo "  Agent Results Summary (latest $LATEST)"
echo "========================================"
echo ""

for FILE in $JSON_FILES; do
  BASENAME=$(basename "$FILE")
  echo "--- $BASENAME ---"

  if command -v jq &>/dev/null; then
    ITERATION=$(jq -r '.iteration // "?"' "$FILE" 2>/dev/null)
    GAPS_DISCOVERED=$(jq -r '.gaps_discovered // "?"' "$FILE" 2>/dev/null)
    GAPS_FIXED=$(jq -r '.gaps_fixed // "?"' "$FILE" 2>/dev/null)
    GAPS_REMAINING=$(jq -r '.gaps_remaining // "?"' "$FILE" 2>/dev/null)
    ITEMS_TOTAL=$(jq -r '.plan_items_total // "?"' "$FILE" 2>/dev/null)
    ITEMS_VERIFIED=$(jq -r '.plan_items_verified // "?"' "$FILE" 2>/dev/null)

    echo "  Iteration: $ITERATION"
    echo "  Gaps: discovered=$GAPS_DISCOVERED fixed=$GAPS_FIXED remaining=$GAPS_REMAINING"
    echo "  Plan items: $ITEMS_VERIFIED/$ITEMS_TOTAL verified"

    FINDINGS_COUNT=$(jq -r '.findings | length // 0' "$FILE" 2>/dev/null || echo "0")
    if [ "$FINDINGS_COUNT" -gt 0 ]; then
      echo "  Findings ($FINDINGS_COUNT):"
      jq -r '.findings[] | "    - \(.)"' "$FILE" 2>/dev/null || true
    fi
  else
    cat "$FILE"
  fi
  echo ""
done

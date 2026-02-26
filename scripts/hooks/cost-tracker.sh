#!/bin/bash
# =============================================================================
# Cost Tracking Status Line
# =============================================================================
# Purpose: Display session cost, duration, and context usage in Claude Code
#          status line. Reads cost/token data from stdin JSON provided by
#          Claude Code's status line API.
#
# Usage: Configure as statusLine in .claude/settings.json
#        The script receives JSON on stdin with cost and context data.
#
# Massu cost tracking hook
# =============================================================================

# --- Require jq ---
command -v jq >/dev/null 2>&1 || { echo "no jq"; exit 0; }

input=$(cat)

# Extract cost data
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
DURATION_MS=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')
API_DURATION_MS=$(echo "$input" | jq -r '.cost.total_api_duration_ms // 0')

# Extract context window data
INPUT_TOKENS=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
OUTPUT_TOKENS=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
CTX_PERCENT=$(echo "$input" | jq -r '.context_window.used_percentage // 0')

# Format cost
COST_FMT=$(printf '$%.2f' "$COST")

# Format duration
DURATION_SEC=$((DURATION_MS / 1000))
MINS=$((DURATION_SEC / 60))
SECS=$((DURATION_SEC % 60))

# Format API duration
API_SEC=$((API_DURATION_MS / 1000))

# Format tokens (K units)
if [ "$INPUT_TOKENS" -gt 1000 ]; then
  IN_FMT="$((INPUT_TOKENS / 1000))K"
else
  IN_FMT="$INPUT_TOKENS"
fi

if [ "$OUTPUT_TOKENS" -gt 1000 ]; then
  OUT_FMT="$((OUTPUT_TOKENS / 1000))K"
else
  OUT_FMT="$OUTPUT_TOKENS"
fi

# Detect if in a massu-loop pass (check circuit breaker state)
PASS_INFO=""
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
CB_FILE="${PROJECT_ROOT}/.claude/loop-state/circuit-breaker.json"
if [ -f "$CB_FILE" ]; then
  PASS=$(jq -r '.pass_count // empty' "$CB_FILE" 2>/dev/null)
  MAX=${MAX_PASSES:-10}
  if [ -n "$PASS" ]; then
    PASS_INFO=" | Pass $PASS/$MAX"
  fi
fi

# Context warning
CTX_WARN=""
CTX_INT=${CTX_PERCENT%.*}
if [ "$CTX_INT" -gt 80 ] 2>/dev/null; then
  CTX_WARN=" [!CTX]"
fi

# Output status line
echo "${COST_FMT} | ${MINS}m${SECS}s (API: ${API_SEC}s) | In:${IN_FMT} Out:${OUT_FMT} | Ctx:${CTX_PERCENT}%${CTX_WARN}${PASS_INFO}"

exit 0

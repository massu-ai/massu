#!/bin/bash
# =============================================================================
# Loop Circuit Breaker
# =============================================================================
# Purpose: Detect stagnation in massu-loop passes by tracking file changes
#          and build errors across iterations. Emits warnings when the loop
#          appears stuck (no progress or same errors repeating).
#
# Usage: bash scripts/hooks/loop-circuit-breaker.sh --pass N
#
# Exit codes:
#   0 = CONTINUE (progress detected or first pass)
#   0 = WARNING emitted to stdout (still continues, never halts)
#
# State directory: .claude/loop-state/
#
# Massu loop circuit breaker hook
# =============================================================================

# --- Require jq ---
command -v jq >/dev/null 2>&1 || exit 0

STATE_DIR=".claude/loop-state"
mkdir -p "$STATE_DIR"

# Configurable thresholds
NO_PROGRESS_THRESHOLD=${NO_PROGRESS_THRESHOLD:-3}
SAME_ERROR_THRESHOLD=${SAME_ERROR_THRESHOLD:-3}
MAX_PASSES=${MAX_PASSES:-10}

# Parse arguments
PASS_NUM=""
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --pass) PASS_NUM="$2"; shift ;;
        --reset) rm -f "$STATE_DIR"/pass-* "$STATE_DIR"/circuit-breaker.json; echo "Circuit breaker state reset."; exit 0 ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

if [ -z "$PASS_NUM" ]; then
    echo "Usage: loop-circuit-breaker.sh --pass N"
    exit 1
fi

# Validate PASS_NUM is a positive integer
case "$PASS_NUM" in
    ''|*[!0-9]*) echo "Error: --pass must be a positive integer, got '$PASS_NUM'"; exit 1 ;;
esac

# Clean up state files older than 24 hours
find "$STATE_DIR" -name "pass-*" -mmin +1440 -delete 2>/dev/null || true

# Record current state
git diff --stat > "$STATE_DIR/pass-${PASS_NUM}-diff.txt" 2>/dev/null || true

# Capture current build/type errors (lightweight check via git diff)
# Avoid full tsc --noEmit here as it can take 30+ seconds on large codebases
git diff --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' | head -20 > "$STATE_DIR/pass-${PASS_NUM}-errors.txt" 2>/dev/null || true

# Read or initialize circuit breaker state
CB_FILE="$STATE_DIR/circuit-breaker.json"
if [ -f "$CB_FILE" ]; then
    NO_PROGRESS_COUNT=$(jq -r '.no_progress_count // 0' "$CB_FILE")
    SAME_ERROR_COUNT=$(jq -r '.same_error_count // 0' "$CB_FILE")
else
    NO_PROGRESS_COUNT=0
    SAME_ERROR_COUNT=0
fi

# --- Stagnation Detection: No file changes ---
if [ "$PASS_NUM" -gt 1 ]; then
    PREV_PASS=$((PASS_NUM - 1))
    PREV_DIFF="$STATE_DIR/pass-${PREV_PASS}-diff.txt"
    CURR_DIFF="$STATE_DIR/pass-${PASS_NUM}-diff.txt"

    if [ -f "$PREV_DIFF" ] && [ -f "$CURR_DIFF" ]; then
        if diff -q "$PREV_DIFF" "$CURR_DIFF" > /dev/null 2>&1; then
            # No change between passes
            NO_PROGRESS_COUNT=$((NO_PROGRESS_COUNT + 1))
        else
            NO_PROGRESS_COUNT=0
        fi
    fi
fi

# --- Same Error Detection ---
if [ "$PASS_NUM" -gt 1 ]; then
    PREV_PASS=$((PASS_NUM - 1))
    PREV_ERRORS="$STATE_DIR/pass-${PREV_PASS}-errors.txt"
    CURR_ERRORS="$STATE_DIR/pass-${PASS_NUM}-errors.txt"

    if [ -f "$PREV_ERRORS" ] && [ -f "$CURR_ERRORS" ]; then
        # Compare file change signatures (sorted list of changed files)
        PREV_SIG=$(sort "$PREV_ERRORS" 2>/dev/null | md5 2>/dev/null || sort "$PREV_ERRORS" 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1)
        CURR_SIG=$(sort "$CURR_ERRORS" 2>/dev/null | md5 2>/dev/null || sort "$CURR_ERRORS" 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1)

        if [ "$PREV_SIG" = "$CURR_SIG" ] && [ -n "$PREV_SIG" ]; then
            SAME_ERROR_COUNT=$((SAME_ERROR_COUNT + 1))
        else
            SAME_ERROR_COUNT=0
        fi
    fi
fi

# Save updated state
cat > "$CB_FILE" << EOF
{
  "pass_count": $PASS_NUM,
  "no_progress_count": $NO_PROGRESS_COUNT,
  "same_error_count": $SAME_ERROR_COUNT,
  "status": "active",
  "last_updated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# --- Emit Warnings ---
STATUS="CONTINUE"

if [ "$NO_PROGRESS_COUNT" -ge "$NO_PROGRESS_THRESHOLD" ]; then
    echo ""
    echo "============================================"
    echo "CIRCUIT BREAKER WARNING: STAGNATION DETECTED"
    echo "============================================"
    echo "$NO_PROGRESS_COUNT consecutive passes with no file changes."
    echo "The loop may be stuck retrying the same approach."
    echo "Consider a different approach or ask the user for guidance."
    echo "============================================"
    echo ""
    STATUS="STAGNATION_WARNING"
fi

if [ "$SAME_ERROR_COUNT" -ge "$SAME_ERROR_THRESHOLD" ]; then
    echo ""
    echo "============================================"
    echo "CIRCUIT BREAKER WARNING: STUCK LOOP DETECTED"
    echo "============================================"
    echo "$SAME_ERROR_COUNT consecutive passes with identical changed files."
    echo "The same files keep being modified without resolving the issue."
    echo "Review the files below and try a fundamentally different approach."
    echo ""
    echo "Repeatedly changed files:"
    head -10 "$STATE_DIR/pass-${PASS_NUM}-errors.txt" 2>/dev/null
    echo "============================================"
    echo ""
    STATUS="STUCK_LOOP_WARNING"
fi

# --- Bail and Replan: if both stagnation AND stuck loop detected ---
BAIL_REPLAN_THRESHOLD=${BAIL_REPLAN_THRESHOLD:-4}
if [ "$NO_PROGRESS_COUNT" -ge "$BAIL_REPLAN_THRESHOLD" ] && [ "$SAME_ERROR_COUNT" -ge "$BAIL_REPLAN_THRESHOLD" ]; then
    echo ""
    echo "=================================================="
    echo "CIRCUIT BREAKER: BAIL AND REPLAN RECOMMENDED"
    echo "=================================================="
    echo "Detected: $NO_PROGRESS_COUNT passes with no progress"
    echo "Detected: $SAME_ERROR_COUNT passes with same errors"
    echo "The current approach is not converging."
    echo "STOP implementation and re-evaluate the plan."
    echo "=================================================="
    echo ""
    STATUS="BAIL_AND_REPLAN"
fi

if [ "$PASS_NUM" -ge "$MAX_PASSES" ]; then
    echo ""
    echo "================================================"
    echo "CIRCUIT BREAKER: MAX PASSES REACHED ($MAX_PASSES)"
    echo "================================================"
    echo "The loop has run $PASS_NUM passes."
    echo "Ask the user for guidance before continuing."
    echo "================================================"
    echo ""
    STATUS="MAX_PASSES_REACHED"
elif [ "$PASS_NUM" -ge $((MAX_PASSES - 2)) ]; then
    echo "[CIRCUIT BREAKER] Pass $PASS_NUM of $MAX_PASSES -- approaching limit."
fi

# Always output status for loop controller to parse
echo "CIRCUIT_BREAKER_STATUS: $STATUS"
echo "CIRCUIT_BREAKER_PASS: $PASS_NUM"
echo "CIRCUIT_BREAKER_NO_PROGRESS: $NO_PROGRESS_COUNT"
echo "CIRCUIT_BREAKER_SAME_ERROR: $SAME_ERROR_COUNT"

exit 0

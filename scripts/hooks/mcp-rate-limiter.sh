#!/bin/bash
# =============================================================================
# MCP Rate Limiter Hook (PreToolUse)
# =============================================================================
# Purpose: Prevent runaway MCP call storms against external services.
#          Tracks calls in a sliding window and blocks when thresholds exceeded.
#
# Thresholds: 20 calls/minute, 200 calls/hour
# Scope: MCP tools only (matched by settings.json matcher)
# Key: $PPID (Claude Code process PID, NOT $$ which is the hook script PID)
#
# Massu MCP rate limiter hook
# =============================================================================

# --- Require jq ---
command -v jq >/dev/null 2>&1 || exit 0

# Read tool input from stdin
INPUT=$(cat)

# Extract tool name
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# Early exit if not an MCP tool (defense-in-depth; matcher should already filter)
if [[ ! "$TOOL_NAME" =~ ^mcp__ ]]; then
  exit 0
fi

# Rate limit state file (per-terminal, keyed by Claude Code parent PID)
STATE_FILE="/tmp/massu-mcp-rate-limit-${PPID}.json"
NOW=$(date +%s)

# Thresholds
MAX_PER_MINUTE=20
MAX_PER_HOUR=200
MINUTE_WINDOW=60
HOUR_WINDOW=3600

# Prune stale state files from previous sessions (older than 2 hours)
find /tmp -maxdepth 1 -name 'massu-mcp-rate-limit-*.json' -mmin +120 -delete 2>/dev/null

# Initialize state file if missing
if [ ! -f "$STATE_FILE" ]; then
  echo '{"timestamps":[]}' > "$STATE_FILE"
fi

# Atomic read-modify-write with mkdir lock (portable, no flock on macOS)
LOCK_DIR="${STATE_FILE}.lock"

# Acquire lock (mkdir is atomic); stale lock cleanup after 10s
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Check if lock is stale (older than 10 seconds)
  if [ -d "$LOCK_DIR" ]; then
    LOCK_AGE=$(( NOW - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo "$NOW") ))
    if [ "$LOCK_AGE" -gt 10 ]; then
      rmdir "$LOCK_DIR" 2>/dev/null
      mkdir "$LOCK_DIR" 2>/dev/null || { exit 0; }
    else
      # Lock is fresh, allow call without rate limiting (fail-open)
      exit 0
    fi
  fi
fi

# Ensure lock is released on exit
cleanup() { rmdir "$LOCK_DIR" 2>/dev/null; }
trap cleanup EXIT

# Read current timestamps
TIMESTAMPS=$(jq -r '.timestamps // []' "$STATE_FILE" 2>/dev/null)
if [ -z "$TIMESTAMPS" ] || [ "$TIMESTAMPS" = "null" ]; then
  TIMESTAMPS="[]"
fi

# Purge timestamps older than 1 hour
CUTOFF=$((NOW - HOUR_WINDOW))
TIMESTAMPS=$(echo "$TIMESTAMPS" | jq "[.[] | select(. >= $CUTOFF)]" 2>/dev/null)
if [ -z "$TIMESTAMPS" ] || [ "$TIMESTAMPS" = "null" ]; then
  TIMESTAMPS="[]"
fi

# Count calls in last minute
MINUTE_CUTOFF=$((NOW - MINUTE_WINDOW))
MINUTE_COUNT=$(echo "$TIMESTAMPS" | jq "[.[] | select(. >= $MINUTE_CUTOFF)] | length" 2>/dev/null)
MINUTE_COUNT=${MINUTE_COUNT:-0}

# Count calls in last hour
HOUR_COUNT=$(echo "$TIMESTAMPS" | jq "length" 2>/dev/null)
HOUR_COUNT=${HOUR_COUNT:-0}

# Check per-minute limit
if [ "$MINUTE_COUNT" -ge "$MAX_PER_MINUTE" ]; then
  echo "[MCP RATE LIMIT] Blocked: $MINUTE_COUNT calls in last 60s (limit: $MAX_PER_MINUTE/min). Tool: $TOOL_NAME" >&2
  echo "[MCP RATE LIMIT] Wait a moment before retrying. Check scripts/hooks/mcp-usage.log for call history." >&2
  exit 2
fi

# Check per-hour limit
if [ "$HOUR_COUNT" -ge "$MAX_PER_HOUR" ]; then
  echo "[MCP RATE LIMIT] Blocked: $HOUR_COUNT calls in last hour (limit: $MAX_PER_HOUR/hr). Tool: $TOOL_NAME" >&2
  echo "[MCP RATE LIMIT] Consider reducing MCP usage or wait for the window to reset." >&2
  exit 2
fi

# Record this call
TIMESTAMPS=$(echo "$TIMESTAMPS" | jq ". + [$NOW]" 2>/dev/null)
echo "{\"timestamps\":$TIMESTAMPS}" > "$STATE_FILE" 2>/dev/null

# Allow the call (cleanup via trap)
exit 0

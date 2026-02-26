#!/bin/bash
# =============================================================================
# MCP Usage Tracker (PostToolUse)
# =============================================================================
# Purpose: Append-only audit log of all MCP tool calls.
#          Non-blocking (always exits 0). Creates audit trail for analysis.
#
# Log format: YYYY-MM-DD HH:MM:SS | server_name | tool_name | session_pid
# Log file: scripts/hooks/mcp-usage.log (covered by .gitignore *.log)
#
# Massu MCP usage tracking hook
# =============================================================================

# --- Require jq ---
command -v jq >/dev/null 2>&1 || exit 0

# Read tool input from stdin
INPUT=$(cat)

# Extract tool name
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# Early exit if no tool name
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Extract server name (second segment: mcp__SERVER__tool -> SERVER)
SERVER_NAME=$(echo "$TOOL_NAME" | awk -F'__' '{print $2}' 2>/dev/null)
if [ -z "$SERVER_NAME" ]; then
  SERVER_NAME="unknown"
fi

# Log file location (relative to project root)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/mcp-usage.log"

# Timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Session identifier (parent Claude Code process PID)
SESSION_PID="$PPID"

# Append log entry
echo "$TIMESTAMP | $SERVER_NAME | $TOOL_NAME | $SESSION_PID" >> "$LOG_FILE" 2>/dev/null

# Never block
exit 0

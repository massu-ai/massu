#!/bin/bash
# =============================================================================
# Deliverable Validation Hook
# =============================================================================
# Purpose: After tool invocations, validate that expected deliverable files
#          were actually created. Catches cases where a command runs but
#          produces no output file.
#
# Usage: Called as a PostToolUse hook on Bash and Edit/Write tools.
#        Reads tool_input JSON from stdin (piped by Claude Code hooks).
#
# Exit codes:
#   0 = No validation needed or validation passed
#   1 = Warning: expected deliverable not found (non-blocking)
#
# Massu deliverable validation hook
# =============================================================================

# Verify jq is available
command -v jq >/dev/null 2>&1 || exit 0

TOOL_INPUT=$(cat)
COMMAND=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty')
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // empty')
TOOL_NAME=$(echo "$TOOL_INPUT" | jq -r '.tool_name // empty')

# Resolve project root dynamically
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$PROJECT_ROOT" 2>/dev/null || exit 0

# --- Bash command validations ---

# After git commit: verify a commit was actually created
if echo "$COMMAND" | grep -qE '^git commit'; then
  RECENT=$(git log -1 --since="5 minutes ago" --oneline 2>/dev/null)
  if [ -z "$RECENT" ]; then
    echo "[DELIVERABLE WARNING] git commit ran but no commit found in last 5 minutes. The commit may have failed silently." >&2
  fi
  exit 0
fi

# --- Edit/Write tool validations ---

# After writing to plans directory: verify the file exists and has content
if echo "$FILE_PATH" | grep -qE 'docs/plans/'; then
  if [ -f "$FILE_PATH" ]; then
    SIZE=$(wc -c < "$FILE_PATH" 2>/dev/null | tr -d ' ')
    if [ "$SIZE" -lt 100 ]; then
      echo "[DELIVERABLE WARNING] Plan file $FILE_PATH exists but is very small ($SIZE bytes). Verify content is complete." >&2
    fi
  fi
  exit 0
fi

# After editing INCIDENT-LOG.md: verify the file was actually modified
if echo "$FILE_PATH" | grep -qE 'INCIDENT-LOG\.md'; then
  CHANGES=$(git diff --stat -- "$FILE_PATH" 2>/dev/null | tail -1)
  if [ -z "$CHANGES" ]; then
    echo "[DELIVERABLE WARNING] INCIDENT-LOG.md was targeted for edit but shows no git diff. Verify the edit was applied." >&2
  fi
  exit 0
fi

exit 0

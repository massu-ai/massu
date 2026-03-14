#!/usr/bin/env bash
# type-check-edited.sh — Run full tsc --noEmit check after .ts/.tsx edits
#
# Triggered by UserPromptSubmit. Checks if any .ts/.tsx files were edited
# since the last check. If so, runs tsc --noEmit (full project check, NOT
# incremental — TypeScript incremental mode requires tsBuildInfoFile config).
# Reports only error count (not full output).
#
# NOTE: Full tsc can take 30-60+ seconds on this project. Throttle is set
# to 120 seconds to avoid blocking. The check runs in the background of
# the UserPromptSubmit hook, so it won't block the user's prompt.
#
# Uses tracking file written by PostToolUse hook.

set -euo pipefail

TRACKING_FILE="/tmp/claude-edited-ts-files"
LAST_CHECK="/tmp/claude-tsc-last-check"

# Exit if no tracked files
[ ! -f "$TRACKING_FILE" ] && exit 0
[ ! -s "$TRACKING_FILE" ] && exit 0

# Deduplicate and count
EDITED_COUNT=$(sort -u "$TRACKING_FILE" | wc -l | tr -d ' ')
[ "$EDITED_COUNT" -eq 0 ] && exit 0

# Check if we've run recently (throttle to max once per 120 seconds)
# 120s chosen because full tsc --noEmit takes 30-60s on this project
if [ -f "$LAST_CHECK" ]; then
  LAST_TIME=$(cat "$LAST_CHECK" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST_TIME ))
  [ "$ELAPSED" -lt 120 ] && exit 0
fi

# Clear tracking file and record check time
rm -f "$TRACKING_FILE"
date +%s > "$LAST_CHECK"

# Run tsc --noEmit (full project check across all packages)
cd "$(git rev-parse --show-toplevel)"
ERRORS=$(NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit 2>&1 | grep -c "error TS" || true)

if [ "$ERRORS" -gt 0 ]; then
  # Show just the error count as a warning
  echo "[TYPE CHECK] $ERRORS TypeScript error(s) detected after editing $EDITED_COUNT file(s). Run 'npx tsc --noEmit' for details."
fi

exit 0

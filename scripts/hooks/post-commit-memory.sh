#!/usr/bin/env bash
# Post-Commit Memory Enforcement Hook
# Fires after any `git commit` Bash command succeeds.
# Checks if the commit is significant (fix/feat/refactor/incident/security)
# and reminds Claude to ingest to massu_memory_ingest.
#
# Wired via PostToolUse Bash matcher in ~/.claude/settings.json

set -euo pipefail

# Read the command that was executed
CMD=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# Only fire on git commit commands
echo "$CMD" | grep -qE '^git (commit|add.*&&.*git commit)' || exit 0

# Check exit code - only proceed on successful commits
EXIT_CODE=$(jq -r '.tool_result.exit_code // "1"' 2>/dev/null)
[ "$EXIT_CODE" != "0" ] && exit 0

# Extract the commit message from the latest commit
REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMIT_MSG=$(cd "$REPO_ROOT" && git log -1 --format="%s" 2>/dev/null)
[ -z "$COMMIT_MSG" ] && exit 0

# Check if this is a significant commit (not chore/docs/style)
SIGNIFICANT=false
echo "$COMMIT_MSG" | grep -qiE '^(fix|feat|refactor|perf|security|incident|debug)\b' && SIGNIFICANT=true

if [ "$SIGNIFICANT" = false ]; then
  exit 0
fi

# Check if massu_memory_ingest was already called this session by looking for
# a breadcrumb file that gets created when ingest happens
BREADCRUMB="/tmp/claude-memory-ingested-$(cd "$REPO_ROOT" && git log -1 --format='%h' 2>/dev/null)"
if [ -f "$BREADCRUMB" ]; then
  exit 0
fi

# Emit the reminder
COMMIT_HASH=$(cd "$REPO_ROOT" && git log -1 --format="%h" 2>/dev/null)
cat <<EOF
[MEMORY ENFORCEMENT] Significant commit detected but NOT yet ingested to memory:
  Commit: ${COMMIT_HASH} ${COMMIT_MSG}
  Action: Call mcp__massu__massu_memory_ingest NOW (CR-9 mandatory).
  Then update memory/MEMORY.md if this introduces a new pattern or gotcha.
EOF

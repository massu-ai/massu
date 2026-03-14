#!/usr/bin/env bash
# Mark the latest commit as ingested to memory.
# Called from PostToolUse hook on mcp__massu__massu_memory_ingest.
# Creates a breadcrumb file so post-commit-memory.sh won't re-fire.

REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMIT_HASH=$(cd "$REPO_ROOT" && git log -1 --format="%h" 2>/dev/null)
[ -z "$COMMIT_HASH" ] && exit 0

touch "/tmp/claude-memory-ingested-${COMMIT_HASH}"
exit 0

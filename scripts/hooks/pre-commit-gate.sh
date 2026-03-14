#!/usr/bin/env bash
# Pre-commit gate hook: runs tsc --noEmit + npm test before git commit
# Triggered by PreToolUse on Bash commands containing "git commit"
# Exit 0 = allow, Exit 2 = block

set -euo pipefail

# Read the command from stdin JSON
COMMAND=$(jq -r '.tool_input.command // empty')

# Only gate on git commit commands
if ! echo "$COMMAND" | grep -qE '^git commit|&& git commit|; git commit'; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Check if core packages have staged changes
CORE_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^packages/' || true)
WEBSITE_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^website/' || true)

ERRORS=0

# Type check core if core files are staged
if [ "$CORE_STAGED" -gt 0 ]; then
  if ! cd "$PROJECT_DIR/packages/core" && npx tsc --noEmit 2>&1 | tail -5; then
    echo "[PRE-COMMIT GATE] TypeScript errors in packages/core. Fix before committing." >&2
    ERRORS=$((ERRORS + 1))
  fi
  cd "$PROJECT_DIR"
fi

# Type check website if website files are staged
if [ "$WEBSITE_STAGED" -gt 0 ]; then
  if ! cd "$PROJECT_DIR/website" && npx tsc --noEmit 2>&1 | tail -5; then
    echo "[PRE-COMMIT GATE] TypeScript errors in website/. Fix before committing." >&2
    ERRORS=$((ERRORS + 1))
  fi
  cd "$PROJECT_DIR"
fi

# Run tests if any source files are staged
if [ "$CORE_STAGED" -gt 0 ]; then
  if ! cd "$PROJECT_DIR" && npm test 2>&1 | tail -5; then
    echo "[PRE-COMMIT GATE] Tests failed. Fix before committing." >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "[PRE-COMMIT GATE] $ERRORS check(s) failed. Commit blocked." >&2
  exit 2
fi

exit 0

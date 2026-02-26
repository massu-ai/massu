#!/bin/bash
# =============================================================================
# Pattern Feedback Hook (Exit Code 2 + JSON)
# =============================================================================
# Purpose: Check edited source files for pattern violations and return
#          structured JSON feedback to Claude Code via stderr + exit code 2.
#
# Usage: Called as a PostToolUse hook on Edit|Write for source files.
#        Reads tool_input JSON from stdin (piped by Claude Code hooks).
#
# Exit codes:
#   0 = No violations found
#   2 = Violation found, JSON feedback on stderr (fed back to Claude)
#
# Massu pattern feedback hook
# =============================================================================

# Verify jq is available
command -v jq >/dev/null 2>&1 || exit 0

# Read full stdin and extract file path
TOOL_INPUT=$(cat)
FILE=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // empty')

# Resolve source path from massu.config.yaml (default: src)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SOURCE_PATH=$(cat "$PROJECT_ROOT/massu.config.yaml" 2>/dev/null | grep -E '^\s+source:' | head -1 | sed 's/.*source:\s*//' | tr -d '"'"'" || echo "src")
[ -z "$SOURCE_PATH" ] && SOURCE_PATH="src"
# Only check TypeScript source files under the configured source path
echo "$FILE" | grep -qE "${SOURCE_PATH}/.*\.ts$" || exit 0

# Check if file exists
[ -f "$FILE" ] || exit 0

VIOLATIONS=""
EXIT_CODE=0

# Check for direct YAML parsing (should use getConfig())
LINE=$(grep -n "import.*from 'yaml'" "$FILE" 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$LINE" ]; then
  # Exclude config.ts itself which legitimately imports yaml
  # Exclude commands/init.ts and commands/doctor.ts which legitimately use yaml for CLI output/validation
  # Exclude hooks/ which are compiled with esbuild and cannot use getConfig()
  if ! echo "$FILE" | grep -qE 'config\.ts$|commands/(init|doctor)\.ts$|hooks/'; then
    VIOLATIONS="${VIOLATIONS}{\"violation\":\"Config pattern: Direct YAML import instead of getConfig()\",\"file\":\"$FILE\",\"line\":$LINE,\"fix\":\"Use getConfig() from config.ts instead of parsing YAML directly\",\"pattern_doc\":\"CLAUDE.md#config-access-pattern\"},"
    EXIT_CODE=2
  fi
fi

# Check for hardcoded tool prefix 'massu_' (should use getConfig().toolPrefix)
# Exclude SQL table name contexts (FROM, INTO, UPDATE, sqlite_master, AND name=) and
# non-tool usages like import paths, comment lines, and known DB table names (_sentinel, _components, etc.)
LINE=$(grep -n "'massu_" "$FILE" 2>/dev/null \
  | grep -v 'getConfig\|toolPrefix\|test\|spec\|__tests__' \
  | grep -v 'FROM\|INTO\|UPDATE\|sqlite_master\|AND name\|JOIN\|WHERE\|SELECT\|INSERT' \
  | grep -v 'massu_sentinel\|massu_sentinel_\|massu_data\|massu_memory\|massu_db' \
  | head -1 | cut -d: -f1)
if [ -n "$LINE" ]; then
  VIOLATIONS="${VIOLATIONS}{\"violation\":\"Hardcoded tool prefix 'massu_' instead of config-driven\",\"file\":\"$FILE\",\"line\":$LINE,\"fix\":\"Use getConfig().toolPrefix + '_tool_name' or the p() helper function\",\"pattern_doc\":\"CLAUDE.md#config-access-pattern\"},"
  EXIT_CODE=2
fi

# Check for ESM imports missing .ts extension
LINE=$(grep -n "from '\.\/" "$FILE" 2>/dev/null | grep -vE "\.ts'|\.js'" | head -1 | cut -d: -f1)
if [ -n "$LINE" ]; then
  VIOLATIONS="${VIOLATIONS}{\"violation\":\"ESM import missing .ts extension\",\"file\":\"$FILE\",\"line\":$LINE,\"fix\":\"Add .ts extension to relative imports (ESM requirement)\",\"pattern_doc\":\"CLAUDE.md#common-patterns\"},"
  EXIT_CODE=2
fi

# Check for writing to CodeGraph DB (should be read-only)
LINE=$(grep -n 'getCodeGraphDb().*\.\(run\|exec\|prepare.*run\)' "$FILE" 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$LINE" ]; then
  VIOLATIONS="${VIOLATIONS}{\"violation\":\"Writing to CodeGraph DB (must be read-only)\",\"file\":\"$FILE\",\"line\":$LINE,\"fix\":\"CodeGraph DB is read-only. Use getDataDb() or getMemoryDb() for writes\",\"pattern_doc\":\"CLAUDE.md#sqlite-database-pattern\"},"
  EXIT_CODE=2
fi

# Check for memDb without close (missing try/finally pattern)
LINE=$(grep -n 'getMemoryDb()' "$FILE" 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$LINE" ]; then
  if ! grep -q 'memDb\.close\|\.close()' "$FILE" 2>/dev/null; then
    VIOLATIONS="${VIOLATIONS}{\"violation\":\"getMemoryDb() called without .close() - potential DB connection leak\",\"file\":\"$FILE\",\"line\":$LINE,\"fix\":\"Use try { ... } finally { memDb.close(); } pattern\",\"pattern_doc\":\"CLAUDE.md#sqlite-database-pattern\"},"
    EXIT_CODE=2
  fi
fi

if [ "$EXIT_CODE" -eq 2 ]; then
  # Remove trailing comma and wrap in array
  VIOLATIONS="${VIOLATIONS%,}"
  echo "{\"violations\":[${VIOLATIONS}],\"total\":$(echo "$VIOLATIONS" | grep -o '"violation"' | wc -l | tr -d ' ')}" >&2
  exit 2
fi

exit 0

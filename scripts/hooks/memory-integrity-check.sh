#!/bin/bash
# ============================================================
# MEMORY INTEGRITY CHECK (SessionStart hook)
# ============================================================
# Scans MEMORY.md for patterns that contradict CLAUDE.md rules.
# Detects potential prompt injection that may have been written
# to persistent memory from external content (WebFetch, articles).
#
# Massu memory integrity hook
# ============================================================

# Resolve project root dynamically
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$PROJECT_ROOT" ]; then
  exit 0
fi

# Claude Code stores project memory in ~/.claude/projects/ with path-encoded dir names
# Convert project root to the path-encoded form used by Claude Code
ENCODED_PATH=$(echo "$PROJECT_ROOT" | sed 's|/|-|g')
MEMORY_FILE="$HOME/.claude/projects/${ENCODED_PATH}/memory/MEMORY.md"

if [ ! -f "$MEMORY_FILE" ]; then
  exit 0
fi

VIOLATIONS=""

# Anti-patterns that contradict CLAUDE.md rules
# Each pattern is something that should NEVER appear in MEMORY.md

# Config-driven: Must use getConfig(), never parse YAML directly
if grep -iqE 'parse YAML directly|import.*yaml.*from|require.*yaml' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests parsing YAML directly (contradicts config access pattern: must use getConfig())"
fi

# Security: Never skip verification
if grep -iqE 'skip verif|verification not needed|VR-.* not required|skip VR-|disable hook' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests skipping verification (contradicts CR-1)"
fi

# Security: Never use --no-verify
if grep -iqE 'use --no-verify|skip pre-commit|bypass hook' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests bypassing git hooks (security violation)"
fi

# CR-3: Never commit secrets
if grep -iqE 'commit.*\.env|add.*\.env.*to git|\.env is safe to commit' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests committing secret files (contradicts CR-3)"
fi

# Tool registration: Never skip tools.ts wiring
if grep -iqE 'skip.*tools\.ts|don.t need.*tools\.ts|tools\.ts.*not required' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests skipping tools.ts registration (contradicts CR-11)"
fi

# Hardcoded values: Must use config
if grep -iqE 'hardcode.*prefix|hardcode.*tool.*name|hardcode.*path' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests hardcoding values (contradicts config-driven architecture)"
fi

# ESM imports: Must use .ts extensions
if grep -iqE 'don.t need.*\.ts|skip.*extension|import without extension' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests skipping .ts extensions in imports (contradicts ESM pattern)"
fi

# DB access: Must use proper DB functions
if grep -iqE 'write.*to.*CodeGraph|modify.*CodeGraph.*db|CodeGraph.*is writable' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests writing to CodeGraph DB (must be read-only)"
fi

# Process.env: Check for secret key handling patterns
if grep -iqE 'use process\.env for (secret|key|token|credential)|process\.env is fine for' "$MEMORY_FILE" 2>/dev/null; then
  VIOLATIONS="$VIOLATIONS\n  - MEMORY.md suggests process.env for secrets"
fi

if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "[MEMORY INTEGRITY WARNING] MEMORY.md contains patterns that contradict CLAUDE.md rules:"
  echo -e "$VIOLATIONS"
  echo ""
  echo "These entries may have been injected via external content (WebFetch, article review)."
  echo "Review and remove any suspicious entries from MEMORY.md immediately."
  echo ""
fi

exit 0

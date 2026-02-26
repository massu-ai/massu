#!/bin/bash
# ============================================================
# AUTO-REVIEW ON STOP HOOK
# ============================================================
# PURPOSE: Automatically reviews modified files for semantic
#          code quality issues when Claude hands control back.
#          Uses a separate subagent (not the main agent) to
#          avoid self-review bias and context pollution.
#
# HOW IT WORKS:
#   1. Queries massu memory.db for files modified since last review
#   2. Spawns a headless `claude -p` subagent to review those files
#   3. If issues found, writes to .last-review-findings.txt
#   4. SessionStart hook surfaces unread findings at next session
#
# DISABLE: export MASSU_AUTO_REVIEW=0
# RE-ENABLE: unset MASSU_AUTO_REVIEW (or export MASSU_AUTO_REVIEW=1)
# REMOVE:  1. Delete Stop hook entry from settings.json
#          2. Delete SessionStart hook entry from settings.json
#          3. rm scripts/hooks/auto-review-on-stop.sh
#          4. rm scripts/hooks/surface-review-findings.sh
#          5. rm scripts/hooks/.last-review-timestamp
#          6. rm scripts/hooks/.last-review-findings.txt
#
# Massu auto-review hook
# ============================================================

# --- Require dependencies ---
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MEMORY_DB="$REPO_ROOT/.massu/memory.db"
TIMESTAMP_FILE="$SCRIPT_DIR/.last-review-timestamp"
FINDINGS_FILE="$SCRIPT_DIR/.last-review-findings.txt"

# --- Kill switch ---
if [ "$MASSU_AUTO_REVIEW" = "0" ]; then
  exit 0
fi

# --- Check memory DB exists ---
if [ ! -f "$MEMORY_DB" ]; then
  exit 0
fi

# --- Get last review timestamp (epoch seconds) ---
# First run: default to 1 hour ago (not epoch 0) to avoid reviewing entire history
if [ -f "$TIMESTAMP_FILE" ]; then
  LAST_REVIEW=$(cat "$TIMESTAMP_FILE")
else
  LAST_REVIEW=$(( $(date +%s) - 3600 ))
fi

# --- Query modified files since last review (max 15 to cap subagent time) ---
FILES=$(sqlite3 "$MEMORY_DB" "
  SELECT DISTINCT json_extract(files_involved, '\$[0]')
  FROM observations
  WHERE type = 'file_change'
  AND created_at_epoch > $LAST_REVIEW
  AND json_extract(files_involved, '\$[0]') IS NOT NULL
  ORDER BY created_at_epoch DESC
  LIMIT 15;
")

# --- Filter: no files changed = skip ---
if [ -z "$FILES" ]; then
  exit 0
fi

# --- Filter: only review .ts/.tsx files (skip configs, json, etc.) ---
# Cap at 10 files to keep subagent review fast
MAX_REVIEW_FILES=10
REVIEW_FILES=""
FILE_COUNT=0
while IFS= read -r file; do
  if [[ "$file" == *.ts ]] || [[ "$file" == *.tsx ]]; then
    REVIEW_FILES="$REVIEW_FILES $file"
    FILE_COUNT=$((FILE_COUNT + 1))
    if [ "$FILE_COUNT" -ge "$MAX_REVIEW_FILES" ]; then
      break
    fi
  fi
done <<< "$FILES"

if [ "$FILE_COUNT" -eq 0 ]; then
  # Update timestamp even if no reviewable files (avoid re-querying)
  date +%s > "$TIMESTAMP_FILE"
  exit 0
fi

# --- Spawn subagent for semantic review ---
REVIEW_OUTPUT=$(claude -p "You are a code reviewer. Review ONLY these files for semantic issues:

$REVIEW_FILES

RULES (flag violations only - do not rewrite code):
1. Silent default fallbacks: Flag ?? '', || '', ?? 0, ?? 'unknown', ?? 'N/A' where explicit validation or error throwing would be safer. Context matters - some defaults ARE correct.
2. Generic naming: Flag functions/files named helper, utils, misc, data, info, stuff where a domain-specific name would be clearer.
3. Config access: Flag direct YAML parsing instead of getConfig(). All config must go through config.ts.
4. Silent catch blocks: Flag catch(e) { console.log(e) } or catch(e) { log.error(e) } without rethrowing where the caller expects to know about the failure.
5. ESM imports: Flag imports missing .ts extensions.
6. Hardcoded values: Flag hardcoded tool prefixes or project-specific strings that should come from config.
7. DB access: Flag writes to CodeGraph DB (must be read-only) or missing memDb.close() calls.

FORMAT: For each issue found, output exactly:
ISSUE: file_path:line_number - description

If NO issues found, output exactly: PASS

Be conservative. Only flag clear violations, not ambiguous cases." \
  --output-format text \
  2>/dev/null)

# --- Update timestamp ---
date +%s > "$TIMESTAMP_FILE"

# --- Check results ---
if echo "$REVIEW_OUTPUT" | grep -q "^PASS$"; then
  # Clean up old findings if review passes
  rm -f "$FINDINGS_FILE"
  exit 0
fi

# --- Write findings to file for SessionStart to surface ---
echo "=== AUTO-REVIEW FINDINGS ($(date '+%Y-%m-%d %H:%M')) ===" > "$FINDINGS_FILE"
echo "" >> "$FINDINGS_FILE"
echo "Files reviewed: $FILE_COUNT" >> "$FINDINGS_FILE"
echo "" >> "$FINDINGS_FILE"
echo "$REVIEW_OUTPUT" >> "$FINDINGS_FILE"
echo "" >> "$FINDINGS_FILE"
echo "To dismiss: rm $FINDINGS_FILE" >> "$FINDINGS_FILE"
echo "To disable auto-review: export MASSU_AUTO_REVIEW=0" >> "$FINDINGS_FILE"

# --- Print summary to hook output (informational) ---
ISSUE_COUNT=$(echo "$REVIEW_OUTPUT" | grep -c "^ISSUE:")
echo "[AUTO-REVIEW] Found $ISSUE_COUNT semantic issue(s) in $FILE_COUNT file(s)."
echo "Details saved to: scripts/hooks/.last-review-findings.txt"

# Always exit 0 - findings are advisory, not blocking
exit 0

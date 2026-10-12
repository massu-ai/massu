#!/usr/bin/env bash
# auto-ingest-incident.sh - PostToolUse hook for INCIDENT-LOG.md edits
#
# Fires on every Edit/Write tool call. Checks if the file is INCIDENT-LOG.md,
# and if so:
#   1. Extracts the latest incident number + summary line from the file
#   2. Counts total incidents
#   3. Inserts an observation into massu memory.db via sqlite3
#
# Idempotent: checks if the incident was already ingested before inserting.
# Fast: exits immediately if the file is not INCIDENT-LOG.md.
#
# Massu auto-ingest hook

set -euo pipefail

# --- Require jq ---
command -v jq >/dev/null 2>&1 || exit 0

# --- Early exit: check if the edited file is INCIDENT-LOG.md ---
FILE_PATH=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"INCIDENT-LOG.md"* ]]; then
  exit 0
fi

# --- Constants (dynamic project root detection) ---
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

INCIDENT_FILE="$PROJECT_ROOT/.claude/incidents/INCIDENT-LOG.md"
MEMORY_DB="$PROJECT_ROOT/.massu/memory.db"

# Verify files exist
if [[ ! -f "$INCIDENT_FILE" ]]; then
  exit 0
fi
if [[ ! -f "$MEMORY_DB" ]]; then
  exit 0
fi

# --- Step 1: Extract the highest incident number and its summary ---
#
# ⛔ THE FORMAT IS THE LOG'S, NOT THIS FILE'S. This parser used to demand `## Incident #N:`
# headings and `**What happened**:` / `**Prevention added**:` fields. The log it watches declares
# its own format in its `## Template` section — `### Incident #N:` headings and `- **Root Cause**:`
# / `- **Prevention**:` bullets — and the two never agreed. `grep -oE '## Incident #…'` still
# matched `###` as a SUBSTRING (so a number was found), then the anchored `^## Incident #N:` found
# nothing, and under `set -euo pipefail` that empty grep KILLED the hook: exit 1, no insert, no
# message, on every edit of the real log. Measured 2026-09-26 against a copy of the real
# INCIDENT-LOG.md: rc=1, INSERT attempts 0. A drift-guard in the core test suite drives THIS
# script against the REAL log, so the two authoring sites cannot drift apart silently again.
#
# Both heading depths are accepted (logs written to the older `## Incident #N:` convention keep
# working; this repo's template uses `###`), and the fields are OPTIONAL: every extraction that may
# legitimately find nothing is `|| true`, because under pipefail a grep that matches nothing fails
# the assignment and errexit ends the hook. That is not a status capture, so the `&& X=0 || X=$?`
# idiom used for the INSERT below does not apply here.
HEADING_RE='^#{2,3} Incident #'
LATEST_INCIDENT=$( { grep -oE "${HEADING_RE}[0-9]+:" "$INCIDENT_FILE" | grep -oE '[0-9]+' | sort -n | tail -1; } || true)

if [[ -z "$LATEST_INCIDENT" ]]; then
  exit 0
fi

# Extract the full header line for the latest incident
INCIDENT_HEADER=$( { grep -E "${HEADING_RE}${LATEST_INCIDENT}:" "$INCIDENT_FILE" | head -1; } || true)
INCIDENT_TITLE=$(echo "$INCIDENT_HEADER" | sed -E 's/^#{2,3} //')

# Extract the summary fields for the LATEST incident specifically
HEADER_LINE=$( { grep -nE "${HEADING_RE}${LATEST_INCIDENT}:" "$INCIDENT_FILE" | head -1 | cut -d: -f1; } || true)
if [[ -n "$HEADER_LINE" ]]; then
  SECTION=$( { sed -nE "${HEADER_LINE},/${HEADING_RE}[0-9]/p" "$INCIDENT_FILE" | head -30; } || true)
  WHAT_HAPPENED=$( { echo "$SECTION" | grep -E '^(- )?\*\*(What happened|Root Cause)\*\*:' | head -1 | sed -E 's/^(- )?\*\*(What happened|Root Cause)\*\*: *//' | head -c 500; } || true)
  PREVENTION=$( { echo "$SECTION" | grep -E '^(- )?\*\*Prevention( added)?\*\*:' | head -1 | sed -E 's/^(- )?\*\*Prevention( added)?\*\*: *//' | head -c 500; } || true)
else
  WHAT_HAPPENED=""
  PREVENTION=""
fi

# --- Step 2: Determine total incident count ---
TOTAL_INCIDENTS="$LATEST_INCIDENT"

# --- Step 3: Insert observation into memory.db ---
# Get the most recent active session ID
SESSION_ID=$(sqlite3 "$MEMORY_DB" "SELECT session_id FROM sessions WHERE status = 'active' ORDER BY started_at_epoch DESC LIMIT 1;" 2>/dev/null || echo "")

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID=$(sqlite3 "$MEMORY_DB" "SELECT session_id FROM sessions ORDER BY started_at_epoch DESC LIMIT 1;" 2>/dev/null || echo "")
fi

if [[ -z "$SESSION_ID" ]]; then
  echo "[auto-ingest-incident] No session found in memory DB, skipping DB insert"
  exit 0
fi

# Check idempotency: has this incident already been ingested?
EXISTING=$(sqlite3 "$MEMORY_DB" "SELECT COUNT(*) FROM observations WHERE type = 'incident_near_miss' AND title LIKE '%Incident #${LATEST_INCIDENT}%' LIMIT 1;" 2>/dev/null || echo "0")

if [[ "$EXISTING" -gt 0 ]]; then
  exit 0
fi

# Build the detail text
DETAIL="Incident #${LATEST_INCIDENT} logged in INCIDENT-LOG.md. ${WHAT_HAPPENED}"
if [[ -n "$PREVENTION" ]]; then
  DETAIL="${DETAIL} Prevention: ${PREVENTION}"
fi
DETAIL=$(echo "$DETAIL" | head -c 2000)

# Escape single quotes for SQL
ESCAPED_TITLE=$(echo "$INCIDENT_TITLE" | sed "s/'/''/g")
ESCAPED_DETAIL=$(echo "$DETAIL" | sed "s/'/''/g")

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NOW_EPOCH=$(date +%s)

# Insert observation with type=incident_near_miss, importance=5
# Under `set -e` a bare `$?` on the next line is DEAD CODE: a failing sqlite3 ends the script
# before the test runs, so the "Failed to ingest" line never printed and this hook exited
# non-zero with no diagnosis instead of reaching its documented `exit 0`. Owning
# cross-repo plan 2026-09-25-set-e-status-capture-is-dead-code.md, incident #432.
# `cmd && RC=0 || RC=$?` is a list, which errexit exempts. sqlite3's stderr is CAPTURED rather
# than discarded, so the failure message below can say WHY instead of only THAT.
INGEST_ERR=$(sqlite3 "$MEMORY_DB" "INSERT INTO observations (session_id, type, title, detail, files_involved, cr_rule, importance, created_at, created_at_epoch) VALUES ('${SESSION_ID}', 'incident_near_miss', '${ESCAPED_TITLE}', '${ESCAPED_DETAIL}', '[\"$INCIDENT_FILE\"]', 'CR-9', 5, '${NOW_ISO}', ${NOW_EPOCH});" 2>&1) && INGEST_RC=0 || INGEST_RC=$?

if [[ $INGEST_RC -eq 0 ]]; then
  echo "[auto-ingest-incident] Ingested Incident #${LATEST_INCIDENT} into massu memory (${TOTAL_INCIDENTS} total incidents)"
else
  echo "[auto-ingest-incident] Failed to ingest incident into memory DB (sqlite3 exit ${INGEST_RC}): ${INGEST_ERR:-no error text}" >&2
fi

exit 0

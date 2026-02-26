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
# Find lines like "## Incident #25: February 18, 2026 - IntegrationCard onClick Undefined"
LATEST_INCIDENT=$(grep -oE '## Incident #([0-9]+):' "$INCIDENT_FILE" | grep -oE '[0-9]+' | sort -n | tail -1)

if [[ -z "$LATEST_INCIDENT" ]]; then
  exit 0
fi

# Extract the full header line for the latest incident
INCIDENT_HEADER=$(grep -E "^## Incident #${LATEST_INCIDENT}:" "$INCIDENT_FILE" | head -1)
INCIDENT_TITLE=$(echo "$INCIDENT_HEADER" | sed 's/^## //')

# Extract "What happened" for the LATEST incident specifically
HEADER_LINE=$(grep -n "^## Incident #${LATEST_INCIDENT}:" "$INCIDENT_FILE" | head -1 | cut -d: -f1)
if [[ -n "$HEADER_LINE" ]]; then
  SECTION=$(sed -n "${HEADER_LINE},/^## Incident #[0-9]/p" "$INCIDENT_FILE" | head -30)
  WHAT_HAPPENED=$(echo "$SECTION" | grep "^\*\*What happened\*\*:" | head -1 | sed 's/^\*\*What happened\*\*: *//' | head -c 500)
  PREVENTION=$(echo "$SECTION" | grep "^\*\*Prevention added\*\*:" | head -1 | sed 's/^\*\*Prevention added\*\*: *//' | head -c 500)
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
sqlite3 "$MEMORY_DB" "INSERT INTO observations (session_id, type, title, detail, files_involved, cr_rule, importance, created_at, created_at_epoch) VALUES ('${SESSION_ID}', 'incident_near_miss', '${ESCAPED_TITLE}', '${ESCAPED_DETAIL}', '[\"$INCIDENT_FILE\"]', 'CR-9', 5, '${NOW_ISO}', ${NOW_EPOCH});" 2>/dev/null

if [[ $? -eq 0 ]]; then
  echo "[auto-ingest-incident] Ingested Incident #${LATEST_INCIDENT} into massu memory (${TOTAL_INCIDENTS} total incidents)"
else
  echo "[auto-ingest-incident] Failed to ingest incident into memory DB" >&2
fi

exit 0

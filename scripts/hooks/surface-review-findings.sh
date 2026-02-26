#!/bin/bash
# ============================================================
# SURFACE REVIEW FINDINGS (SessionStart hook)
# ============================================================
# Part of the auto-review system. Checks for unread findings
# from a previous session's auto-review and surfaces them.
#
# Massu review findings hook
# REMOVE: Delete this file + its hook entry in settings.json
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FINDINGS_FILE="$SCRIPT_DIR/.last-review-findings.txt"

if [ -f "$FINDINGS_FILE" ]; then
  echo ""
  echo "=== UNADDRESSED AUTO-REVIEW FINDINGS ==="
  cat "$FINDINGS_FILE"
  echo "========================================="
  echo ""
fi

exit 0

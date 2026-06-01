#!/usr/bin/env bash
#
# claude-md-autosplit.sh - Deterministic CLAUDE.md detail-body relocation tool
#
# Moves every longform `### CR-NN:` detail section out of the always-loaded
# .claude/CLAUDE.md into the load-on-demand .claude/reference/canonical-rules-detail.md,
# leaving a one-line pointer behind. Keeps the canonical CR/VR summary tables,
# the Workflow Commands inventory, and the Massu Development Patterns inline.
#
# This is the "automatically adjust so we're in compliance" tool: it captures the
# one clean structural win (the per-CR detail bodies are genuinely reference
# material) so the always-loaded file stays under the size budget.
#
# Plan: plan-2026-06-01-claude-md-size-compliance (option iii HYBRID).
#
# MOVABLE   : a heading matching `^### CR-[0-9]+:` and everything up to (not
#             including) the NEXT line matching `^#{1,3} ` (i.e. the next `#`,
#             `##`, or `###` heading). This stops correctly at the next
#             `### CR-NN:` body or at the next `## ` section.
# IMMOVABLE : the script NEVER touches the canonical CR/VR tables, Load
#             Instructions, Workflow Commands, Massu Development Patterns,
#             Interaction Rules, Core Principles, Zero Tolerance, Deployment,
#             or the trailer blocks. It only rewrites `### CR-NN:` bodies.
#
# Idempotent: a second run when bodies are already moved (pointer lines present /
#             no movable bodies remain) is a no-op.
#
# Usage:
#   bash scripts/claude-md-autosplit.sh [--dry-run]
#     --dry-run : print the ordered list of CR sections that WOULD move plus the
#                 projected post-move `wc -c` of CLAUDE.md, write NOTHING, exit 0.
#
# No operator literals (this script syncs to the public repo). Repo root is
# resolved via `git rev-parse --show-toplevel`. Portable to bash 3.2 (macOS):
# the body-relocation pass is a single awk program, not a bash array loop.

set -uo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
elif [ -n "${1:-}" ]; then
  echo "[ERROR] Unknown argument: $1 (only --dry-run is supported)" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "[ERROR] Not inside a git repository — run this script from a Massu checkout" >&2
  exit 1
fi

CLAUDE_MD="$REPO_ROOT/.claude/CLAUDE.md"
REF_DIR="$REPO_ROOT/.claude/reference"
REF_FILE="$REF_DIR/canonical-rules-detail.md"
REF_REL="reference/canonical-rules-detail.md"

if [ ! -f "$CLAUDE_MD" ]; then
  echo "[ERROR] CLAUDE.md not found at $CLAUDE_MD" >&2
  exit 1
fi

POINTER_MARKER="Detail moved to"
PLAN_NOTE="CLAUDE.md size compliance, plan-2026-06-01-claude-md-size-compliance"
REF_HEADER_MARKER="# Canonical Rules — Longform Detail (load on demand)"

# ---------------------------------------------------------------------------
# Count movable sections: a `^### CR-NN:` heading whose body (the lines up to
# the next `^#{1,3} ` heading) does NOT already contain the pointer marker.
# ---------------------------------------------------------------------------
count_movable() {
  awk -v marker="$POINTER_MARKER" '
    function flush() {
      if (in_sec) {
        if (body !~ marker) movable++
        in_sec = 0; body = ""
      }
    }
    /^### CR-[0-9]+:/ { flush(); in_sec = 1; body = ""; next }
    /^#{1,3} /        { flush(); next }
    in_sec            { body = body "\n" $0 }
    END               { flush(); print movable + 0 }
  ' "$CLAUDE_MD"
}

MOVABLE_COUNT=$(count_movable)

if [ "$MOVABLE_COUNT" -eq 0 ]; then
  echo "[autosplit] No movable '### CR-NN:' detail bodies — already split (no-op)."
  exit 0
fi

CURRENT_SIZE=$(wc -c < "$CLAUDE_MD" | tr -d ' ')

# ---------------------------------------------------------------------------
# Core transform (single awk pass). Emits three streams to separate files:
#   $1 = rewritten CLAUDE.md (pointers in place of movable bodies)
#   $2 = moved bodies (verbatim sections, blank line between)
#   $3 = dry-run report lines ("CR-NN<TAB>title<TAB>origBytes<TAB>ptrBytes")
# A movable section already containing the pointer marker is left verbatim.
# ---------------------------------------------------------------------------
transform() {
  local out_claude="$1" out_ref="$2" out_report="$3"
  awk -v marker="$POINTER_MARKER" -v ref_rel="$REF_REL" -v plan_note="$PLAN_NOTE" \
      -v out_claude="$out_claude" -v out_ref="$out_ref" -v out_report="$out_report" '
    function lc(s,   r) { r = tolower(s); return r }
    function emit_pointer(num, title,   anchor, ptr) {
      anchor = "cr-" lc(num)
      ptr = "### " title "\n\n> " marker " [canonical-rules-detail.md](" ref_rel "#" anchor ") (" plan_note ").\n"
      return ptr
    }
    function flush(   ptr, ob, pb) {
      if (!in_sec) return
      if (body ~ marker) {
        # already a pointer — keep verbatim
        printf "%s", sec_raw > out_claude
      } else {
        ptr = emit_pointer(sec_num, sec_title)
        printf "%s", ptr > out_claude
        printf "%s\n", sec_raw > out_ref   # verbatim body + spacer blank line
        ob = length(sec_raw)
        pb = length(ptr)
        printf "%s\t%s\t%d\t%d\n", sec_num, sec_title, ob, pb > out_report
      }
      in_sec = 0; body = ""; sec_raw = ""
    }
    /^### CR-[0-9]+:/ {
      flush()
      in_sec = 1; body = ""; sec_raw = $0 "\n"
      sec_num = $0; sub(/^### CR-/, "", sec_num); sub(/:.*$/, "", sec_num)
      sec_title = $0; sub(/^### /, "", sec_title)
      next
    }
    /^#{1,3} / {
      flush()
      print $0 > out_claude
      next
    }
    {
      if (in_sec) { body = body "\n" $0; sec_raw = sec_raw $0 "\n" }
      else        { print $0 > out_claude }
    }
    END { flush() }
  ' "$CLAUDE_MD"
}

# ---------------------------------------------------------------------------
# Dry-run: run the transform into temp files, report, discard.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  TMP_CLAUDE=$(mktemp); TMP_REF=$(mktemp); TMP_REPORT=$(mktemp)
  trap 'rm -f "$TMP_CLAUDE" "$TMP_REF" "$TMP_REPORT"' EXIT
  transform "$TMP_CLAUDE" "$TMP_REF" "$TMP_REPORT"
  PROJECTED_SIZE=$(wc -c < "$TMP_CLAUDE" | tr -d ' ')
  # The Load Instructions row adds a few bytes; account for it if not present.
  ROW="| Reference | canonical-rules-detail.md | .claude/$REF_REL |"
  if ! grep -qF "$REF_REL" "$TMP_CLAUDE"; then
    PROJECTED_SIZE=$((PROJECTED_SIZE + ${#ROW} + 1))
  fi
  echo "=============================================="
  echo "claude-md-autosplit --dry-run"
  echo "=============================================="
  echo "Movable '### CR-NN:' sections: $MOVABLE_COUNT"
  echo ""
  while IFS=$'\t' read -r num title ob pb; do
    echo "  - CR-${num}: ${title}  (${ob} bytes -> pointer ${pb} bytes)"
  done < "$TMP_REPORT"
  echo ""
  echo "Current size   : $CURRENT_SIZE chars"
  echo "Projected size : $PROJECTED_SIZE chars (after move + Load Instructions row)"
  echo ""
  echo "(dry-run — no files written)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Apply.
# ---------------------------------------------------------------------------
mkdir -p "$REF_DIR"

# Seed the reference file header if absent / unmanaged.
if [ ! -f "$REF_FILE" ] || ! grep -qF "$REF_HEADER_MARKER" "$REF_FILE"; then
  {
    echo "$REF_HEADER_MARKER"
    echo ""
    echo "> This file holds the longform \`### CR-NN:\` detail bodies that were moved"
    echo "> out of the always-loaded \`.claude/CLAUDE.md\` to keep it under the size"
    echo "> budget (${PLAN_NOTE})."
    echo ">"
    echo "> The canonical CR/VR summary tables remain inline in CLAUDE.md as the"
    echo "> single-source-of-truth index; this file is loaded on demand via the"
    echo "> CLAUDE.md \`## Load Instructions\` table when a command needs the full"
    echo "> rule detail. Each section below appears verbatim under its original"
    echo "> \`### CR-NN:\` heading (GitHub anchor \`#cr-NN\`)."
    echo ""
    echo "---"
    echo ""
  } > "$REF_FILE"
fi

NEW_CLAUDE=$(mktemp); APPEND_REF=$(mktemp); REPORT=$(mktemp)
trap 'rm -f "$NEW_CLAUDE" "$APPEND_REF" "$REPORT"' EXIT

transform "$NEW_CLAUDE" "$APPEND_REF" "$REPORT"

# Append the moved bodies to the reference file.
if [ -s "$APPEND_REF" ]; then
  cat "$APPEND_REF" >> "$REF_FILE"
fi

# Add ONE Load Instructions row (plain-path cell, no markdown link) if absent.
if ! grep -qF "| Reference | canonical-rules-detail.md |" "$NEW_CLAUDE"; then
  INSERTED=$(mktemp)
  trap 'rm -f "$NEW_CLAUDE" "$APPEND_REF" "$REPORT" "$INSERTED"' EXIT
  awk -v rel=".claude/$REF_REL" '
    { print }
    /^\| Reference \| patterns-quickref\.md \|/ && !done {
      print "| Reference | canonical-rules-detail.md | " rel " |"
      done = 1
    }
  ' "$NEW_CLAUDE" > "$INSERTED"
  mv "$INSERTED" "$NEW_CLAUDE"
fi

mv "$NEW_CLAUDE" "$CLAUDE_MD"

FINAL_SIZE=$(wc -c < "$CLAUDE_MD" | tr -d ' ')
echo "[autosplit] Moved $MOVABLE_COUNT '### CR-NN:' detail section(s) to $REF_REL"
echo "[autosplit] CLAUDE.md: $CURRENT_SIZE -> $FINAL_SIZE chars"
echo "[autosplit] Reference: $REF_FILE"
exit 0

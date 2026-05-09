#!/usr/bin/env bash
#
# massu-plan-status-validator.sh - Plan-file Schema Validator
#
# Plan 1.5.8 / Plan 2026-05-09-stale-plan-status-drift-guard P1-001:
# Validates every docs/plans/*.md file's frontmatter against the §4
# Status enum and the **Plan Token** field requirement, plus per-status
# citations (SHA for SHIPPED/IMPLEMENTED, optional path for SUPERSEDED).
#
# Exit 0 = PASS (or only warnings), Exit 1 = FAIL.
#
# Usage:
#   bash scripts/massu-plan-status-validator.sh [--json] [--help]
#
# Env overrides:
#   MASSU_PLAN_DIR    - override default docs/plans/ glob root
#                       (used by P3-003 staged-tree gate + tests)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_DIR="${MASSU_PLAN_DIR:-$REPO_ROOT/docs/plans}"

JSON_MODE=0
for arg in "$@"; do
  case "$arg" in
    --json)
      JSON_MODE=1
      ;;
    --help|-h)
      cat <<EOF
massu-plan-status-validator.sh - Plan-file Schema Validator

Validates every <PLAN_DIR>/*.md frontmatter against:
  - §4 Status enum (DRAFT, IN PROGRESS, SHIPPED, COMPLETE, IMPLEMENTED,
    APPROVED, SUPERSEDED, HISTORICAL DRAFT)
  - Mandatory **Plan Token**: field (lowercase, hyphen-cased,
    matches ^plan-[a-z0-9._-]+$, unique across corpus)
  - SHIPPED/IMPLEMENTED: requires >=1 7-char SHA citation in Status line
  - SUPERSEDED: warns if no docs/plans/...md path is cited

Exit 0 = PASS (or only warnings), Exit 1 = FAIL.

Usage:
  bash scripts/massu-plan-status-validator.sh [--json]

Env:
  MASSU_PLAN_DIR    Override default docs/plans/ glob root.
EOF
      exit 0
      ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

VIOLATIONS=0
WARNINGS=0

# Disable colors in JSON mode for clean machine output.
if [ "$JSON_MODE" = "1" ]; then
  RED=""; GREEN=""; YELLOW=""; NC=""
fi

pass_msg() { [ "$JSON_MODE" = "1" ] || echo -e "  ${GREEN}PASS${NC}: $1"; }
fail_msg() { [ "$JSON_MODE" = "1" ] || echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn_msg() { [ "$JSON_MODE" = "1" ] || echo -e "  ${YELLOW}WARN${NC}: $1"; WARNINGS=$((WARNINGS + 1)); }

# JSON-mode collectors (one record per file: status code + message).
JSON_RECORDS=()

json_record() {
  # $1 = path  $2 = level (PASS|FAIL|WARN)  $3 = message
  local path="$1" level="$2" msg="$3"
  # Escape backslashes and quotes for JSON.
  local esc_msg
  esc_msg=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  local esc_path
  esc_path=$(printf '%s' "$path" | sed 's/\\/\\\\/g; s/"/\\"/g')
  JSON_RECORDS+=("{\"path\":\"$esc_path\",\"level\":\"$level\",\"message\":\"$esc_msg\"}")
  if [ "$level" = "FAIL" ]; then
    VIOLATIONS=$((VIOLATIONS + 1))
  elif [ "$level" = "WARN" ]; then
    WARNINGS=$((WARNINGS + 1))
  fi
}

# ------------------------------------------------------------------
# Frontmatter parser (also sourced by massu-plan-commit-drift.sh).
#
# Functions:
#   massu_extract_status_line  <file>  -> echoes the **Status**: line
#                                          stripped of leading **Status**:
#                                          and surrounding whitespace
#   massu_extract_plan_tokens  <file>  -> echoes one normalized token per line
#   massu_status_canonical     <raw>   -> echoes one of the 8 enum values,
#                                          OR empty + non-zero exit on miss
#
# All parsers operate on the first 30 lines of the file (the contiguous
# bold-key block at the top per §4.1 P4-001 step 8 insertion-position).
# ------------------------------------------------------------------

massu_extract_status_line() {
  local file="$1"
  # Pull first 30 lines, find the first **Status**: line, strip prefix.
  head -n 30 "$file" 2>/dev/null \
    | grep -m 1 -E '^\*\*Status\*\*:' \
    | LC_ALL=C sed -E 's/^\*\*Status\*\*:[[:space:]]*//'
}

massu_extract_plan_tokens() {
  local file="$1"
  # All **Plan Token**: lines (multi-token plans allowed per P4-001 §3).
  # Strip prefix, optional leading/trailing whitespace, optional surrounding
  # backticks, and any trailing free-text annotation after the first
  # whitespace-separated token (so `plan-foo (alias — note)` -> `plan-foo`).
  head -n 30 "$file" 2>/dev/null \
    | grep -E '^\*\*Plan Token\*\*:' \
    | LC_ALL=C sed -E '
        s/^\*\*Plan Token\*\*:[[:space:]]*//;
        s/[[:space:]]+$//;
        s/^`(.*)`[[:space:]]*$/\1/;
      ' \
    | awk '{ print $1 }' \
    | LC_ALL=C sed -E 's/^`(.*)`$/\1/'
}

massu_status_canonical() {
  # Strip leading whitespace + non-alphanumeric run (covers emoji, percent
  # signs). Match longest-prefix-first so `IN PROGRESS` beats `IMPLEMENTED`,
  # `HISTORICAL DRAFT` beats `DRAFT`, and `100% COMPLETE` /
  # `AUDIT PASS N COMPLETE` collapse to `COMPLETE`.
  local raw="$1"
  local stripped
  stripped=$(printf '%s' "$raw" | LC_ALL=C sed -E 's/^[^A-Za-z0-9]+//')
  case "$stripped" in
    'HISTORICAL DRAFT'*)
      echo "HISTORICAL DRAFT"; return 0 ;;
    'IN PROGRESS'*)
      echo "IN PROGRESS"; return 0 ;;
    'IMPLEMENTED'*)
      echo "IMPLEMENTED"; return 0 ;;
    'SUPERSEDED'*)
      echo "SUPERSEDED"; return 0 ;;
    'APPROVED'*)
      echo "APPROVED"; return 0 ;;
    'SHIPPED'*)
      echo "SHIPPED"; return 0 ;;
    'DRAFT'*)
      echo "DRAFT"; return 0 ;;
    'COMPLETE'*)
      echo "COMPLETE"; return 0 ;;
    *'COMPLETE'*)
      # Catches `100% COMPLETE`, `AUDIT PASS N COMPLETE`,
      # `Claude-side, ... COMPLETE` etc.
      echo "COMPLETE"; return 0 ;;
    *)
      echo ""; return 1 ;;
  esac
}

# Allow this file to be sourced (parser-only mode) without running checks.
# Sister script massu-plan-commit-drift.sh sources us for the parser fns.
if [ "${MASSU_VALIDATOR_PARSER_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

[ "$JSON_MODE" = "1" ] || echo "=== Massu Plan Status Validator ==="
[ "$JSON_MODE" = "1" ] || echo "Plan dir: $PLAN_DIR"
[ "$JSON_MODE" = "1" ] || echo ""

# Collect plan files. Use globbing inside the dir; tolerate empty dir.
shopt -s nullglob
PLAN_FILES=("$PLAN_DIR"/*.md)
shopt -u nullglob

if [ "${#PLAN_FILES[@]}" -eq 0 ]; then
  if [ "$JSON_MODE" = "1" ]; then
    echo "{\"summary\":{\"total\":0,\"violations\":0,\"warnings\":0},\"records\":[]}"
  else
    warn_msg "No plan files found under $PLAN_DIR"
    echo ""
    echo "=== Plan Status Validator Summary ==="
    echo -e "${GREEN}PASS${NC}: 0 violation(s), 1 warning(s) (no plan files)"
  fi
  exit 0
fi

# Track Plan Tokens (primary) for cross-file uniqueness.
# Two parallel arrays since associative arrays are bash-4-only.
TOKEN_KEYS=()
TOKEN_FILES=()

token_lookup_index() {
  # echo index in TOKEN_KEYS where $1 is found, or empty
  local needle="$1"
  local i
  for i in "${!TOKEN_KEYS[@]}"; do
    if [ "${TOKEN_KEYS[$i]}" = "$needle" ]; then
      echo "$i"
      return 0
    fi
  done
  echo ""
  return 1
}

# Side artifact: emit canonical frontmatter template (R6 mitigation).
# Only when running against the real corpus (default PLAN_DIR), to avoid
# overwriting from inside test fixtures.
if [ "$PLAN_DIR" = "$REPO_ROOT/docs/plans" ]; then
  TEMPLATE_DIR="$REPO_ROOT/.claude/templates"
  TEMPLATE_FILE="$TEMPLATE_DIR/plan-frontmatter.md"
  if [ ! -f "$TEMPLATE_FILE" ]; then
    mkdir -p "$TEMPLATE_DIR" 2>/dev/null || true
    cat > "$TEMPLATE_FILE" <<'TEMPLATE_EOF'
# Plan <N.N.N>: <Short Title>

**Date**: YYYY-MM-DD
**Plan Token**: `plan-<short-slug>`
**Status**: 📋 DRAFT — awaiting approval
**Author**: <Name>
**Repo**: `/path/to/repo`

<!-- Body of plan goes here. -->

## 0. Pre-plan Self-Attest

## 1. Where We Are

## 2. Boundaries

## 3. Scope

## 4. Items

## 5. Verification
TEMPLATE_EOF
  fi
fi

# ------------------------------------------------------------------
# Per-file validation loop
# ------------------------------------------------------------------
for f in "${PLAN_FILES[@]}"; do
  rel_path="${f#"$REPO_ROOT/"}"
  file_violations=0

  # --- Status header ---
  status_raw=$(massu_extract_status_line "$f")
  if [ -z "$status_raw" ]; then
    msg="$rel_path: missing **Status**: header (see template at .claude/templates/plan-frontmatter.md)"
    if [ "$JSON_MODE" = "1" ]; then
      json_record "$rel_path" "FAIL" "$msg"
    else
      fail_msg "$msg"
    fi
    file_violations=$((file_violations + 1))
    continue
  fi

  status_canon=$(massu_status_canonical "$status_raw") || true
  if [ -z "$status_canon" ]; then
    msg="$rel_path: unknown Status enum value (got: '$status_raw'). Allowed: DRAFT, IN PROGRESS, SHIPPED, IMPLEMENTED, COMPLETE, APPROVED, SUPERSEDED, HISTORICAL DRAFT"
    if [ "$JSON_MODE" = "1" ]; then
      json_record "$rel_path" "FAIL" "$msg"
    else
      fail_msg "$msg"
    fi
    file_violations=$((file_violations + 1))
  fi

  # --- Plan Token field ---
  tokens_raw=$(massu_extract_plan_tokens "$f")
  if [ -z "$tokens_raw" ]; then
    msg="$rel_path: missing **Plan Token**: field (see template at .claude/templates/plan-frontmatter.md)"
    if [ "$JSON_MODE" = "1" ]; then
      json_record "$rel_path" "FAIL" "$msg"
    else
      fail_msg "$msg"
    fi
    file_violations=$((file_violations + 1))
  else
    primary_token=$(printf '%s\n' "$tokens_raw" | head -n 1)
    # Validate token shape
    if ! printf '%s' "$primary_token" | LC_ALL=C grep -qE '^plan-[a-z0-9._-]+$'; then
      msg="$rel_path: Plan Token '$primary_token' does not match ^plan-[a-z0-9._-]+\$"
      if [ "$JSON_MODE" = "1" ]; then
        json_record "$rel_path" "FAIL" "$msg"
      else
        fail_msg "$msg"
      fi
      file_violations=$((file_violations + 1))
    fi

    # Uniqueness check across corpus (primary token only).
    existing_idx=$(token_lookup_index "$primary_token")
    if [ -n "$existing_idx" ]; then
      msg="$rel_path: duplicate Plan Token '$primary_token' — already declared in ${TOKEN_FILES[$existing_idx]}"
      if [ "$JSON_MODE" = "1" ]; then
        json_record "$rel_path" "FAIL" "$msg"
      else
        fail_msg "$msg"
      fi
      file_violations=$((file_violations + 1))
    else
      TOKEN_KEYS+=("$primary_token")
      TOKEN_FILES+=("$rel_path")
    fi

    # Aliases also enforce shape + uniqueness against primary tokens (G10).
    while IFS= read -r alias_token; do
      [ -z "$alias_token" ] && continue
      if [ "$alias_token" = "$primary_token" ]; then continue; fi
      if ! printf '%s' "$alias_token" | LC_ALL=C grep -qE '^plan-[a-z0-9._-]+$'; then
        msg="$rel_path: Plan Token alias '$alias_token' does not match ^plan-[a-z0-9._-]+\$"
        if [ "$JSON_MODE" = "1" ]; then
          json_record "$rel_path" "FAIL" "$msg"
        else
          fail_msg "$msg"
        fi
        file_violations=$((file_violations + 1))
      fi
      existing_alias_idx=$(token_lookup_index "$alias_token")
      if [ -n "$existing_alias_idx" ]; then
        msg="$rel_path: alias Plan Token '$alias_token' duplicates a primary already declared in ${TOKEN_FILES[$existing_alias_idx]}"
        if [ "$JSON_MODE" = "1" ]; then
          json_record "$rel_path" "FAIL" "$msg"
        else
          fail_msg "$msg"
        fi
        file_violations=$((file_violations + 1))
      fi
    done < <(printf '%s\n' "$tokens_raw" | tail -n +2)
  fi

  # --- Per-status citation requirements ---
  case "$status_canon" in
    SHIPPED|IMPLEMENTED)
      if ! printf '%s' "$status_raw" | LC_ALL=C grep -qE '\b[a-f0-9]{7,40}\b'; then
        msg="$rel_path: Status '$status_canon' must cite at least one 7-40 char commit SHA in the Status line"
        if [ "$JSON_MODE" = "1" ]; then
          json_record "$rel_path" "FAIL" "$msg"
        else
          fail_msg "$msg"
        fi
        file_violations=$((file_violations + 1))
      fi
      ;;
    SUPERSEDED)
      if ! printf '%s' "$status_raw" | LC_ALL=C grep -qE 'docs/plans/[A-Za-z0-9._/-]+\.md'; then
        msg="$rel_path: Status SUPERSEDED should cite a successor docs/plans/...md path (warn-only)"
        if [ "$JSON_MODE" = "1" ]; then
          json_record "$rel_path" "WARN" "$msg"
        else
          warn_msg "$msg"
        fi
      fi
      ;;
    COMPLETE)
      # COMPLETE is a legacy synonym of SHIPPED; warn + suggest migration.
      msg="$rel_path: Status 'COMPLETE' is a legacy synonym of SHIPPED — consider migrating to SHIPPED for clarity"
      if [ "$JSON_MODE" = "1" ]; then
        json_record "$rel_path" "WARN" "$msg"
      else
        warn_msg "$msg"
      fi
      ;;
  esac

  # --- Deprecated Doc ID / Plan ID fields ---
  if head -n 30 "$f" 2>/dev/null | LC_ALL=C grep -qE '^\*\*Doc ID\*\*:'; then
    msg="$rel_path: **Doc ID**: is deprecated — use **Plan Token**: as authoritative key (Doc ID preserved for backward compatibility)"
    if [ "$JSON_MODE" = "1" ]; then
      json_record "$rel_path" "WARN" "$msg"
    else
      warn_msg "$msg"
    fi
  fi
  if head -n 30 "$f" 2>/dev/null | LC_ALL=C grep -qE '^\*\*Plan ID\*\*:'; then
    msg="$rel_path: **Plan ID**: is deprecated — use **Plan Token**: as authoritative key (Plan ID preserved for backward compatibility)"
    if [ "$JSON_MODE" = "1" ]; then
      json_record "$rel_path" "WARN" "$msg"
    else
      warn_msg "$msg"
    fi
  fi

  if [ "$file_violations" -eq 0 ] && [ "$JSON_MODE" != "1" ]; then
    pass_msg "$rel_path"
  fi
done

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
if [ "$JSON_MODE" = "1" ]; then
  total=${#PLAN_FILES[@]}
  records_joined=""
  if [ "${#JSON_RECORDS[@]}" -gt 0 ]; then
    records_joined=$(printf '%s,' "${JSON_RECORDS[@]}")
    records_joined=${records_joined%,}
  fi
  printf '{"summary":{"total":%d,"violations":%d,"warnings":%d},"records":[%s]}\n' \
    "$total" "$VIOLATIONS" "$WARNINGS" "$records_joined"
else
  echo ""
  echo "=== Plan Status Validator Summary ==="
  echo "Files scanned: ${#PLAN_FILES[@]}"
  if [ "$VIOLATIONS" -gt 0 ]; then
    echo -e "${RED}FAIL${NC}: $VIOLATIONS violation(s), $WARNINGS warning(s)"
    exit 1
  else
    echo -e "${GREEN}PASS${NC}: 0 violation(s), $WARNINGS warning(s)"
    exit 0
  fi
fi

if [ "$VIOLATIONS" -gt 0 ]; then
  exit 1
fi
exit 0

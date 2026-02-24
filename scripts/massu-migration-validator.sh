#!/usr/bin/env bash
#
# massu-migration-validator.sh - Massu Migration Health Check
#
# Validates Supabase migration files: sequential numbering, RLS coverage.
# Exit 0 = ordering correct + 100% RLS, Exit 1 = issues found
#
# Usage: bash scripts/massu-migration-validator.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/website/supabase/migrations"
VIOLATIONS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }
info() { echo -e "  ${BLUE}INFO${NC}: $1"; }

echo "=== Massu Migration Validator ==="
echo ""

# -------------------------------------------------------
# Pre-check: migrations directory exists
# -------------------------------------------------------
if [ ! -d "$MIGRATIONS_DIR" ]; then
  warn "No migrations directory found at website/supabase/migrations/"
  echo ""
  echo "=== Migration Validator Summary ==="
  echo -e "  ${YELLOW}SKIP: No migrations to validate${NC}"
  exit 0
fi

# -------------------------------------------------------
# Inventory: list all migration files
# -------------------------------------------------------
echo "--- Migration Inventory ---"
echo ""

MIGRATION_COUNT=0
MIGRATION_FILES=()
MIGRATION_NUMBERS=()

while IFS= read -r MIGRATION_FILE; do
  MIGRATION_COUNT=$((MIGRATION_COUNT + 1))
  MIGRATION_FILES+=("$MIGRATION_FILE")
  FILE_NAME=$(basename "$MIGRATION_FILE")
  # Extract the numeric prefix (e.g., "001" from "001_initial_schema.sql")
  PREFIX_NUM=$(echo "$FILE_NAME" | grep -oE '^[0-9]+' || echo "")
  MIGRATION_NUMBERS+=("$PREFIX_NUM")
  info "$FILE_NAME"
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name "*.sql" -type f | sort)

echo ""
echo "  Total migrations: $MIGRATION_COUNT"
echo ""

if [ "$MIGRATION_COUNT" -eq 0 ]; then
  warn "No migration files found"
  echo ""
  echo "=== Migration Validator Summary ==="
  echo -e "  ${YELLOW}SKIP: No migrations to validate${NC}"
  exit 0
fi

# -------------------------------------------------------
# Check 1: Sequential numbering (no gaps, no duplicates)
# -------------------------------------------------------
echo "--- Check 1: Sequential Numbering ---"
echo ""

ORDERING_OK=true
PREV_NUM=0

for i in $(seq 0 $((MIGRATION_COUNT - 1))); do
  NUM_STR="${MIGRATION_NUMBERS[$i]}"
  if [ -z "$NUM_STR" ]; then
    fail "Migration file has no numeric prefix: $(basename "${MIGRATION_FILES[$i]}")"
    ORDERING_OK=false
    continue
  fi

  # Remove leading zeros for arithmetic
  CURRENT_NUM=$((10#$NUM_STR))

  if [ "$i" -eq 0 ]; then
    # First migration should start at 1
    if [ "$CURRENT_NUM" -ne 1 ]; then
      warn "First migration starts at $CURRENT_NUM (expected 1)"
    fi
  else
    EXPECTED=$((PREV_NUM + 1))
    if [ "$CURRENT_NUM" -eq "$PREV_NUM" ]; then
      fail "Duplicate migration number: $CURRENT_NUM ($(basename "${MIGRATION_FILES[$i]}"))"
      ORDERING_OK=false
    elif [ "$CURRENT_NUM" -ne "$EXPECTED" ]; then
      fail "Gap in numbering: expected $EXPECTED, got $CURRENT_NUM ($(basename "${MIGRATION_FILES[$i]}"))"
      ORDERING_OK=false
    fi
  fi
  PREV_NUM=$CURRENT_NUM
done

if [ "$ORDERING_OK" = true ]; then
  pass "Sequential numbering: 1 through $PREV_NUM (no gaps, no duplicates)"
else
  fail "Sequential numbering has issues (see above)"
fi
echo ""

# -------------------------------------------------------
# Check 2: RLS coverage for CREATE TABLE statements
# -------------------------------------------------------
echo "--- Check 2: Row Level Security Coverage ---"
echo ""

TOTAL_TABLES=0
TABLES_WITH_RLS=0

printf "  %-35s %-20s %s\n" "TABLE" "DEFINED IN" "RLS"
printf "  %-35s %-20s %s\n" "-----" "----------" "---"

for i in $(seq 0 $((MIGRATION_COUNT - 1))); do
  MIGRATION_FILE="${MIGRATION_FILES[$i]}"
  FILE_NAME=$(basename "$MIGRATION_FILE")

  # Extract table names from CREATE TABLE statements using sed (macOS compatible)
  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    # Extract table name: "CREATE TABLE [IF NOT EXISTS] [public.]tablename"
    TABLE_NAME=$(echo "$LINE" | sed -E 's/.*CREATE TABLE( IF NOT EXISTS)?( public\.)?[ ]*([a-z_]+).*/\3/')
    [ -z "$TABLE_NAME" ] && continue

    TOTAL_TABLES=$((TOTAL_TABLES + 1))

    # Search all migration files for ALTER TABLE <name> ENABLE ROW LEVEL SECURITY
    RLS_FOUND=false
    for MIG_FILE in "${MIGRATION_FILES[@]}"; do
      if grep -q "ALTER TABLE.*${TABLE_NAME}.*ENABLE ROW LEVEL SECURITY" "$MIG_FILE" 2>/dev/null; then
        RLS_FOUND=true
        break
      fi
    done

    if [ "$RLS_FOUND" = true ]; then
      TABLES_WITH_RLS=$((TABLES_WITH_RLS + 1))
      printf "  %-35s %-20s ${GREEN}%s${NC}\n" "$TABLE_NAME" "$FILE_NAME" "ENABLED"
    else
      printf "  %-35s %-20s ${RED}%s${NC}\n" "$TABLE_NAME" "$FILE_NAME" "MISSING"
    fi
  done < <(grep -E 'CREATE TABLE' "$MIGRATION_FILE" 2>/dev/null || true)
done

echo ""

if [ "$TOTAL_TABLES" -gt 0 ]; then
  RLS_PCT=$((TABLES_WITH_RLS * 100 / TOTAL_TABLES))
  echo "  Tables found:     $TOTAL_TABLES"
  echo "  Tables with RLS:  $TABLES_WITH_RLS"
  echo "  RLS coverage:     $RLS_PCT%"
  echo ""

  if [ "$RLS_PCT" -eq 100 ]; then
    pass "RLS coverage: $TABLES_WITH_RLS/$TOTAL_TABLES tables (100%)"
  else
    fail "RLS coverage: $TABLES_WITH_RLS/$TOTAL_TABLES tables ($RLS_PCT%) — expected 100%"
  fi
else
  info "No CREATE TABLE statements found in migrations"
fi

echo ""

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo "=== Migration Validator Summary ==="
echo "  Migrations:   $MIGRATION_COUNT"
if [ "$ORDERING_OK" = true ]; then
  echo -e "  Ordering:     ${GREEN}Sequential${NC}"
else
  echo -e "  Ordering:     ${RED}Issues found${NC}"
fi
if [ "$TOTAL_TABLES" -gt 0 ]; then
  RLS_PCT=$((TABLES_WITH_RLS * 100 / TOTAL_TABLES))
  if [ "$RLS_PCT" -eq 100 ]; then
    echo -e "  RLS Coverage: ${GREEN}${RLS_PCT}%${NC}"
  else
    echo -e "  RLS Coverage: ${RED}${RLS_PCT}%${NC}"
  fi
fi
echo ""

if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}FAIL: $VIOLATIONS issue(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All migration checks passed${NC}"
  exit 0
fi

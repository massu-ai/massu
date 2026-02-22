#!/usr/bin/env bash
#
# massu-security-scanner.sh - Massu Quick Security Scanner
#
# Fast grep-based security checks across the codebase.
# Complements the deeper /massu-security-scan command.
# Exit 0 = PASS (no violations), Exit 1 = FAIL (violations found)
#
# Usage: bash scripts/massu-security-scanner.sh

# errexit (-e) intentionally omitted: script tracks violations via counter and uses || true patterns
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_SRC="$REPO_ROOT/packages/core/src"
WEBSITE_SRC="$REPO_ROOT/website/src"
MIGRATIONS_DIR="$REPO_ROOT/website/supabase/migrations"
API_DIR="$REPO_ROOT/website/src/app/api"
VIOLATIONS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}: $1"; }

echo "=== Massu Security Scanner ==="
echo ""

# -------------------------------------------------------
# Check 1: Hardcoded secrets (API keys, passwords)
# -------------------------------------------------------
echo "Check 1: No hardcoded secrets in source"
SECRET_COUNT=0
for DIR in "$CORE_SRC" "$WEBSITE_SRC"; do
  if [ -d "$DIR" ]; then
    COUNT=$(grep -rn 'sk-[a-zA-Z0-9]\{20,\}' "$DIR" --include="*.ts" --include="*.tsx" \
      | grep -v '__tests__' \
      | grep -v 'node_modules' \
      | grep -v '\.test\.ts' \
      | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask\|example\|placeholder' \
      | wc -l | tr -d ' ')
    SECRET_COUNT=$((SECRET_COUNT + COUNT))
    COUNT=$(grep -rn "password.*=.*['\"][^'\"]\{8,\}" "$DIR" --include="*.ts" --include="*.tsx" \
      | grep -v '__tests__' \
      | grep -v 'node_modules' \
      | grep -v '\.test\.ts' \
      | grep -v 'process\.env' \
      | grep -v 'RegExp\|regex\|REDACT\|redact\|sanitize\|mask\|schema\|zod\|type\|interface\|placeholder' \
      | grep -v 'htmlFor\|className\|label\|Label\|placeholder\|aria-\|data-\|autoComplete' \
      | wc -l | tr -d ' ')
    SECRET_COUNT=$((SECRET_COUNT + COUNT))
  fi
done
if [ "$SECRET_COUNT" -gt 0 ]; then
  fail "Found $SECRET_COUNT potential hardcoded secrets in source"
else
  pass "No hardcoded secrets found"
fi

# -------------------------------------------------------
# Check 2: innerHTML / dangerouslySetInnerHTML usage
# -------------------------------------------------------
echo "Check 2: No innerHTML / dangerouslySetInnerHTML in website"
INNER_HTML_COUNT=0
if [ -d "$WEBSITE_SRC" ]; then
  INNER_HTML_COUNT=$(grep -rn 'innerHTML\|dangerouslySetInnerHTML' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -v 'node_modules' \
    | grep -v '__tests__' \
    | grep -v '\.test\.ts' \
    | wc -l | tr -d ' ')
fi
if [ "$INNER_HTML_COUNT" -gt 0 ]; then
  fail "Found $INNER_HTML_COUNT innerHTML/dangerouslySetInnerHTML usage in website/src/"
  grep -rn 'innerHTML\|dangerouslySetInnerHTML' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -v 'node_modules' | grep -v '__tests__' | head -5
else
  pass "No innerHTML/dangerouslySetInnerHTML found"
fi

# -------------------------------------------------------
# Check 3: eval() usage
# -------------------------------------------------------
echo "Check 3: No eval() in source"
EVAL_COUNT=0
for DIR in "$CORE_SRC" "$WEBSITE_SRC"; do
  if [ -d "$DIR" ]; then
    COUNT=$(grep -rn '\beval(' "$DIR" --include="*.ts" --include="*.tsx" \
      | grep -v 'node_modules' \
      | grep -v '__tests__' \
      | grep -v '\.test\.ts' \
      | grep -v 'description.*eval\|pattern.*eval\|regex.*eval\|string.*eval' \
      | wc -l | tr -d ' ')
    EVAL_COUNT=$((EVAL_COUNT + COUNT))
  fi
done
if [ "$EVAL_COUNT" -gt 0 ]; then
  fail "Found $EVAL_COUNT eval() calls in source"
  for DIR in "$CORE_SRC" "$WEBSITE_SRC"; do
    if [ -d "$DIR" ]; then
      grep -rn '\beval(' "$DIR" --include="*.ts" --include="*.tsx" \
        | grep -v 'node_modules' | grep -v '__tests__' \
        | grep -v 'description.*eval\|pattern.*eval\|regex.*eval\|string.*eval' | head -3
    fi
  done
else
  pass "No eval() calls found"
fi

# -------------------------------------------------------
# Check 4: SQL template literals (potential injection)
# Detects backtick strings containing SQL keywords
# -------------------------------------------------------
echo "Check 4: No SQL in template literals"
SQL_TEMPLATE_COUNT=0
for DIR in "$CORE_SRC" "$WEBSITE_SRC"; do
  if [ -d "$DIR" ]; then
    COUNT=$(grep -rn '`[^`]*\(SELECT\|INSERT\|UPDATE\|DELETE\)[^`]*`' "$DIR" --include="*.ts" --include="*.tsx" \
      | grep -v 'node_modules' \
      | grep -v '__tests__' \
      | grep -v '\.test\.ts' \
      | grep -v '// ' \
      | wc -l | tr -d ' ')
    SQL_TEMPLATE_COUNT=$((SQL_TEMPLATE_COUNT + COUNT))
  fi
done
if [ "$SQL_TEMPLATE_COUNT" -gt 0 ]; then
  warn "Found $SQL_TEMPLATE_COUNT SQL statements in template literals (review for injection risk)"
  for DIR in "$CORE_SRC" "$WEBSITE_SRC"; do
    if [ -d "$DIR" ]; then
      grep -rn '`[^`]*\(SELECT\|INSERT\|UPDATE\|DELETE\)[^`]*`' "$DIR" --include="*.ts" --include="*.tsx" \
        | grep -v 'node_modules' | grep -v '__tests__' | head -3
    fi
  done
else
  pass "No SQL in template literals found"
fi

# -------------------------------------------------------
# Check 5: Missing auth in API routes
# Each route.ts under website/src/app/api/ should have auth.
# Known public/internally-authed routes are excluded:
#   - contact (public form)
#   - badge (public SVG)
#   - sso, sso/callback (SSO flow, token-based)
#   - stripe/webhook (Stripe signature verification)
#   - export (delegates to exportOrgData which authenticates internally)
# -------------------------------------------------------
echo "Check 5: Auth present in all API routes"
MISSING_AUTH=0
TOTAL_ROUTES=0
EXCLUDED_ROUTES=0
if [ -d "$API_DIR" ]; then
  while IFS= read -r ROUTE_FILE; do
    REL_PATH="${ROUTE_FILE#"$API_DIR"/}"
    # Skip known public or internally-authed routes
    case "$REL_PATH" in
      contact/*|badge/*|sso/*|stripe/webhook/*|export/*)
        EXCLUDED_ROUTES=$((EXCLUDED_ROUTES + 1))
        continue
        ;;
    esac
    TOTAL_ROUTES=$((TOTAL_ROUTES + 1))
    HAS_AUTH=$(grep -c 'createServerSupabaseClient\|authenticateApiKey\|authenticateApi\|getServerSession\|auth()' "$ROUTE_FILE" 2>/dev/null || true)
    if [ "$HAS_AUTH" -eq 0 ]; then
      MISSING_AUTH=$((MISSING_AUTH + 1))
      warn "  No auth found: ${ROUTE_FILE#"$REPO_ROOT"/}"
    fi
  done < <(find "$API_DIR" -name "route.ts" -type f 2>/dev/null)
fi
if [ "$TOTAL_ROUTES" -eq 0 ]; then
  pass "No API routes to check (skipped)"
elif [ "$MISSING_AUTH" -gt 0 ]; then
  fail "$MISSING_AUTH/$TOTAL_ROUTES API routes missing authentication ($EXCLUDED_ROUTES public routes excluded)"
else
  pass "All $TOTAL_ROUTES authenticated routes have auth ($EXCLUDED_ROUTES public routes excluded)"
fi

# -------------------------------------------------------
# Check 6: RLS coverage in migrations
# Every CREATE TABLE should have ENABLE ROW LEVEL SECURITY
# -------------------------------------------------------
echo "Check 6: RLS enabled for all tables in migrations"
TABLES_WITHOUT_RLS=0
TOTAL_TABLES=0
if [ -d "$MIGRATIONS_DIR" ]; then
  while IFS= read -r MIGRATION_FILE; do
    # Extract table names: grep for CREATE TABLE, then extract the table name
    while IFS= read -r LINE; do
      # Extract table name from "CREATE TABLE [IF NOT EXISTS] [public.]name"
      TABLE_NAME=$(echo "$LINE" | sed -E 's/.*CREATE TABLE( IF NOT EXISTS)?( public\.)?[ ]*([a-z_]+).*/\3/')
      [ -z "$TABLE_NAME" ] && continue
      TOTAL_TABLES=$((TOTAL_TABLES + 1))
      # Search all migration files for ALTER TABLE <name> ENABLE ROW LEVEL SECURITY
      TABLE_RLS=$(grep -l "ALTER TABLE.*${TABLE_NAME}.*ENABLE ROW LEVEL SECURITY" "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ')
      if [ "$TABLE_RLS" -eq 0 ]; then
        TABLES_WITHOUT_RLS=$((TABLES_WITHOUT_RLS + 1))
        warn "  Missing RLS: $TABLE_NAME (${MIGRATION_FILE##*/})"
      fi
    done < <(grep -E 'CREATE TABLE' "$MIGRATION_FILE" 2>/dev/null || true)
  done < <(find "$MIGRATIONS_DIR" -name "*.sql" -type f | sort)
fi
if [ "$TOTAL_TABLES" -eq 0 ]; then
  pass "No tables to check in migrations (skipped)"
elif [ "$TABLES_WITHOUT_RLS" -gt 0 ]; then
  fail "$TABLES_WITHOUT_RLS/$TOTAL_TABLES tables missing RLS"
else
  pass "All $TOTAL_TABLES tables have RLS enabled"
fi

# -------------------------------------------------------
# Check 7: NEXT_PUBLIC_ env vars containing secrets
# -------------------------------------------------------
echo "Check 7: No secrets in NEXT_PUBLIC_ env vars"
NEXT_PUBLIC_SECRET_COUNT=0
while IFS= read -r ENV_FILE; do
  COUNT=$(grep -ci 'NEXT_PUBLIC_.*SECRET\|NEXT_PUBLIC_.*PASSWORD\|NEXT_PUBLIC_.*PRIVATE' "$ENV_FILE" 2>/dev/null || true)
  NEXT_PUBLIC_SECRET_COUNT=$((NEXT_PUBLIC_SECRET_COUNT + COUNT))
  if [ "$COUNT" -gt 0 ]; then
    warn "  Suspect NEXT_PUBLIC_ var in: ${ENV_FILE#"$REPO_ROOT"/}"
  fi
done < <(find "$REPO_ROOT" -maxdepth 2 -name ".env*" -type f 2>/dev/null)
# Also check source for NEXT_PUBLIC_ with secret-like names
if [ -d "$WEBSITE_SRC" ]; then
  COUNT=$(grep -rn 'NEXT_PUBLIC_.*SECRET\|NEXT_PUBLIC_.*PASSWORD\|NEXT_PUBLIC_.*PRIVATE' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -v 'node_modules' \
    | wc -l | tr -d ' ')
  NEXT_PUBLIC_SECRET_COUNT=$((NEXT_PUBLIC_SECRET_COUNT + COUNT))
fi
if [ "$NEXT_PUBLIC_SECRET_COUNT" -gt 0 ]; then
  fail "Found $NEXT_PUBLIC_SECRET_COUNT NEXT_PUBLIC_ vars with secret/password/private names"
else
  pass "No secrets exposed via NEXT_PUBLIC_ env vars"
fi

# -------------------------------------------------------
# Check 8: No select('*') in API GET handlers
# -------------------------------------------------------
echo "Check 8: No select('*') in API GET handlers"
SELECT_STAR=0
if [ -d "$API_DIR" ]; then
  while IFS= read -r ROUTE_FILE; do
    HAS_GET=$(grep -c 'export.*function GET\|export.*GET' "$ROUTE_FILE" 2>/dev/null || true)
    HAS_SELECT_STAR=$(grep -c "select(['\"]\\*['\"])" "$ROUTE_FILE" 2>/dev/null || true)
    if [ "$HAS_GET" -gt 0 ] && [ "$HAS_SELECT_STAR" -gt 0 ]; then
      SELECT_STAR=$((SELECT_STAR + 1))
      warn "  select('*') in GET handler: ${ROUTE_FILE#"$REPO_ROOT"/}"
    fi
  done < <(find "$API_DIR" -name "route.ts" -type f 2>/dev/null)
fi
if [ "$SELECT_STAR" -gt 0 ]; then
  fail "$SELECT_STAR API GET routes use select('*')"
else
  pass "No select('*') in API GET handlers"
fi

# -------------------------------------------------------
# Check 9: No TODO/stub in auth code
# -------------------------------------------------------
echo "Check 9: No TODO/stub patterns in auth code"
AUTH_STUBS=0
if [ -d "$WEBSITE_SRC" ]; then
  AUTH_STUBS=$(grep -rn 'TODO\|FIXME\|In a full implementation\|stub\|placeholder' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -i 'auth\|sso\|login\|session\|token\|callback' \
    | grep -v 'node_modules' | grep -v '__tests__' \
    | wc -l | tr -d ' ')
fi
if [ "$AUTH_STUBS" -gt 0 ]; then
  fail "Found $AUTH_STUBS TODO/stub patterns in auth-related code"
else
  pass "No TODO/stub patterns in auth code"
fi

# -------------------------------------------------------
# Check 10: No silent catch in encryption code
# -------------------------------------------------------
echo "Check 10: No silent catch blocks in encryption/crypto code"
SILENT_CATCH=0
if [ -d "$WEBSITE_SRC" ]; then
  for CRYPTO_FILE in $(grep -rl 'encrypt\|decrypt\|crypto\|cipher' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | grep -v __tests__); do
    CATCH_COUNT=$(grep -c 'catch.*{' "$CRYPTO_FILE" 2>/dev/null || true)
    RETHROW_COUNT=$(grep -c 'throw\|console\.error\|logger\.' "$CRYPTO_FILE" 2>/dev/null || true)
    if [ "$CATCH_COUNT" -gt 0 ] && [ "$RETHROW_COUNT" -eq 0 ]; then
      SILENT_CATCH=$((SILENT_CATCH + 1))
      warn "  Possibly silent catch in crypto file: ${CRYPTO_FILE#"$REPO_ROOT"/}"
    fi
  done
fi
if [ "$SILENT_CATCH" -gt 0 ]; then
  fail "$SILENT_CATCH crypto files may have silent error handling"
else
  pass "No silent catch blocks in encryption code"
fi

# -------------------------------------------------------
# Check 11: SSRF - fetch() calls with dynamic URLs
# -------------------------------------------------------
echo "Check 11: SSRF - fetch() calls with dynamic URLs"
SSRF_RISK=0
if [ -d "$WEBSITE_SRC" ]; then
  SSRF_RISK=$(grep -rn 'fetch(' "$WEBSITE_SRC" --include="*.ts" --include="*.tsx" \
    | grep -v 'node_modules' | grep -v '__tests__' \
    | grep -v "fetch(['\"]https\?://" \
    | grep -v "fetch(['\"]/" \
    | grep -v 'fetchClient\|fetchApi\|supabase' \
    | wc -l | tr -d ' ')
fi
if [ "$SSRF_RISK" -gt 0 ]; then
  warn "Found $SSRF_RISK fetch() calls with potentially dynamic URLs (review for SSRF)"
else
  pass "No suspicious dynamic fetch() URLs found"
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo "=== Security Scanner Summary ==="
if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}FAIL: $VIOLATIONS security issue(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}PASS: All security checks passed${NC}"
  exit 0
fi

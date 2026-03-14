#!/usr/bin/env bash
# massu-deploy.sh — Autonomous deployment pipeline with pre-flight checks
# Usage: bash scripts/massu-deploy.sh [--dry-run]
#
# Steps:
#   1. Branch check (must be on main, clean working tree)
#   2. Project target verification (correct Vercel project)
#   3. Build dry-run (catch errors before deploying)
#   4. Deploy to Vercel production
#   5. Smoke test critical routes
#   6. Rollback guidance if smoke tests fail

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
WEBSITE_DIR="$PROJECT_DIR/website"
EXPECTED_PROJECT_ID="prj_Io7AaGCM27cwRQerAj3BdihUur1Y"
EXPECTED_PROJECT_NAME="massu"

PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { FAILED=$((FAILED + 1)); echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "  [INFO] $1"; }

echo "========================================"
echo "  Massu Deploy Pipeline"
echo "========================================"
echo ""

# Step 1: Branch check
echo "--- Step 1: Branch & Working Tree ---"
BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "unknown")
if [ "$BRANCH" = "main" ]; then
  pass "On branch: main"
else
  warn "On branch: $BRANCH (expected main)"
fi

DIRTY=$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$DIRTY" -eq 0 ]; then
  pass "Working tree is clean"
else
  fail "Working tree has $DIRTY uncommitted change(s)"
  git -C "$PROJECT_DIR" status --short 2>/dev/null | head -5
fi

# Step 2: Project target verification
echo ""
echo "--- Step 2: Vercel Project Target ---"
VERCEL_PROJECT_FILE="$WEBSITE_DIR/.vercel/project.json"
if [ -f "$VERCEL_PROJECT_FILE" ]; then
  ACTUAL_PROJECT_ID=$(jq -r '.projectId // empty' "$VERCEL_PROJECT_FILE")
  ACTUAL_PROJECT_NAME=$(jq -r '.projectName // empty' "$VERCEL_PROJECT_FILE")

  if [ "$ACTUAL_PROJECT_ID" = "$EXPECTED_PROJECT_ID" ]; then
    pass "Project ID matches: $EXPECTED_PROJECT_ID"
  else
    fail "Project ID mismatch! Expected: $EXPECTED_PROJECT_ID, Got: $ACTUAL_PROJECT_ID"
  fi

  if [ "$ACTUAL_PROJECT_NAME" = "$EXPECTED_PROJECT_NAME" ]; then
    pass "Project name matches: $EXPECTED_PROJECT_NAME"
  else
    fail "Project name mismatch! Expected: $EXPECTED_PROJECT_NAME, Got: $ACTUAL_PROJECT_NAME"
  fi
else
  fail "Vercel project file not found: $VERCEL_PROJECT_FILE"
  info "Run: cd website && npx vercel link"
fi

# Step 3: Build dry-run
echo ""
echo "--- Step 3: Local Build Verification ---"
if [ -d "$WEBSITE_DIR" ]; then
  info "Running: cd website && npm run build"
  if (cd "$WEBSITE_DIR" && npm run build 2>&1 | tail -10); then
    pass "Website build succeeded"
  else
    fail "Website build failed — fix errors before deploying"
  fi
else
  fail "Website directory not found: $WEBSITE_DIR"
fi

# Pre-flight gate
echo ""
echo "--- Pre-Flight Gate ---"
if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}PRE-FLIGHT FAILED: $FAILED check(s) failed. Aborting deploy.${NC}"
  exit 1
fi
echo -e "${GREEN}PRE-FLIGHT PASSED: $PASSED check(s) passed.${NC}"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo -e "${YELLOW}DRY RUN — skipping deploy and smoke tests.${NC}"
  exit 0
fi

# Step 4: Deploy
echo ""
echo "--- Step 4: Deploy to Production ---"
info "Running: cd website && npx vercel --prod --yes"
DEPLOY_OUTPUT=$(cd "$WEBSITE_DIR" && npx vercel --prod --yes 2>&1)
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.vercel\.app' | head -1)

if [ -n "$DEPLOY_URL" ]; then
  pass "Deployed to: $DEPLOY_URL"
else
  # Try to extract any URL
  DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^ ]+' | head -1)
  if [ -n "$DEPLOY_URL" ]; then
    pass "Deployed to: $DEPLOY_URL"
  else
    fail "Could not extract deployment URL from output"
    echo "$DEPLOY_OUTPUT" | tail -10
    exit 1
  fi
fi

# Step 5: Smoke tests
echo ""
echo "--- Step 5: Smoke Tests ---"
SMOKE_FAILED=0

for ROUTE in "/" "/docs"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${DEPLOY_URL}${ROUTE}" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    pass "GET ${ROUTE} -> ${STATUS}"
  else
    fail "GET ${ROUTE} -> ${STATUS} (expected 200)"
    SMOKE_FAILED=$((SMOKE_FAILED + 1))
  fi
done

# Check massu.ai as well
PROD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://massu.ai" 2>/dev/null || echo "000")
if [ "$PROD_STATUS" = "200" ]; then
  pass "GET https://massu.ai -> ${PROD_STATUS}"
else
  warn "GET https://massu.ai -> ${PROD_STATUS} (may need DNS propagation)"
fi

# Step 6: Final report
echo ""
echo "========================================"
if [ "$SMOKE_FAILED" -gt 0 ]; then
  echo -e "${RED}DEPLOY COMPLETE WITH SMOKE TEST FAILURES${NC}"
  echo ""
  echo "Rollback: npx vercel rollback --yes"
  echo "Previous deployments: npx vercel ls --prod"
  exit 1
else
  echo -e "${GREEN}DEPLOY COMPLETE — ALL CHECKS PASSED${NC}"
  echo "Production URL: $DEPLOY_URL"
  echo "Custom domain: https://massu.ai"
fi
echo "========================================"

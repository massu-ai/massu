#!/usr/bin/env bash
# massu-deploy.sh — Autonomous deployment pipeline with pre-flight checks
# Usage: bash scripts/massu-deploy.sh [--dry-run]
#
# Steps:
#   1. Branch check (must be on main, clean working tree)
#   2. Project target verification (correct Vercel project)
#   3. Build dry-run (catch errors before deploying)
#   4. Deploy to Vercel production
#   4.5. Alias propagation poll (fail-with-bypass; mirrors CR-48 staleness gate pattern)
#   5. Smoke test critical routes against PRODUCTION_HOST
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
PRODUCTION_HOST="${MASSU_PRODUCTION_HOST:-https://massu.ai}"
PRODUCTION_HOST="${PRODUCTION_HOST%/}"  # strip trailing slash to keep $PRODUCTION_HOST/$ROUTE clean
if [[ ! "$PRODUCTION_HOST" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "ERROR: MASSU_PRODUCTION_HOST is not a clean http(s)://host URL: $PRODUCTION_HOST" >&2
  exit 1
fi
ALIAS_PROPAGATION_TIMEOUT_SECS="${MASSU_ALIAS_PROPAGATION_TIMEOUT_SECS:-120}"
if [[ ! "$ALIAS_PROPAGATION_TIMEOUT_SECS" =~ ^[0-9]+$ ]] || [ "$ALIAS_PROPAGATION_TIMEOUT_SECS" -gt 600 ]; then
  echo "ERROR: MASSU_ALIAS_PROPAGATION_TIMEOUT_SECS must be a non-negative integer ≤ 600: $ALIAS_PROPAGATION_TIMEOUT_SECS" >&2
  exit 1
fi

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

  # Vercel CLI's .vercel/project.json does NOT include projectName by default
  # (only projectId + orgId). projectName is informational only. Skip the strict
  # match if absent; warn if present and mismatched. The projectId match above
  # is the canonical identity check.
  if [ -z "$ACTUAL_PROJECT_NAME" ]; then
    info "Project name not present in .vercel/project.json (expected — only projectId is canonical)"
  elif [ "$ACTUAL_PROJECT_NAME" = "$EXPECTED_PROJECT_NAME" ]; then
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
unset DEPLOY_OUTPUT  # release buffered vercel CLI stdout/stderr (may contain build-time data)

# Step 4.5: Alias propagation poll
# After `vercel --prod --yes` returns, the new deployment may not yet be the target
# of the production alias (e.g., https://massu.ai). Smoke testing PRODUCTION_HOST
# before the alias propagates would hit the PREVIOUS deploy. Poll `vercel ls --prod`
# until the new deploy's hostname prefix appears as the active production target.
#
# Why `vercel ls --prod` and not `x-vercel-deployment-url` header polling:
# verified 2026-05-15 — `curl -sI https://massu.ai/` returns `x-vercel-id` but
# does NOT return `x-vercel-deployment-url`. The header approach is unavailable
# on this Vercel project. The CLI uses already-authenticated state from Step 4.
echo ""
echo "--- Step 4.5: Alias Propagation ---"
DEPLOY_HOST_PREFIX=$(echo "$DEPLOY_URL" | sed -E 's|^https?://([^.]+)\..*|\1|')
SECS_WAITED=0
SLEEP_SECS=3
PROPAGATED=false
info "Polling Vercel for alias propagation: ${PRODUCTION_HOST} -> ${DEPLOY_HOST_PREFIX}"
while [ "$SECS_WAITED" -lt "$ALIAS_PROPAGATION_TIMEOUT_SECS" ]; do
  ALIAS_TARGET=$(cd "$WEBSITE_DIR" && npx vercel ls --prod 2>/dev/null | grep -oE "https://${DEPLOY_HOST_PREFIX}[a-zA-Z0-9.-]*\.vercel\.app" | head -1)
  if [ -n "$ALIAS_TARGET" ]; then
    pass "Alias propagated: ${PRODUCTION_HOST} now serving deploy ${DEPLOY_HOST_PREFIX}"
    PROPAGATED=true
    break
  fi
  info "Waiting for alias propagation (${SECS_WAITED}s elapsed)..."
  sleep "$SLEEP_SECS"
  SECS_WAITED=$((SECS_WAITED + SLEEP_SECS))
done
if [ "$PROPAGATED" = false ]; then
  # Fail-with-bypass on timeout (mirrors CR-48 staleness gate pattern in pre-push-light.sh
  # step 8). An earlier draft used warn-not-fail but that creates operator-acclimation
  # risk identical to the bug class CR-48 was created to eliminate. Bypass via
  # MASSU_SKIP_ALIAS_PROPAGATION_CHECK=1 logged to stderr for audit-trail visibility.
  if [ "${MASSU_SKIP_ALIAS_PROPAGATION_CHECK:-0}" = "1" ]; then
    warn "Alias propagation NOT confirmed within ${ALIAS_PROPAGATION_TIMEOUT_SECS}s; BYPASSED via MASSU_SKIP_ALIAS_PROPAGATION_CHECK=1."
    echo "AUDIT: MASSU_SKIP_ALIAS_PROPAGATION_CHECK=1 used at $(date -u +%Y-%m-%dT%H:%M:%SZ) for deploy ${DEPLOY_HOST_PREFIX}" >&2
  else
    fail "Alias propagation NOT confirmed within ${ALIAS_PROPAGATION_TIMEOUT_SECS}s via 'vercel ls'."
    echo "If 'vercel ls --prod' is genuinely broken (CLI auth lost, rate-limit, network),"
    echo "bypass via: MASSU_SKIP_ALIAS_PROPAGATION_CHECK=1 bash scripts/massu-deploy.sh"
    echo "Otherwise the new deploy may be stranded — investigate with: npx vercel ls --prod"
    exit 1
  fi
fi

# Step 5: Smoke tests
echo ""
echo "--- Step 5: Smoke Tests ---"
SMOKE_FAILED=0

for ROUTE in "/" "/docs" "/changelog" "/overview"; do
  # -L follows redirects (e.g., /docs → /docs/getting-started 307→200) so we
  # assert end-state reachability, not literal initial-response 200.
  STATUS=$(curl -sL -o /dev/null -w "%{http_code}" "${PRODUCTION_HOST}${ROUTE}" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    pass "GET ${PRODUCTION_HOST}${ROUTE} -> ${STATUS}"
  else
    fail "GET ${PRODUCTION_HOST}${ROUTE} -> ${STATUS} (expected 200)"
    SMOKE_FAILED=$((SMOKE_FAILED + 1))
  fi
done

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
  echo "Production target: $PRODUCTION_HOST"
fi
echo "========================================"

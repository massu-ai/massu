#!/usr/bin/env bash
#
# massu-deploy-edge-functions.sh — Deploy the API-key Supabase edge functions
# AND immediately prove they work with a real key (CR-60).
#
# WHY THIS EXISTS (incidents 2026-05-31-edge-bcrypt-worker-500 +
# 2026-07-06-validate-key-deploy-drift-500): the `validate-key` fix was in the
# repo for 5 weeks but the deployed bundle stayed stale/broken — HTTP 500 on
# every real key — with ZERO detection. `scripts/massu-deploy.sh` deploys the
# Vercel website, NOT the Supabase edge functions, so it could never catch this.
# This script makes "deployed but broken" IMPOSSIBLE to leave un-noticed: after
# every deploy it POSTs a known-good key to the live gateway and FAILS (non-zero
# exit) unless it validates to the expected tier — and probes a wrong key to
# confirm a clean 401 (not the 500 that the Worker crash produced).
#
# Usage:
#   bash scripts/massu-deploy-edge-functions.sh              # deploy all API-key fns, then smoke
#   bash scripts/massu-deploy-edge-functions.sh --smoke-only # skip deploy, run smoke only
#   bash scripts/massu-deploy-edge-functions.sh validate-key # deploy only the named fn, then smoke
#
# Required env (never hard-coded — the Supabase project ref must NOT live in a
# git-tracked, public-synced script; see CR-49 / leak-patterns.sh):
#   MASSU_SUPABASE_PROJECT_REF   Supabase project ref for the target project
#   MASSU_SMOKE_API_KEY          a known-good ms_live_ key for the smoke test (a secret)
# Optional env:
#   MASSU_SMOKE_ENDPOINT         default https://api.massu.ai/v1
#   MASSU_SMOKE_EXPECTED_TIER    default cloud-enterprise (validate-key's client-friendly tier)
#
set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
pass() { echo "${GREEN}PASS:${NC} $*"; }
warn() { echo "${YELLOW}WARN:${NC} $*"; }
fail() { echo "${RED}FAIL:${NC} $*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FN_DIR="$REPO_ROOT/website/supabase/functions"
ENDPOINT="${MASSU_SMOKE_ENDPOINT:-https://api.massu.ai/v1}"
EXPECTED_TIER="${MASSU_SMOKE_EXPECTED_TIER:-cloud-enterprise}"

# ── Parse args ────────────────────────────────────────────────────────────────
SMOKE_ONLY=0
ONLY_FN=""
for arg in "$@"; do
  case "$arg" in
    --smoke-only) SMOKE_ONLY=1 ;;
    --help|-h)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) fail "Unknown flag: $arg (see --help)" ;;
    *) ONLY_FN="$arg" ;;
  esac
done

# ── Derive the API-key function set from the filesystem (never a static list) ──
api_key_functions() {
  local d slug
  for d in "$FN_DIR"/*/; do
    slug="$(basename "$d")"
    [ "$slug" = "_shared" ] && continue
    if [ -f "$d/index.ts" ] && grep -q "verifyApiKeyHash" "$d/index.ts"; then
      echo "$slug"
    fi
  done
}

# ── Deploy phase ──────────────────────────────────────────────────────────────
if [ "$SMOKE_ONLY" -eq 0 ]; then
  : "${MASSU_SUPABASE_PROJECT_REF:?MASSU_SUPABASE_PROJECT_REF must be set (target Supabase project ref) — refusing to guess}"
  command -v supabase >/dev/null 2>&1 || fail "supabase CLI not found on PATH"

  if [ -n "$ONLY_FN" ]; then
    TARGETS="$ONLY_FN"
  else
    TARGETS="$(api_key_functions)"
  fi
  [ -n "$TARGETS" ] || fail "No API-key edge functions found to deploy"

  echo "Deploying API-key edge functions to project ref (from env)…"
  ( cd "$REPO_ROOT/website"
    for slug in $TARGETS; do
      echo "  → supabase functions deploy $slug"
      supabase functions deploy "$slug" --project-ref "$MASSU_SUPABASE_PROJECT_REF" >/dev/null
      pass "deployed $slug"
    done
  )
else
  warn "--smoke-only: skipping deploy"
fi

# ── Smoke phase: prove a real key validates, and a wrong key gets a clean 401 ──
: "${MASSU_SMOKE_API_KEY:?MASSU_SMOKE_API_KEY must be set (a known-good ms_live_ key) — cannot run the real-key smoke test without it}"

# The key prefix (ms_live_<8hex>_) is safe to derive for the wrong-body probe;
# the FULL key is never echoed or logged.
KEY_PREFIX="$(printf '%s' "$MASSU_SMOKE_API_KEY" | grep -oE '^ms_(live|test)_[0-9a-f]{8}_' || true)"
[ -n "$KEY_PREFIX" ] || fail "MASSU_SMOKE_API_KEY is not a well-formed ms_live_/ms_test_ key"

echo "Smoke-testing ${ENDPOINT}/validate-key…"

# 1. Real key → HTTP 200, valid:true, tier == expected.
REAL_BODY="$(curl -s --max-time 20 -w $'\n%{http_code}' -X POST "${ENDPOINT}/validate-key" \
  -H "Authorization: Bearer ${MASSU_SMOKE_API_KEY}" -H "Content-Type: application/json")"
REAL_CODE="$(printf '%s' "$REAL_BODY" | tail -n1)"
REAL_JSON="$(printf '%s' "$REAL_BODY" | sed '$d')"
[ "$REAL_CODE" = "200" ] || fail "real key returned HTTP ${REAL_CODE} (expected 200). Body: ${REAL_JSON} — the edge function is broken (deploy drift?)."
printf '%s' "$REAL_JSON" | grep -q '"valid":true' || fail "real key: response missing \"valid\":true. Body: ${REAL_JSON}"
GOT_TIER="$(printf '%s' "$REAL_JSON" | grep -oE '"tier":"[^"]*"' | head -n1 | sed 's/"tier":"//;s/"//')"
[ "$GOT_TIER" = "$EXPECTED_TIER" ] || fail "real key: tier '${GOT_TIER}' != expected '${EXPECTED_TIER}'"
pass "real key validates → HTTP 200, valid:true, tier=${GOT_TIER}"

# 2. Wrong-body key (real prefix) → HTTP 401 (NOT the 500 the Worker crash gave).
WRONG_CODE="$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -X POST "${ENDPOINT}/validate-key" \
  -H "Authorization: Bearer ${KEY_PREFIX}$(printf '0%.0s' {1..64})" -H "Content-Type: application/json")"
[ "$WRONG_CODE" = "401" ] || fail "wrong key returned HTTP ${WRONG_CODE} (expected 401). A 500 here means the async-compare Worker crash is back."
pass "wrong key → HTTP 401 (compareSync executes; no Worker crash)"

echo "${GREEN}Edge-function smoke test PASSED.${NC}"

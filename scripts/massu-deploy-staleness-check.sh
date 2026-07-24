#!/usr/bin/env bash
# massu-deploy-staleness-check.sh — plan-1.6.3-website-feature-discoverability P-C-001
#
# Verifies that the most recent commit touching website/ on origin/main is
# within MASSU_MAX_DEPLOY_LAG_SECS (default 86400 = 24h) of the most recent
# production Vercel deploy. If the lag exceeds the threshold, FAILs with a
# remedy command pointing at /massu-deploy.
#
# Eliminates the structural drift class where website/ changes ship to npm +
# git but never reach the live site (the 33-day-stale-deploy bug surfaced
# 2026-05-11; see plan-1.6.3-website-feature-discoverability).
#
# Safety rails:
#   - SKIPs with WARN (exit 0) if `vercel` CLI is unavailable or not
#     authenticated to `ethans-projects-22aee2ce`. Contributors without
#     Vercel auth should not be blocked from pushing feature branches.
#   - Hard FAIL only on `main`/`origin/main` branches AND when lag exceeds
#     the configured threshold. Feature branches get an informational
#     WARN, not a blocking failure.
#   - Bypassable via `MASSU_SKIP_DEPLOY_STALENESS_CHECK=1` (logged to
#     stderr for audit-trail visibility).

set -uo pipefail

# === Config ===
MAX_LAG_SECS="${MASSU_MAX_DEPLOY_LAG_SECS:-86400}"   # default 24h
VERCEL_PROJECT="${MASSU_VERCEL_PROJECT:-massu}"
VERCEL_ORG="${MASSU_VERCEL_ORG:-ethans-projects-22aee2ce}"

# === Optional bypass (logged) ===
if [ "${MASSU_SKIP_DEPLOY_STALENESS_CHECK:-0}" = "1" ]; then
  echo "[deploy-staleness] BYPASS via MASSU_SKIP_DEPLOY_STALENESS_CHECK=1 (logged for audit-trail)" >&2
  echo "SKIP: Bypassed by env-var (audit-trail logged to stderr)"
  exit 0
fi

# === Branch check: non-blocking on feature branches ===
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>&1 || echo "unknown")
IS_MAIN=0
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "origin/main" ]; then
  IS_MAIN=1
fi

# === Vercel CLI auth pre-flight ===
if ! command -v vercel >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  echo "WARN: neither 'vercel' nor 'npx' on PATH — cannot check deploy staleness"
  exit 0
fi

# Use whichever is available.
if command -v vercel >/dev/null 2>&1; then
  VERCEL_CMD="vercel"
else
  VERCEL_CMD="npx --yes vercel"
fi

# Check Vercel auth + correct org. `vercel whoami` returns 0 if authed.
if ! $VERCEL_CMD whoami >/dev/null 2>&1; then
  echo "SKIP: Vercel CLI not authenticated — run 'vercel login' (this gate only blocks if you can deploy)"
  exit 0
fi

# Check org membership via `vercel teams list` (output includes org slugs).
# here-string capture, not `… | grep -q` (broken-pipe-race-free under pipefail; incident 2026-07-16):
# a long teams list would SIGPIPE vercel when grep short-circuits, and pipefail would mis-report
# "not authenticated" even when the org IS present.
vercel_teams_list="$($VERCEL_CMD teams list 2>&1)"
if ! grep -q "$VERCEL_ORG" <<<"$vercel_teams_list"; then
  echo "SKIP: Vercel CLI not authenticated to '$VERCEL_ORG' — run 'vercel switch $VERCEL_ORG'"
  exit 0
fi

# === Most recent website-touching commit on origin/main ===
# CWD-INDEPENDENCE (incident 2026-07-23): `-- website/` is resolved RELATIVE TO CWD, so
# running this gate from any subdirectory (e.g. packages/core, as npm lifecycle scripts do)
# matched zero commits and the gate printed "no website/ commits — skipping" and exited 0.
# Pin the pathspec to the repo root. Same class as the pattern-scanner cwd incident.
_REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
WEBSITE_COMMIT_EPOCH=$(git -C "$_REPO_ROOT" log -1 origin/main --format=%ct -- website/ 2>/dev/null)
if [ -z "$WEBSITE_COMMIT_EPOCH" ]; then
  # Fallback to local HEAD if origin/main not available
  WEBSITE_COMMIT_EPOCH=$(git -C "$_REPO_ROOT" log -1 --format=%ct -- website/ 2>/dev/null)
fi
if [ -z "$WEBSITE_COMMIT_EPOCH" ]; then
  # FAIL LOUD, never skip (prime directive). `website/` demonstrably exists in this repo's
  # history; finding zero commits means the query is wrong, not that the gate is unneeded.
  echo "FAIL: no website/ commits found in git history — the staleness check did NOT run." >&2
  echo "      This is a HARD FAILURE, not a skip: an unverifiable gate is an unmet gate." >&2
  echo "      (repo root resolved to: $_REPO_ROOT)" >&2
  exit 1
fi

# === Most recent production Vercel deploy ===
# Vercel CLI writes the deployment table to STDERR (not stdout). To grep
# the table reliably, capture stderr→stdout for the LS path. The --json
# variant DOES emit to stdout but exited Vercel CLI 47.x and may not be
# available in older installs; use plaintext as the primary path.
#
# CLI-CONTRACT DRIFT (incident 2026-07-23): Vercel CLI >= ~50.x REJECTS a project-name
# argument — `vercel ls massu` errors "The provided argument \"massu\" is not a valid
# project name". `ls` must instead run FROM the linked project directory, which reads
# `.vercel/project.json`. The old invocation failed on every run, the parse then found no
# Production row, and the gate printed "WARN: could not parse … skipping" and exited 0 —
# so the ONE check for "shipped to npm but not deployed to Vercel" silently covered
# NOTHING while a real 2-day deploy lag sat behind it (the CR-48 bug class this gate
# exists to prevent). Run from the linked dir; treat an unparseable listing as a HARD
# FAILURE, never a skip (see §fail-loud below).
_REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DEPLOY_LISTING=$(cd "$_REPO_ROOT/website" 2>/dev/null && $VERCEL_CMD ls 2>&1)
DEPLOY_EPOCH_SECS=""

# Plaintext parse: extract age column (e.g., "33d") of the first Production row.
AGE_STR=$(echo "$DEPLOY_LISTING" | awk '/Production/{for(i=1;i<=NF;i++)if($i~/^[0-9]+[smhd]$/){print $i; exit}}')
if [ -n "$AGE_STR" ]; then
  case "$AGE_STR" in
    *d) DEPLOY_AGE_SECS=$(( ${AGE_STR%d} * 86400 )) ;;
    *h) DEPLOY_AGE_SECS=$(( ${AGE_STR%h} * 3600 )) ;;
    *m) DEPLOY_AGE_SECS=$(( ${AGE_STR%m} * 60 )) ;;
    *s) DEPLOY_AGE_SECS=$(( ${AGE_STR%s} )) ;;
    *)  DEPLOY_AGE_SECS=0 ;;
  esac
  NOW=$(date +%s)
  DEPLOY_EPOCH_SECS=$(( NOW - DEPLOY_AGE_SECS ))
else
  # FAIL LOUD, never skip (prime directive; incident 2026-07-23). A gate that cannot
  # perform its check has NOT passed — it has stopped checking. Exiting 0 here is what
  # let a CLI-contract change silently disable this gate indefinitely while a real
  # deploy lag (and 4 HIGH-severity website CVEs) sat undeployed behind it.
  echo "FAIL: could not parse the Vercel deploy listing — the staleness check did NOT run." >&2
  echo "      This is a HARD FAILURE, not a skip: an unverifiable gate is an unmet gate." >&2
  echo "      Listing received was:" >&2
  echo "$DEPLOY_LISTING" | head -8 | sed 's/^/        /' >&2
  echo "      Likely cause: a Vercel CLI contract change (the 2026-07-23 incident was" >&2
  echo "      \`vercel ls <project>\` being rejected in CLI >= 50.x — it must run from the" >&2
  echo "      linked project dir). Fix the parse, or bypass EXPLICITLY and on the record" >&2
  echo "      with MASSU_SKIP_DEPLOY_STALENESS_CHECK=1." >&2
  exit 1
fi

# === Lag computation ===
LAG_SECS=$(( WEBSITE_COMMIT_EPOCH - DEPLOY_EPOCH_SECS ))
LAG_HRS=$(( LAG_SECS / 3600 ))

if [ "$LAG_SECS" -le "$MAX_LAG_SECS" ]; then
  echo "PASS: Website deploys within ${MAX_LAG_SECS}s of last commit (lag=${LAG_SECS}s / ${LAG_HRS}h)"
  exit 0
fi

# === Lag exceeds threshold ===
PROD_URL=$(echo "$DEPLOY_LISTING" | awk '/Production/{for(i=1;i<=NF;i++)if($i~/^https:\/\//){print $i; exit}; exit}')
REMEDY="bash scripts/massu-deploy.sh   # or /massu-deploy"

if [ "$IS_MAIN" -eq 1 ]; then
  echo "FAIL: Website has unshipped changes (lag=${LAG_HRS}h since last prod deploy ${PROD_URL:-<unknown>})."
  echo "      Run: $REMEDY"
  exit 1
else
  echo "WARN: Website lag=${LAG_HRS}h since last prod deploy ${PROD_URL:-<unknown>} (non-blocking on branch '$BRANCH')."
  echo "      On main, this would be a FAIL. Run on main: $REMEDY"
  exit 0
fi

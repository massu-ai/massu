#!/bin/bash
#
# pre-push-light.sh - Fast pre-push verification (~60s default, ~90s with sync check, ~180s with clean-sim)
#
# 19 labels [0/18]..[18/18] (plan-2026-05-18-pre-push-ci-parity, P2-001..P2-006;
# step [16/18] added by plan-2026-06-01-claude-md-size-compliance;
# steps [17/18]+[18/18] added by plan-2026-06-03-website-lib-test-coverage).
# Plan-Token Changelog Currency REMOVED (P2-006 iter-5): absorbed by
# `changelog-parse.test.ts` EXPECTED_COUNT drift-guard run via [6/18] Tests.
#
#  [0/18] Clean-state simulation (opt-in via MASSU_PREPUSH_CLEAN=1)
#  [1/18] Node version pre-flight
#  [2/18] Pattern Scanner
#  [3/18] Security Scanner
#  [4/18] Hook Build
#  [5/18] TypeScript
#  [6/18] Tests
#  [7/18] Plan Status Validator
#  [8/18] Plan Commit Drift
#  [9/18] Deploy Staleness
# [10/18] Dist-Tag Pre-Release
# [11/18] Public Content Leak Guard
# [12/18] Workspace Build Freshness                (NEW — P2-005)
# [13/18] Sync Check (public-mirror)               (NEW — P2-002; auto-gated on packages/, scripts/, etc.)
# [14/18] Tarball E2E (quick)                      (NEW — P2-003)
# [15/18] Config Drift                             (NEW — P2-004)
# [16/18] CLAUDE.md Size                            (NEW — plan-2026-06-01-claude-md-size-compliance)
# [17/18] Coverage Gate (real v8 line %)            (NEW — plan-2026-06-03-website-lib-test-coverage)
# [18/18] Plan-Token Changelog Coverage             (NEW — plan-2026-06-03-website-lib-test-coverage; CR-50 parity mirror of CI)
#
# Bypass env vars (all emit `[pre-push-light] BYPASS/OPTIN via ...` to stderr for audit-trail):
#   MASSU_PREPUSH_CLEAN=1              — opt-in step [0/18] clean-state simulation
#   MASSU_SKIP_NEW_STEPS=1             — skip [12/18]..[15/18] (ceremony bootstrap)
#   MASSU_PREPUSH_SYNC_CHECK=0         — skip [13/18] sync-check (default ON, auto-gated)
#   MASSU_SKIP_DEPLOY_STALENESS_CHECK=1 — skip [9/18] deploy staleness (pre-existing CR-48 bypass)
#
# Usage: ./scripts/pre-push-light.sh
#

# Plan 1.5.8 P3-002a: swap `set -e` for `set -uo pipefail` so the
# post-loop diagnostic block survives any failed inline command and so
# this script's safety idiom matches its closest sibling
# (massu-pattern-scanner.sh:10). The `if ... ; then ... else FAILED=1; fi`
# accumulator pattern below already short-circuits errors correctly.
set -uo pipefail

echo "=============================================="
echo "MASSU PUSH LIGHT - Fast Pre-Push Verification"
echo "=============================================="
echo ""

FAILED=0
START_TIME=$(date +%s)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Bypass env-var audit-trail markers (plan-2026-05-18-pre-push-ci-parity §2.1) ---
# Mirrors CR-48 `[deploy-staleness] BYPASS via ...` format so audit-log scrapers
# can detect bypass usage uniformly.
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "[pre-push-light] BYPASS via MASSU_SKIP_NEW_STEPS=1 at $(date -u +%Y-%m-%dT%H:%M:%SZ) — skipping steps [12/18]..[15/18] (Workspace Build Freshness, Sync Check, Tarball E2E, Config Drift) — logged for audit-trail" >&2
fi
if [ "${MASSU_PREPUSH_CLEAN:-0}" = "1" ]; then
  echo "[pre-push-light] OPTIN via MASSU_PREPUSH_CLEAN=1 at $(date -u +%Y-%m-%dT%H:%M:%SZ) — Step [0/18] Clean-state simulation: ENABLED — logged for audit-trail" >&2
fi
if [ "${MASSU_PREPUSH_SYNC_CHECK:-1}" = "0" ]; then
  echo "[pre-push-light] BYPASS via MASSU_PREPUSH_SYNC_CHECK=0 at $(date -u +%Y-%m-%dT%H:%M:%SZ) — skipping step [13/18] Sync Check — logged for audit-trail" >&2
fi

# --- Filesystem-derived workspace package list (single SoT for [0/18] +
#     [12/18]). Future adapter additions/removals don't need to update
#     pre-push-light. Mirrors the contract used by scripts/ci-tarball-e2e.sh. ---
WORKSPACE_PKGS=()
if [ -d "$PROJECT_ROOT/packages/types" ]; then WORKSPACE_PKGS+=("$PROJECT_ROOT/packages/types"); fi
if [ -d "$PROJECT_ROOT/packages/core" ];  then WORKSPACE_PKGS+=("$PROJECT_ROOT/packages/core");  fi
while IFS= read -r pkg_dir; do
  WORKSPACE_PKGS+=("$pkg_dir")
done < <(find "$PROJECT_ROOT/packages" -maxdepth 1 -type d -name 'adapter-*' 2>/dev/null | sort)

# [0/18] Clean-state simulation (opt-in via MASSU_PREPUSH_CLEAN=1) — P2-001
# Nukes gitignored build artifacts then rebuilds them, so any "passes locally because
# stale dist exists" class fails LOCALLY before push. Default-off to preserve the ~60s
# cap; enabling adds ~120s (npm ci + 3 builds + hook compile).
if [ "${MASSU_PREPUSH_CLEAN:-0}" = "1" ]; then
  echo -n "[0/18] Clean-state simulation... "
  CLEAN_LOG=/tmp/massu-prepush-clean.log
  {
    # Filesystem-derived workspace dist enumeration — adding a new
    # packages/adapter-* doesn't require touching this script (HIGH arch
    # finding fix; mirrors ci-tarball-e2e.sh single-SoT principle).
    for pkg in "${WORKSPACE_PKGS[@]}"; do
      rm -rf "$pkg/dist"
    done
    rm -rf "$PROJECT_ROOT/node_modules" "$PROJECT_ROOT/website/.next"
    cd "$PROJECT_ROOT" && npm ci
    cd "$PROJECT_ROOT" && npm run build:types
    cd "$PROJECT_ROOT" && npm run build:adapters
    cd "$PROJECT_ROOT/packages/core" && npm run build && npm run build:hooks
  } > "$CLEAN_LOG" 2>&1
  if [ $? -eq 0 ]; then
    echo "PASS"
  else
    echo "FAIL"
    echo "  See: $CLEAN_LOG"
    tail -20 "$CLEAN_LOG"
    FAILED=1
  fi
else
  echo "[0/18] Clean-state simulation... SKIP (MASSU_PREPUSH_CLEAN unset)"
fi

# [1/18] Node version pre-flight. massu supports Node >=20 (packages/core engines).
# The <26 ceiling was DROPPED in 1.15.1 (incident 2026-07-05): better-sqlite3 12.11.1
# ships prebuilt binaries for Node 20/22/24/26 (incl. ABI 147) and the full suite
# passes on Node 26. Enforce only the >=20 floor; the CI native-module matrix
# (Node 20/22/24/26/latest) is the structural guard against a new-major ABI break.
NODE_VERSION=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ -n "$NODE_VERSION" ]; then
  if [ "$NODE_VERSION" -lt 20 ]; then
    echo "[1/18] Node version pre-flight... FAIL"
    echo "  Node v${NODE_VERSION}.x is below the engines floor."
    echo "  Required: Node >=20 (per packages/core/package.json engines)."
    echo "  Fix: use Node >=20 (nvm: nvm use \$(cat .nvmrc), or a newer brew node)."
    FAILED=1
  else
    echo "[1/18] Node version pre-flight... PASS (v${NODE_VERSION}.x)"
  fi
fi

# [2/18] Pattern Scanner (~5s)
echo -n "[2/18] Pattern Scanner... "
if bash "$SCRIPT_DIR/massu-pattern-scanner.sh" > /tmp/massu-pattern-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-pattern-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-pattern-scanner.log | head -10
  FAILED=1
fi

# [3/18] Security Scanner (~5s)
echo -n "[3/18] Security Scanner... "
if bash "$SCRIPT_DIR/massu-security-scanner.sh" > /tmp/massu-security-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-security-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-security-scanner.log | head -10
  FAILED=1
fi

# [4/18] Hook Build (~5s)
echo -n "[4/18] Hook Build... "
if (cd "$PROJECT_ROOT/packages/core" && npm run build:hooks) > /tmp/massu-hook-build.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-hook-build.log"
  tail -10 /tmp/massu-hook-build.log
  FAILED=1
fi

# [5/18] TypeScript (~30s)
echo -n "[5/18] TypeScript... "
# Wrap in `if !` so the post-loop block survives a tsc failure under
# `set -uo pipefail` (no `set -e`); the pre-existing `$? -eq 0` form
# silently broke when the `set -e` flag was removed in P3-002a.
if TSC_OUTPUT=$((cd "$PROJECT_ROOT/packages/core" && npx tsc --noEmit) 2>&1); then
  echo "PASS"
else
  echo "FAIL"
  echo "$TSC_OUTPUT" | grep -E "error TS" | head -10
  FAILED=1
fi

# [6/18] Tests (~50s)
echo -n "[6/18] Tests... "
if (cd "$PROJECT_ROOT" && npm test) > /tmp/massu-tests.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-tests.log"
  grep -E "FAIL|Error" /tmp/massu-tests.log | head -10
  FAILED=1
fi

# [7/18] Plan Status Validator (~2s) — Plan 1.5.8 P3-002
echo -n "[7/18] Plan Status Validator... "
if bash "$SCRIPT_DIR/massu-plan-status-validator.sh" > /tmp/massu-plan-status.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-plan-status.log"
  grep -E "^\s*FAIL:" /tmp/massu-plan-status.log | head -10
  FAILED=1
fi

# [8/18] Plan Commit Drift (~2s) — Plan 1.5.8 P3-002
echo -n "[8/18] Plan Commit Drift... "
if bash "$SCRIPT_DIR/massu-plan-commit-drift.sh" > /tmp/massu-plan-drift.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-plan-drift.log"
  grep -E "^\s*FAIL:" /tmp/massu-plan-drift.log | head -10
  FAILED=1
fi

# [9/18] Deploy Staleness (~3s) — plan-1.6.3-website-feature-discoverability P-C-002
# Catches the "shipped to npm but not deployed to Vercel" structural drift class.
echo -n "[9/18] Deploy Staleness... "
if bash "$SCRIPT_DIR/massu-deploy-staleness-check.sh" > /tmp/massu-deploy-staleness.log 2>&1; then
  # Distinguish PASS / SKIP / WARN by scanning for the FIRST status-prefixed line.
  # Cannot use `head -1` — the deploy-staleness script emits an audit-trail
  # marker to stderr (which is merged via 2>&1) ahead of the stdout status
  # line, so the first line is "[deploy-staleness] BYPASS ..." not "SKIP:".
  STATUS=$(grep -m1 -E "^(PASS|SKIP|WARN):" /tmp/massu-deploy-staleness.log | awk -F':' '{print $1}')
  case "$STATUS" in
    PASS) echo "PASS" ;;
    SKIP) echo "SKIP (Vercel CLI auth or env-var bypass)" ;;
    WARN) echo "WARN (non-main branch or non-fatal)" ;;
    *)    echo "PASS" ;;  # Default to PASS if format unexpected (exit 0 is the contract)
  esac
else
  echo "FAIL"
  cat /tmp/massu-deploy-staleness.log
  FAILED=1
fi

# [10/18] Dist-Tag Pre-Release (~3s) — plan-1.7.0-cohesive-cleanup P-C-003
# Pre-release channels (`next`/`beta`/`alpha`/`rc`) must NOT exist on
# @massu/core without an explicit ADR + CLAUDE.md `## Deployment` policy
# section opt-in. Re-establishing a stale channel is a CR-46 violation
# (alias-map proliferation) and a release-discipline drift class. Skips
# silently when npm registry is unreachable.
echo -n "[10/18] Dist-Tag Pre-Release... "
DIST_TAG_OUTPUT=$(npm view @massu/core dist-tags 2>&1)
DIST_TAG_EXIT=$?
if [ "$DIST_TAG_EXIT" -ne 0 ]; then
  echo "SKIP (npm registry unreachable)"
else
  # Check for any pre-release channel string (next:|beta:|alpha:|rc:).
  PRERELEASE_FOUND=$(echo "$DIST_TAG_OUTPUT" | grep -ciE "(^|[^a-zA-Z])(next|beta|alpha|rc)\s*:" || true)
  if [ "$PRERELEASE_FOUND" -gt 0 ]; then
    echo "FAIL"
    echo "  Pre-release dist-tag(s) detected on @massu/core:"
    echo "$DIST_TAG_OUTPUT" | grep -iE "(^|[^a-zA-Z])(next|beta|alpha|rc)\s*:" | head -5
    echo "  Policy: only 'latest' is maintained. Pre-release channels require"
    echo "          an ADR + CLAUDE.md ## Deployment policy section opt-in."
    echo "          See .claude/CLAUDE.md ### npm dist-tags policy."
    echo "          Remove with: npm dist-tag rm @massu/core <channel>"
    FAILED=1
  else
    echo "PASS"
  fi
fi

# [11/18] Public Content Leak Guard (~2s) — plan-public-content-leak-guard CR-49
# Eliminates the structural leak class caught at P-D-003 of
# plan-blog-1.5-1.6-publish (private-repo references + internal commit SHAs
# in website/content/releases/1.5-to-1.6.mdx).
echo -n "[11/18] Public Content Leak Guard... "
if bash "$SCRIPT_DIR/massu-website-content-leak-guard.sh" > /tmp/massu-website-content-leak-guard.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-website-content-leak-guard.log"
  tail -20 /tmp/massu-website-content-leak-guard.log
  FAILED=1
fi

# [12/18] Workspace Build Freshness (~1s) — P2-005, plan-2026-05-18-pre-push-ci-parity
# For each workspace package P: max(mtime over P/src/**/*.ts) MUST be <=
# min(mtime over P/dist/**/*.{js,d.ts}). I.e. NO src file may be newer than the
# OLDEST dist file. Catches: src edited after dist emitted. Uses portable
# `file_mtime` from scripts/lib/mtime-helper.sh (BSD vs GNU stat divergence).
echo -n "[12/18] Workspace Build Freshness... "
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "SKIP (MASSU_SKIP_NEW_STEPS=1)"
else
  # shellcheck source=lib/mtime-helper.sh
  source "$SCRIPT_DIR/lib/mtime-helper.sh"
  # Determine stat dialect once (avoids one bash -c fork per file × hundreds of files).
  if stat --version >/dev/null 2>&1; then
    STAT_FLAG='-c'; STAT_FMT='%Y'              # GNU
  elif stat -f '%m' /dev/null >/dev/null 2>&1; then
    STAT_FLAG='-f'; STAT_FMT='%m'              # BSD (macOS)
  else
    STAT_FLAG=''                               # python3 fallback per-file (rare)
  fi
  fast_mtime() {
    if [ -n "$STAT_FLAG" ]; then
      stat "$STAT_FLAG" "$STAT_FMT" "$1"
    else
      file_mtime "$1"
    fi
  }
  FRESH_FAILED=0
  FRESH_REASON=""
  # Filesystem-derived workspace list (HIGH arch finding fix — same SoT as [0/18]).
  for pkg in "${WORKSPACE_PKGS[@]}"; do
    if [ ! -d "$pkg/src" ] || [ ! -d "$pkg/dist" ]; then
      FRESH_FAILED=1
      FRESH_REASON="MISSING: $pkg/src or $pkg/dist"
      break
    fi
    newest_src=""
    while IFS= read -r f; do
      m=$(fast_mtime "$f")
      [ -z "$newest_src" ] || [ "$m" \> "$newest_src" ] && newest_src="$m"
    done < <(find "$pkg/src" -type f -name '*.ts' -not -name '*.test.ts' 2>/dev/null)
    oldest_dist=""
    while IFS= read -r f; do
      m=$(fast_mtime "$f")
      [ -z "$oldest_dist" ] && oldest_dist="$m" && continue
      [ "$m" \< "$oldest_dist" ] && oldest_dist="$m"
    done < <(find "$pkg/dist" -type f \( -name '*.js' -o -name '*.d.ts' \) 2>/dev/null)
    if [ -z "$newest_src" ] || [ -z "$oldest_dist" ]; then
      FRESH_FAILED=1
      FRESH_REASON="EMPTY: $pkg src or dist has no matching files"
      break
    fi
    if awk -v s="$newest_src" -v d="$oldest_dist" 'BEGIN { exit (s > d) ? 1 : 0 }'; then
      :
    else
      FRESH_FAILED=1
      FRESH_REASON="STALE: $pkg — newest src ($newest_src) is newer than oldest dist ($oldest_dist)"
      break
    fi
  done
  if [ "$FRESH_FAILED" -eq 0 ]; then
    echo "PASS"
  else
    echo "FAIL"
    echo "  $FRESH_REASON"
    echo "  REMEDY: npm run build:types && npm run build:adapters && (cd packages/core && npm run build)"
    FAILED=1
  fi
fi

# [13/18] Sync Check public-mirror (~30s when triggered) — P2-002
# DEFAULT OPT-IN via MASSU_PREPUSH_SYNC_CHECK=1 (default ON, set to =0 to skip).
# Auto-gated: only runs when `git status --short` reports modifications under
# paths that sync-public.sh touches — keeps the typical workflow at ~60s.
echo -n "[13/18] Sync Check... "
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "SKIP (MASSU_SKIP_NEW_STEPS=1)"
elif [ "${MASSU_PREPUSH_SYNC_CHECK:-1}" = "0" ]; then
  echo "SKIP (MASSU_PREPUSH_SYNC_CHECK=0)"
else
  # Auto-gate: run only if a sync-touchable path has uncommitted modifications.
  # The complete set mirrors what scripts/sync-public.sh copies/syncs — including
  # PUBLIC_ROOT_FILES (CHANGELOG.md, package-lock.json, LICENSE, CLA.md, etc.)
  # discovered by the architecture review 2026-05-18.
  if git -C "$PROJECT_ROOT" status --short -- \
       packages/ scripts/ eslint-rules/ examples/ \
       .github/workflows/ .github/rulesets/ \
       website/content/docs/ \
       .gitignore.public package.public.json README.public.md \
       .claude/CLAUDE.public.md .claude/settings.json .claude/hooks/ .claude/commands/ \
       package-lock.json massu.config.yaml CHANGELOG.md LICENSE CLA.md CONTRIBUTING.md \
       2>/dev/null | grep -q .; then
    if bash "$SCRIPT_DIR/ci-sync-check.sh" > /tmp/massu-sync-check.log 2>&1; then
      echo "PASS"
    else
      echo "FAIL"
      echo "  See: /tmp/massu-sync-check.log"
      tail -20 /tmp/massu-sync-check.log
      FAILED=1
    fi
  else
    echo "SKIP (no sync-touchable paths changed)"
  fi
fi

# [14/18] Tarball E2E quick (~5s) — P2-003
# Quick mode skips the slow tar-pack-extract on adapter packages and only
# verifies workspace state.
echo -n "[14/18] Tarball E2E (quick)... "
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "SKIP (MASSU_SKIP_NEW_STEPS=1)"
else
  if bash "$SCRIPT_DIR/ci-tarball-e2e.sh" --quick > /tmp/massu-tarball-e2e.log 2>&1; then
    echo "PASS"
  else
    echo "FAIL"
    echo "  See: /tmp/massu-tarball-e2e.log"
    tail -20 /tmp/massu-tarball-e2e.log
    FAILED=1
  fi
fi

# [15/18] Config Drift (~2s) — P2-004
# Local equivalent of CI's massu-config-drift.yml job; runs the workspace
# `massu config check-drift` directly (no scratch-dir avoidance needed locally).
# Uses --no-install ONLY: pre-push must be deterministic + offline; a missing
# local binary FAILs with remedy, NOT a silent network install (MEDIUM arch
# finding 2026-05-18).
echo -n "[15/18] Config Drift... "
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "SKIP (MASSU_SKIP_NEW_STEPS=1)"
else
  if (cd "$PROJECT_ROOT" && npx --no-install massu config check-drift) > /tmp/massu-config-drift.log 2>&1; then
    echo "PASS"
  else
    echo "FAIL"
    echo "  See: /tmp/massu-config-drift.log"
    tail -10 /tmp/massu-config-drift.log
    echo "  REMEDY: npm install (local @massu/core resolution required; do NOT use network npx)"
    FAILED=1
  fi
fi

# [16/18] CLAUDE.md Size (~1s) — plan-2026-06-01-claude-md-size-compliance (CR-? size gate)
# Fail the push if the always-loaded .claude/CLAUDE.md exceeds MAX_SIZE (single
# SoT in check-claude-md-size.sh). REMEDY on failure: bash scripts/claude-md-autosplit.sh.
# Mirrors the same script invoked by the pre-commit gate + CI type-check job
# (three-layer enforcement, CR-50 convention).
echo -n "[16/18] CLAUDE.md Size... "
if bash "$SCRIPT_DIR/check-claude-md-size.sh" > /tmp/massu-claude-md-size.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-claude-md-size.log"
  tail -12 /tmp/massu-claude-md-size.log
  echo "  REMEDY: bash scripts/claude-md-autosplit.sh   (moves '### CR-NN:' detail bodies to reference)"
  FAILED=1
fi

# [17/18] Coverage Gate real v8 line% (~40s) — plan-2026-06-03-website-lib-test-coverage P0-006
# Mirrors CI's `Coverage Gate` step (CR-50 / VR-CI-PARITY) — same scripts/ci-coverage.sh.
# Real instrumented line coverage vs coverage-floors.json; retires the filename heuristic.
echo -n "[17/18] Coverage Gate... "
if bash "$SCRIPT_DIR/ci-coverage.sh" > /tmp/massu-coverage-gate.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-coverage-gate.log"
  grep -E "FAIL:" /tmp/massu-coverage-gate.log | head -10
  echo "  REMEDY: raise coverage with tests; floors in coverage-floors.json may only ratchet UP."
  FAILED=1
fi

# [18/18] Plan-Token Changelog Coverage (~2s) — plan-2026-06-03-website-lib-test-coverage (CR-50 parity)
# Mirrors CI's type-check job 'Plan-Token Changelog Coverage' step (ci.yml) so the
# release-time CHANGELOG↔plan-token gate is enforced LOCALLY too — closes the CR-50
# parity gap where this CI-only gate had no pre-push equivalent (changelog-parse.test.ts
# only checks ENTRY COUNT, not plan-token coverage). Skips on non-release pushes
# (version == last tag) and on tag-less checkouts.
echo -n "[18/18] Plan-Token Changelog Coverage... "
if bash "$SCRIPT_DIR/massu-changelog-coverage.sh" > /tmp/massu-changelog-coverage.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-changelog-coverage.log"
  grep -E "FAIL|gap:" /tmp/massu-changelog-coverage.log | head -10
  FAILED=1
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=============================================="
echo "Duration: ${DURATION}s"
echo "=============================================="

if [ $FAILED -eq 0 ]; then
  echo ""
  echo "ALL CHECKS PASSED - Safe to push"
  echo ""
  exit 0
else
  echo ""
  echo "CHECKS FAILED - Fix issues before pushing"
  echo ""
  exit 1
fi

#!/bin/bash
#
# pre-push-light.sh - Fast pre-push verification (~60s default, ~90s with sync check, ~180s with clean-sim)
#
# 23 labels [0/22]..[22/22] (plan-2026-05-18-pre-push-ci-parity, P2-001..P2-006;
# step [22/22] Anti-Vacuity Completeness added by plan-2026-07-15-wave-1-g6-anti-vacuity-registry (G-6 P6 — fast mirror; full DEFEAT sweep is CI-ONLY in scripts/ci-anti-vacuity.sh);
# step [17/22] added by plan-2026-06-01-claude-md-size-compliance;
# steps [18/22]+[19/22] added by plan-2026-06-03-website-lib-test-coverage;
# step [11/22] Release Integrity added by plan-2026-07-14-release-integrity-check CR-64).
# Plan-Token Changelog Currency REMOVED (P2-006 iter-5): absorbed by
# `changelog-parse.test.ts` EXPECTED_COUNT drift-guard run via [6/22] Tests.
#
#  [0/22] Clean-state simulation (opt-in via MASSU_PREPUSH_CLEAN=1)
#  [1/22] Node version pre-flight
#  [2/22] Pattern Scanner
#  [3/22] Security Scanner
#  [4/22] Hook Build
#  [5/22] TypeScript
#  [6/22] Tests
#  [7/22] Plan Status Validator
#  [8/22] Plan Commit Drift
#  [9/22] Deploy Staleness
# [10/22] Dist-Tag Pre-Release
# [11/22] Release Integrity (CR-64)                 (NEW — a published npm version is immutable; incident 2026-07-14-npm-publish-decoupled-from-release-ceremony)
# [12/22] Public Content Leak Guard
# [13/22] Workspace Build Freshness                (NEW — P2-005)
# [14/22] Sync Check (public-mirror)               (NEW — P2-002; auto-gated on packages/, scripts/, etc.)
# [15/22] Tarball E2E (quick)                      (NEW — P2-003)
# [16/22] Config Drift                             (NEW — P2-004)
# [17/22] CLAUDE.md Size                            (NEW — plan-2026-06-01-claude-md-size-compliance)
# [18/22] Coverage Gate (real v8 line %)            (NEW — plan-2026-06-03-website-lib-test-coverage)
# [19/22] Plan-Token Changelog Coverage             (NEW — plan-2026-06-03-website-lib-test-coverage; CR-50 parity mirror of CI)
# [20/22] Incident Coverage (CR-62)                 (NEW — incident 2026-07-12-memory-subsystem-silent-data-loss-cluster)
# [21/22] Claim Ledger (CR-63)                      (NEW — universal/capability claims need EXECUTED evidence)
# [22/22] Anti-Vacuity Completeness (G-6)            (NEW — every scanner fail-point ships a can-fail proof; fast --completeness-only mirror, full DEFEAT sweep is CI-ONLY)
#
# Bypass env vars (all emit `[pre-push-light] BYPASS/OPTIN via ...` to stderr for audit-trail):
#   MASSU_PREPUSH_CLEAN=1              — opt-in step [0/22] clean-state simulation
#   MASSU_SKIP_NEW_STEPS=1             — skip [13/22]..[16/22] (ceremony bootstrap)
#   MASSU_PREPUSH_SYNC_CHECK=0         — skip [14/22] sync-check (default ON, auto-gated)
#   MASSU_SKIP_DEPLOY_STALENESS_CHECK=1 — skip [9/22] deploy staleness (pre-existing CR-48 bypass)
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

# ── HOST-CAPACITY PREFLIGHT ───────────────────────────────────────────────────────────────────
# Gates that DECLARE themselves host-sensitive (marker: `# host-sensitive:`) get a third verdict.
# The reading is taken HERE, ONCE, BEFORE any gate runs — so the verdict is decided by a
# measurement rather than by how a gate happened to end. A timeout on a host this probe called
# quiet remains a hard FAIL; only a MEASURED capacity shortfall reads as could-not-measure.
# See scripts/lib/host-capacity.sh for why a probe and not load average, and why the tolerance
# is absent-by-default and fails closed (CR-68).
# shellcheck source=lib/host-capacity.sh
. "$SCRIPT_DIR/lib/host-capacity.sh"
HC_DECLARED=$(grep -c '^# host-sensitive:' "$SCRIPT_DIR/pre-push-light.sh")
HC_LINE="$(hc_verdict)"; HC_RC=$?
HC_STATE="${HC_LINE%% *}"
# ⛔ THE NUMERIC STATUS IS THE AUTHORITY; THE TEXT IS FOR THE HUMAN LINE. This used to capture
# HC_RC and then branch on HC_STATE — a parse of the printed verdict's first word — which made
# the PERMISSIVE path the default: `hc_gate_guard` ran the gate unless HC_STATE was exactly
# "DEGRADED", so a reworded verdict, or an empty first word, read as "the host is fine". "Could
# not determine the state" and "the host is fine" produced the same value, and it was the passing
# one. Found by shellcheck SC2034 reporting HC_RC as unused — the captured-and-ignored status is
# the same defect as printing a gate's exit code without branching on it (memory
# printing-a-gates-exit-code-is-not-gating-on-it), this time in code rather than in a command.
#
# The two signals must AGREE. hc_verdict returns 0/3/2 and prints OK/DEGRADED/UNMEASURABLE; if the
# pairing ever breaks, that is a defect in the helper and must be LOUD, not silently permissive.
case "${HC_RC}:${HC_STATE}" in
  0:OK|3:DEGRADED|2:UNMEASURABLE) : ;;
  *)
    echo "[0/22] Host capacity... FAIL: hc_verdict returned rc=${HC_RC} with state '${HC_STATE}'."
    echo "        Those disagree, so neither can be trusted. The closed vocabulary is"
    echo "        0:OK, 3:DEGRADED, 2:UNMEASURABLE. Refusing to guess a host verdict."
    FAILED=1
    ;;
esac
echo "[0/22] Host capacity... $HC_LINE  (${HC_DECLARED} gate(s) declared host-sensitive)"
# M1 — a DENOMINATOR of zero means the marker was renamed and no gate is protected any more.
if [ "$HC_DECLARED" -eq 0 ]; then
  echo "  FAIL: 0 gates carry a '# host-sensitive:' marker, so this preflight protects NOTHING."
  echo "        That is indistinguishable from a healthy host. Restore the markers."
  FAILED=1
fi

# ⚠️ THREE STATES, NOT TWO — and conflating the first two would make this gate a BRICK.
#   OK            -> run the gate normally.
#   DEGRADED      -> a MEASURED capacity shortfall. UNMEASURED, and it BLOCKS the push.
#   UNMEASURABLE  -> NOT YET ARMED (no baseline, or no measured tolerance). WARN LOUDLY and run
#                    the gate exactly as before.
# The third case is load-bearing. An UNCALIBRATED precondition must never be MORE restrictive
# than no precondition at all: with no baseline, blocking would block the very push that adds the
# baseline — a gate with no legal ordering from a reachable state, which is a brick, and a brick
# gets bypassed (CR-72, G26; memory a-whole-tree-precondition-makes-registering-a-new-gate-unreachable).
# It is not silent either: the preflight prints the state every run, so "not yet armed" is a
# PRESENCE signal rather than an absence (G24 — prefer presence as the stop condition).
case "$HC_RC" in
  0)            : ;;
  3)            echo "  NOTE: host-sensitive gates below will report UNMEASURED and BLOCK this push." ;;
  2)            echo "  NOTE: the capacity precondition is NOT ARMED and CANNOT BE by any existing"
                echo "        tool — host-sensitive gates run exactly as before. --calibrate records"
                echo "        min_ms only; nothing in this tree writes max_ratio (measured 2026-09-24),"
                echo "        so this NOTE is permanent until a derivation procedure is decided."
                echo "        Do NOT type a value: a tolerance is measured, never asserted (CR-68)." ;;
  *)            echo "  FAIL: unrecognised host-capacity status rc=${HC_RC} — failing closed."; FAILED=1 ;;
esac

# hc_gate_guard <label> — returns 0 to RUN the gate, 1 to refuse it as UNMEASURED.
# ⛔ UNMEASURED BLOCKS THE PUSH. It is a failure of the RUN, never a bypass: a verdict that let a
# push through on a starved host would be the laundering this whole mechanism exists to avoid.
# What it buys is a TRUE reason in the log instead of a false one about the code.
hc_gate_guard() {
  # Keyed on the NUMERIC status (3 = DEGRADED), so a reworded verdict line cannot turn this
  # guard permissive. rc=0 (OK) and rc=2 (not yet armed) both RUN the gate, by design.
  [ "${HC_RC}" != "3" ] && return 0
  echo "UNMEASURED"
  echo "  Host capacity: $HC_LINE"
  echo "  $1 was NOT RUN, so this is NOT evidence about the code — it is a refusal to produce a"
  echo "  verdict this host cannot support. REMEDY: re-push when the host is quiet; identify the"
  echo "  consumer with: ps -Ao pcpu,pid,ppid,comm -r | head -8"
  FAILED=1
  return 1
}


# --- Bypass env-var audit-trail markers (plan-2026-05-18-pre-push-ci-parity §2.1) ---
# Mirrors CR-48 `[deploy-staleness] BYPASS via ...` format so audit-log scrapers
# can detect bypass usage uniformly.
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "[pre-push-light] BYPASS via MASSU_SKIP_NEW_STEPS=1 at $(date -u +%Y-%m-%dT%H:%M:%SZ) — skipping steps [13/22]..[16/22] (Workspace Build Freshness, Sync Check, Tarball E2E, Config Drift) — logged for audit-trail" >&2
fi
if [ "${MASSU_PREPUSH_CLEAN:-0}" = "1" ]; then
  echo "[pre-push-light] OPTIN via MASSU_PREPUSH_CLEAN=1 at $(date -u +%Y-%m-%dT%H:%M:%SZ) — Step [0/22] Clean-state simulation: ENABLED — logged for audit-trail" >&2
fi
if [ "${MASSU_PREPUSH_SYNC_CHECK:-1}" = "0" ]; then
  echo "[pre-push-light] BYPASS via MASSU_PREPUSH_SYNC_CHECK=0 at $(date -u +%Y-%m-%dT%H:%M:%SZ) — skipping step [14/22] Sync Check — logged for audit-trail" >&2
fi

# --- Filesystem-derived workspace package list (single SoT for [0/22] +
#     [13/22]). Future adapter additions/removals don't need to update
#     pre-push-light. Mirrors the contract used by scripts/ci-tarball-e2e.sh. ---
WORKSPACE_PKGS=()
if [ -d "$PROJECT_ROOT/packages/types" ]; then WORKSPACE_PKGS+=("$PROJECT_ROOT/packages/types"); fi
if [ -d "$PROJECT_ROOT/packages/core" ];  then WORKSPACE_PKGS+=("$PROJECT_ROOT/packages/core");  fi
while IFS= read -r pkg_dir; do
  WORKSPACE_PKGS+=("$pkg_dir")
done < <(find "$PROJECT_ROOT/packages" -maxdepth 1 -type d -name 'adapter-*' 2>/dev/null | sort)

# [0/22] Clean-state simulation (opt-in via MASSU_PREPUSH_CLEAN=1) — P2-001
# Nukes gitignored build artifacts then rebuilds them, so any "passes locally because
# stale dist exists" class fails LOCALLY before push. Default-off to preserve the ~60s
# cap; enabling adds ~120s (npm ci + 3 builds + hook compile).
if [ "${MASSU_PREPUSH_CLEAN:-0}" = "1" ]; then
  echo -n "[0/22] Clean-state simulation... "
  CLEAN_LOG=/tmp/massu-prepush-clean.log
  {
    # Filesystem-derived workspace dist enumeration — adding a new
    # packages/adapter-* doesn't require touching this script (HIGH arch
    # finding fix; mirrors ci-tarball-e2e.sh single-SoT principle).
    for pkg in "${WORKSPACE_PKGS[@]}"; do
      rm -rf "${pkg:?pkg is empty - refusing to build a destructive path (G17)}/dist"
    done
    rm -rf "$PROJECT_ROOT/node_modules" "${PROJECT_ROOT:?PROJECT_ROOT is empty - refusing to build a destructive path (G17)}/website/.next"
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
  echo "[0/22] Clean-state simulation... SKIP (MASSU_PREPUSH_CLEAN unset)"
fi

# [1/22] Node version pre-flight. massu supports Node >=20 (packages/core engines).
# The <26 ceiling was DROPPED in 1.15.1 (incident 2026-07-05): better-sqlite3 12.11.1
# ships prebuilt binaries for Node 20/22/24/26 (incl. ABI 147) and the full suite
# passes on Node 26. Enforce only the >=20 floor; the CI native-module matrix
# (Node 20/22/24/26/latest) is the structural guard against a new-major ABI break.
NODE_VERSION=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ -n "$NODE_VERSION" ]; then
  if [ "$NODE_VERSION" -lt 20 ]; then
    echo "[1/22] Node version pre-flight... FAIL"
    echo "  Node v${NODE_VERSION}.x is below the engines floor."
    echo "  Required: Node >=20 (per packages/core/package.json engines)."
    echo "  Fix: use Node >=20 (nvm: nvm use \$(cat .nvmrc), or a newer brew node)."
    FAILED=1
  else
    echo "[1/22] Node version pre-flight... PASS (v${NODE_VERSION}.x)"
  fi
fi

# [2/22] Pattern Scanner (~5s)
echo -n "[2/22] Pattern Scanner... "
if bash "$SCRIPT_DIR/massu-pattern-scanner.sh" > /tmp/massu-pattern-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-pattern-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-pattern-scanner.log | head -10
  FAILED=1
fi

# [3/22] Security Scanner (~5s)
echo -n "[3/22] Security Scanner... "
if bash "$SCRIPT_DIR/massu-security-scanner.sh" > /tmp/massu-security-scanner.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-security-scanner.log"
  grep -E "^\s*FAIL:" /tmp/massu-security-scanner.log | head -10
  FAILED=1
fi

# [4/22] Hook Build (~5s)
echo -n "[4/22] Hook Build... "
if (cd "$PROJECT_ROOT/packages/core" && npm run build:hooks) > /tmp/massu-hook-build.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-hook-build.log"
  tail -10 /tmp/massu-hook-build.log
  FAILED=1
fi

# [5/22] TypeScript (~30s) — core AND website
# Wrap in `if !` so the post-loop block survives a tsc failure under
# `set -uo pipefail` (no `set -e`); the pre-existing `$? -eq 0` form
# silently broke when the `set -e` flag was removed in P3-002a.
# BASE-1 (audit 2026-07-14): the website is now type-checked here too (CR-50
# parity with ci.yml's new "Type Check (Website)" step) — a website type error
# used to be invisible to pre-push and caught only by CI.
echo -n "[5/22] TypeScript (core)... "
if TSC_OUTPUT=$( (cd "$PROJECT_ROOT/packages/core" && npx tsc --noEmit) 2>&1); then
  echo "PASS"
else
  echo "FAIL"
  echo "$TSC_OUTPUT" | grep -E "error TS" | head -10
  FAILED=1
fi
echo -n "[5/22] TypeScript (website)... "
if TSC_WEB_OUTPUT=$( (cd "$PROJECT_ROOT/website" && npx tsc --noEmit) 2>&1); then
  echo "PASS"
else
  echo "FAIL"
  echo "$TSC_WEB_OUTPUT" | grep -E "error TS" | head -10
  FAILED=1
fi

# [6/22] Tests (~50s) — the SINGLE instrumented run of BOTH suites.
# plan-required-checks / i-suite-twice: this used to be a PLAIN `npm test`, and gate [18/22]
# then ran the same suites AGAIN under v8 instrumentation. Two consequences, both measured:
#   * packages/core executed TWICE per push, so twice the exposure to load-induced timeouts,
#     and the second run landed at the most loaded moment the battery ever has;
#   * `npm test` is `npm test --workspace=packages/core`, so gate 6 NEVER RAN THE WEBSITE
#     SUITE AT ALL — a website test failure surfaced only as gate 18's "coverage …
#     unmeasured", pointing at coverage rather than at the failing test.
# Now ONE instrumented run of each suite writes coverage/coverage-summary.json, and [18/22]
# CONSUMES it (MASSU_COVERAGE_SKIP_RUN=1). The two gates can no longer disagree about which
# tests passed — that is impossible rather than merely detectable.
# host-sensitive: the suites do real SQLite/FTS5 work under a 20s testTimeout (vitest.config.ts:31);
# measured 2026-09-23 at 473ms for 30 tests quiet vs one test exceeding 20s under ~16-of-28-core
# contention. The ceiling is a hang detector, not an assertion, so it cannot be made deterministic.
echo -n "[6/22] Tests... "
if ! hc_gate_guard "[6/22] Tests"; then :
elif (cd "$PROJECT_ROOT" && npm run test:instrumented) > /tmp/massu-tests.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-tests.log"
  grep -E "FAIL|Error" /tmp/massu-tests.log | head -10
  FAILED=1
fi

# [7/22] Plan Status Validator (~2s) — Plan 1.5.8 P3-002
echo -n "[7/22] Plan Status Validator... "
if bash "$SCRIPT_DIR/massu-plan-status-validator.sh" > /tmp/massu-plan-status.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-plan-status.log"
  grep -E "^\s*FAIL:" /tmp/massu-plan-status.log | head -10
  FAILED=1
fi

# [8/22] Plan Commit Drift (~2s) — Plan 1.5.8 P3-002
echo -n "[8/22] Plan Commit Drift... "
if bash "$SCRIPT_DIR/massu-plan-commit-drift.sh" > /tmp/massu-plan-drift.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-plan-drift.log"
  grep -E "^\s*FAIL:" /tmp/massu-plan-drift.log | head -10
  FAILED=1
fi

# [9/22] Deploy Staleness (~3s) — plan-1.6.3-website-feature-discoverability P-C-002
# Catches the "shipped to npm but not deployed to Vercel" structural drift class.
echo -n "[9/22] Deploy Staleness... "
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

# [10/22] Dist-Tag Pre-Release (~3s) — plan-1.7.0-cohesive-cleanup P-C-003
# Pre-release channels (`next`/`beta`/`alpha`/`rc`) must NOT exist on
# @massu/core without an explicit ADR + CLAUDE.md `## Deployment` policy
# section opt-in. Re-establishing a stale channel is a CR-46 violation
# (alias-map proliferation) and a release-discipline drift class. Skips
# silently when npm registry is unreachable.
echo -n "[10/22] Dist-Tag Pre-Release... "
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

# [11/22] Release Integrity (~3s) — CR-64, plan-2026-07-14-release-integrity-check.
# A published npm version number is IMMUTABLE. FAILs if packages/core/package.json
# version is already published on @massu/core but HEAD carries no matching vX.Y.Z tag
# (the "1.16.0 published with no tag, then reused for six undelivered commits that read
# as SHIPPED" class; incident 2026-07-14-npm-publish-decoupled-from-release-ceremony).
# Fail-closed (exit 3) when npm is unreachable. Override (logged inside the gate):
# MASSU_SKIP_RELEASE_INTEGRITY_CHECK=1. Any non-zero exit FAILs the push.
echo -n "[11/22] Release Integrity (CR-64)... "
if node "$SCRIPT_DIR/release-integrity-check.mjs" > /tmp/massu-release-integrity.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-release-integrity.log"
  grep -vE "^\s*$" /tmp/massu-release-integrity.log | head -12
  echo "  REMEDY: bump packages/core/package.json version past the last published @massu/core version,"
  echo "          OR tag HEAD with the matching vX.Y.Z. Override (logged): MASSU_SKIP_RELEASE_INTEGRITY_CHECK=1"
  FAILED=1
fi

# [12/22] Public Content Leak Guard (~2s) — plan-public-content-leak-guard CR-49
# Eliminates the structural leak class caught at P-D-003 of
# plan-blog-1.5-1.6-publish (private-repo references + internal commit SHAs
# in website/content/releases/1.5-to-1.6.mdx).
echo -n "[12/22] Public Content Leak Guard... "
if bash "$SCRIPT_DIR/massu-website-content-leak-guard.sh" > /tmp/massu-website-content-leak-guard.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-website-content-leak-guard.log"
  tail -20 /tmp/massu-website-content-leak-guard.log
  FAILED=1
fi

# [13/22] Workspace Build Freshness (~1s) — P2-005, plan-2026-05-18-pre-push-ci-parity
# For each workspace package P: max(mtime over P/src/**/*.ts) MUST be <=
# min(mtime over P/dist/**/*.{js,d.ts}). I.e. NO src file may be newer than the
# OLDEST dist file. Catches: src edited after dist emitted. Uses portable
# `file_mtime` from scripts/lib/mtime-helper.sh (BSD vs GNU stat divergence).
echo -n "[13/22] Workspace Build Freshness... "
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
  # Filesystem-derived workspace list (HIGH arch finding fix — same SoT as [0/22]).
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

# [14/22] Sync Check public-mirror (~30s when triggered) — P2-002
# DEFAULT OPT-IN via MASSU_PREPUSH_SYNC_CHECK=1 (default ON, set to =0 to skip).
# Auto-gated: only runs when `git status --short` reports modifications under
# paths that sync-public.sh touches — keeps the typical workflow at ~60s.
echo -n "[14/22] Sync Check... "
if [ "${MASSU_SKIP_NEW_STEPS:-0}" = "1" ]; then
  echo "SKIP (MASSU_SKIP_NEW_STEPS=1)"
elif [ "${MASSU_PREPUSH_SYNC_CHECK:-1}" = "0" ]; then
  echo "SKIP (MASSU_PREPUSH_SYNC_CHECK=0)"
else
  # Auto-gate: run only if a sync-touchable path has uncommitted modifications.
  # The complete set mirrors what scripts/sync-public.sh copies/syncs — including
  # PUBLIC_ROOT_FILES (CHANGELOG.md, package-lock.json, LICENSE, CLA.md, etc.)
  # discovered by the architecture review 2026-05-18.
  # here-string capture (NOT `git status … | grep -q .`): with many changed paths, git keeps
  # writing after `grep -q` short-circuits on the first line, gets SIGPIPE, and `set -o pipefail`
  # (line 51) turns that into a non-zero pipeline exit → the sync-check would be SILENTLY SKIPPED
  # exactly when there is the MOST to sync. Same broken-pipe class as pattern-scanner Check 26
  # (incident 2026-07-16). Capturing to a variable removes the pipe; `-n` == "any output" == the
  # old `grep -q .`.
  SYNC_TOUCHABLE_PATHS=(
       packages/ scripts/ eslint-rules/ examples/
       .github/workflows/ .github/rulesets/
       website/content/docs/
       .gitignore.public README.public.md
       # package.json is here because the mirror's manifest is DERIVED from it
       # (scripts/lib/derive-public-manifest.py). Before 2026-09-21 only the
       # hand-written package.public.json affected the mirror, so a bare package.json
       # edit did not need to trigger a sync check. It does now.
       package.json
       .claude/CLAUDE.public.md .claude/settings.json .claude/hooks/ .claude/commands/
       package-lock.json massu.config.yaml CHANGELOG.md LICENSE CLA.md CONTRIBUTING.md
  )
  sync_relevant_status="$(git -C "$PROJECT_ROOT" status --short -- \
       "${SYNC_TOUCHABLE_PATHS[@]}" 2>/dev/null)"

  # ...and the COMMITS ABOUT TO BE PUSHED. `git status` reports only UNCOMMITTED
  # modifications, and at pre-push time the tree is clean by construction — so
  # this gate skipped on essentially every push and had effectively never run.
  # It was CI, not pre-push, that caught the internal repo URL leaking into
  # scripts/tests/ on 449e0cca, on a push where step [14/22] reported
  # "SKIP (no sync-touchable paths changed)" for a commit that changed a file
  # which demonstrably syncs. A gate that cannot fire is not a gate (CR-50: the
  # pre-push battery must mirror CI).
  sync_upstream="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo 'origin/main')"
  if git -C "$PROJECT_ROOT" rev-parse --verify --quiet "$sync_upstream" >/dev/null 2>&1; then
    sync_relevant_commits="$(git -C "$PROJECT_ROOT" diff --name-only \
         "$sync_upstream...HEAD" -- "${SYNC_TOUCHABLE_PATHS[@]}" 2>/dev/null)"
  else
    # No upstream to compare against: cannot determine what is being pushed, so
    # do NOT infer "nothing changed". Fail toward running the check.
    sync_relevant_commits="(no upstream — running sync check unconditionally)"
  fi

  if [ -n "$sync_relevant_status" ] || [ -n "$sync_relevant_commits" ]; then
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

# [15/22] Tarball E2E quick (~5s) — P2-003
# Quick mode skips the slow tar-pack-extract on adapter packages and only
# verifies workspace state.
echo -n "[15/22] Tarball E2E (quick)... "
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

# [16/22] Config Drift (~2s) — P2-004
# Local equivalent of CI's massu-config-drift.yml job; runs the workspace
# `massu config check-drift` directly (no scratch-dir avoidance needed locally).
# Uses --no-install ONLY: pre-push must be deterministic + offline; a missing
# local binary FAILs with remedy, NOT a silent network install (MEDIUM arch
# finding 2026-05-18).
echo -n "[16/22] Config Drift... "
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

# [17/22] CLAUDE.md Size (~1s) — plan-2026-06-01-claude-md-size-compliance (CR-? size gate)
# Fail the push if the always-loaded .claude/CLAUDE.md exceeds MAX_SIZE (single
# SoT in check-claude-md-size.sh). REMEDY on failure: bash scripts/claude-md-autosplit.sh.
# Mirrors the same script invoked by the pre-commit gate + CI type-check job
# (three-layer enforcement, CR-50 convention).
echo -n "[17/22] CLAUDE.md Size... "
if bash "$SCRIPT_DIR/check-claude-md-size.sh" > /tmp/massu-claude-md-size.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-claude-md-size.log"
  tail -12 /tmp/massu-claude-md-size.log
  echo "  REMEDY: bash scripts/claude-md-autosplit.sh   (moves '### CR-NN:' detail bodies to reference)"
  FAILED=1
fi

# [18/22] Coverage Gate real v8 line% (~40s) — plan-2026-06-03-website-lib-test-coverage P0-006
# Mirrors CI's `Coverage Gate` step (CR-50 / VR-CI-PARITY) — same scripts/ci-coverage.sh.
# Real instrumented line coverage vs coverage-floors.json; retires the filename heuristic.
# host-sensitive: it CONSUMES the report gate [6/22] produces, so a host that cannot run the
# suites cannot produce a coverage verdict either — it would report `unmeasured` for a missing
# summary and point at coverage rather than at the host.
echo -n "[18/22] Coverage Gate... "
if ! hc_gate_guard "[18/22] Coverage Gate"; then :
elif bash "$SCRIPT_DIR/ci-coverage.sh" > /tmp/massu-coverage-gate.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-coverage-gate.log"
  grep -E "FAIL:" /tmp/massu-coverage-gate.log | head -10
  echo "  REMEDY: raise coverage with tests; floors in coverage-floors.json may only ratchet UP."
  FAILED=1
fi

# [19/22] Plan-Token Changelog Coverage (~2s) — plan-2026-06-03-website-lib-test-coverage (CR-50 parity)
# Mirrors CI's type-check job 'Plan-Token Changelog Coverage' step (ci.yml) so the
# release-time CHANGELOG↔plan-token gate is enforced LOCALLY too — closes the CR-50
# parity gap where this CI-only gate had no pre-push equivalent (changelog-parse.test.ts
# only checks ENTRY COUNT, not plan-token coverage). Skips on non-release pushes
# (version == last tag) and on tag-less checkouts.
echo -n "[19/22] Plan-Token Changelog Coverage... "
if bash "$SCRIPT_DIR/massu-changelog-coverage.sh" > /tmp/massu-changelog-coverage.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-changelog-coverage.log"
  grep -E "FAIL|gap:" /tmp/massu-changelog-coverage.log | head -10
  FAILED=1
fi

# [20/22] Incident Coverage (~1s) — CR-62.
# A bug the MACHINE finds must produce the same artifacts as a bug the HUMAN
# reports. The incident pipeline was keyed on the user complaining (a regex over
# their prompt); defects found by Massu's own audit produced no incident, no
# memory and no rule — fixed and forgotten. A `fix(...)` commit touching product
# source must ship an incident doc in the same push.
echo -n "[20/22] Incident Coverage (CR-62)... "
if bash "$SCRIPT_DIR/massu-incident-coverage.sh" > /tmp/massu-incident-coverage.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-incident-coverage.log"
  grep -vE "^\s*$" /tmp/massu-incident-coverage.log | head -14
  FAILED=1
fi

# [21/22] Claim Ledger (~2s) — CR-63.
# A universal quantifier ("the ONLY store…", "every module…") or a capability assertion
# ("the seeders read the corpus", "run X against Y") is a CLAIM ABOUT REALITY. Reading a
# plan cannot validate it — only executing something can. A plan audited to ZERO gaps
# across six passes still shipped two false premises, each one shell command from being
# caught. Existing plans are grandfathered by a SHRINK-ONLY baseline; there is no
# per-plan exempt flag, because a valve is how a gate rots.
echo -n "[21/22] Claim Ledger (CR-63)... "
if node "$SCRIPT_DIR/massu-claim-ledger.mjs" --self-test > /tmp/massu-claim-ledger.log 2>&1 \
   && node "$SCRIPT_DIR/massu-claim-ledger.mjs" >> /tmp/massu-claim-ledger.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-claim-ledger.log"
  grep -vE "^\s*$" /tmp/massu-claim-ledger.log | head -20
  FAILED=1
fi

# [22/22] Anti-Vacuity Completeness (~5s) — G-6 Wave 1, plan-2026-07-15-wave-1-g6-anti-vacuity-registry.
# The FAST mirror of CI's full anti-vacuity sweep (scripts/ci-anti-vacuity.sh, # CI-ONLY): every
# discovered scanner fail-point must carry a NON-HOLLOW can-fail proof in gate-registry.json, and
# the symbol-grep ratchet must stay at 0 (no bare-identifier "gates"). This catches locally the
# cheap failure — a fixture deleted/gutted or a new comment-satisfiable predicate — in seconds; the
# expensive full CONTROL→PLANT→ORACLE→DEFEAT sweep (~14min, CR-68) stays CI-only per CR-50.
# Fail-closed: the runner exits non-zero on a missing/hollow fixture, a surviving symbol-grep, or a
# FATAL (unreadable registry / zero-denominator discovery).
echo -n "[22/22] Anti-Vacuity Completeness (G-6)... "
if bash "$SCRIPT_DIR/massu-gate-anti-vacuity.sh" --completeness-only > /tmp/massu-anti-vacuity-completeness.log 2>&1; then
  echo "PASS"
else
  echo "FAIL"
  echo "  See: /tmp/massu-anti-vacuity-completeness.log"
  grep -vE "^\s*$" /tmp/massu-anti-vacuity-completeness.log | tail -20
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

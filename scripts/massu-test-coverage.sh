#!/usr/bin/env bash
#
# massu-test-coverage.sh - Massu Real Coverage Gate (v8 instrumented line %)
#
# Runs `vitest run --coverage` in each package, parses coverage/coverage-summary.json,
# and FAILs when any package's total line% is below its floor in coverage-floors.json.
#
# Replaces the retired filename-presence heuristic (plan-2026-06-03-website-lib-test-coverage
# P0-004) — a 1-assertion smoke test no longer flips a module "covered", and modules
# exercised transitively (no co-located *.test.ts) are correctly credited.
#
# The floors in /coverage-floors.json are the single source of truth, mirrored into each
# package's vitest config `coverage.thresholds.lines` and pinned by the monotonic
# drift-guard (packages/core/src/__tests__/coverage-floor-monotonic.test.ts).
#
# Exit 0 = every package >= its floor. Exit 1 = at least one package below floor.
#
# Usage: bash scripts/massu-test-coverage.sh
#   MASSU_COVERAGE_SKIP_RUN=1  — reuse existing coverage/coverage-summary.json (skip vitest run)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOORS_JSON="$REPO_ROOT/coverage-floors.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; }
info() { echo -e "  ${BLUE}INFO${NC}: $1"; }

echo "=== Massu Real Coverage Gate (v8 line %) ==="
echo ""

if [ ! -f "$FLOORS_JSON" ]; then
  echo -e "  ${RED}FAIL: coverage-floors.json not found at $FLOORS_JSON${NC}"
  exit 1
fi

OVERALL_FAILED=0

# ── WHY a failure happened, not just THAT one did ────────────────────────────────────────
# This gate had SIX distinct failure paths and ONE summary line for all of them:
# "FAIL: at least one package below its coverage floor", with the remedy "raise coverage with
# tests". Only one of the six is actually below-floor. On 2026-07-29 the real cause was a
# FAILING TEST — the suite aborted, so coverage-summary.json was never written and NO
# percentage was ever compared — and the summary sent the reader to write tests. The
# per-package line said "coverage-summary.json not generated"; pre-push prints only the
# summary, so that is the line that was acted on.
#
# A gate that reports a cause it did not determine is worse than one that reports nothing:
# it manufactures a confident wrong remedy. Each failure site now DECLARES its kind, and the
# summary can only print kinds that were declared.
FAIL_KINDS=""
_note_kind() {   # $1 = reason code; set semantics, first-occurrence order preserved
  case " $FAIL_KINDS " in *" $1 "*) return 0 ;; esac
  FAIL_KINDS="${FAIL_KINDS}${FAIL_KINDS:+ }$1"
}

# Args: <package-key-in-floors> <package-dir-relative-to-repo-root>
check_package() {
  local KEY="$1"
  local DIR="$2"
  local PKG_PATH="$REPO_ROOT/$DIR"
  local SUMMARY="$PKG_PATH/coverage/coverage-summary.json"
  local LOG="/tmp/massu-coverage-${KEY//\//-}.log"

  echo "--- $KEY ---"

  local FLOOR
  FLOOR=$(node -e "const f=require('$FLOORS_JSON'); const v=f['$KEY']; if(typeof v!=='number'){process.exit(2)} console.log(v)" 2>/dev/null)
  if [ -z "$FLOOR" ]; then
    fail "$KEY: no numeric floor in coverage-floors.json"
    _note_kind floor-config
    OVERALL_FAILED=1
    echo ""
    return
  fi

  if [ "${MASSU_COVERAGE_SKIP_RUN:-0}" != "1" ]; then
    info "Running: (cd $DIR && npx vitest run --coverage)"
    if ! (cd "$PKG_PATH" && npx vitest run --coverage > "$LOG" 2>&1); then
      # A non-zero exit can mean either a real test failure OR the vitest
      # threshold gate fired (coverage below floor). Either way we parse the
      # summary below and report the precise pct; surface the log tail too.
      info "$KEY: vitest exited non-zero (test failure or threshold gate) — see $LOG"
    fi
  fi

  if [ ! -f "$SUMMARY" ]; then
    fail "$KEY: coverage-summary.json not generated ($SUMMARY)"
    tail -20 "$LOG" 2>/dev/null || true
    _note_kind unmeasured
    OVERALL_FAILED=1
    echo ""
    return
  fi

  local PCT
  PCT=$(node -e "const s=require('$SUMMARY'); console.log(s.total.lines.pct)" 2>/dev/null)
  local COVERED TOTAL
  COVERED=$(node -e "const s=require('$SUMMARY'); console.log(s.total.lines.covered)" 2>/dev/null)
  TOTAL=$(node -e "const s=require('$SUMMARY'); console.log(s.total.lines.total)" 2>/dev/null)

  if [ -z "$PCT" ]; then
    fail "$KEY: could not parse .total.lines.pct from $SUMMARY"
    _note_kind unmeasured
    OVERALL_FAILED=1
    echo ""
    return
  fi

  # SECURITY: PCT comes from a machine-generated, gitignored file. Validate it
  # is a bare number BEFORE any arithmetic so a malformed/crafted summary can
  # never reach an evaluator (defense-in-depth — never interpolate untrusted
  # data into `node -e`). FLOOR is already typeof-number-validated above.
  if ! [[ "$PCT" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    fail "$KEY: non-numeric coverage pct '$PCT' in $SUMMARY"
    _note_kind unmeasured
    OVERALL_FAILED=1
    echo ""
    return
  fi

  # Float compare via awk (no eval): PCT >= FLOOR ?
  local CMP
  if awk -v p="$PCT" -v f="$FLOOR" 'BEGIN { exit (p >= f) ? 0 : 1 }'; then
    CMP=yes
  else
    CMP=no
  fi
  if [ "$CMP" = "yes" ]; then
    pass "$KEY: ${PCT}% line coverage (${COVERED}/${TOTAL}) >= floor ${FLOOR}%"
  else
    fail "$KEY: ${PCT}% line coverage (${COVERED}/${TOTAL}) < floor ${FLOOR}%"
    _note_kind below-floor
    OVERALL_FAILED=1
  fi
  echo ""
}

check_package "packages/core" "packages/core"
check_package "website/src/lib" "website"

# -------------------------------------------------------
# Completeness guard (plan-2026-06-03-website-lib-test-coverage follow-up):
# every website/src/lib module MUST appear in the coverage-summary. A module
# that vitest cannot load/instrument (e.g. analytics.ts dynamic-importing the
# export-less ESM `@plausible-analytics/tracker`) is SILENTLY DROPPED from the
# denominator — inflating the % and hiding an untested module. Assert the set
# of src/lib source files == the set of files v8 reported on.
# -------------------------------------------------------
echo "--- completeness: website/src/lib ---"
WEB_SUMMARY="$REPO_ROOT/website/coverage/coverage-summary.json"
if [ -f "$WEB_SUMMARY" ]; then
  MISSING=$(node -e '
    const { readdirSync, statSync } = require("fs");
    const { join, resolve } = require("path");
    const root = process.argv[1];
    const libDir = resolve(root, "website/src/lib");
    const summary = require(resolve(root, "website/coverage/coverage-summary.json"));
    const reported = new Set(Object.getOwnPropertyNames(summary).filter(k => k !== "total").map(k => resolve(k)));
    const expected = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); continue; }
        if (/\.d\.ts$/.test(e.name)) continue;
        if (/\.(ts|tsx)$/.test(e.name)) expected.push(resolve(p));
      }
    })(libDir);
    const missing = expected.filter(f => !reported.has(f));
    for (const m of missing) console.log(m.replace(root + "/", ""));
  ' "$REPO_ROOT")
  if [ -n "$MISSING" ]; then
    fail "website/src/lib: modules absent from coverage-summary (unloadable → silently dropped from the denominator):"
    echo "$MISSING" | while IFS= read -r m; do echo "    - $m"; done
    echo "    REMEDY: make the module loadable under vitest (e.g. a resolve.alias for an export-less ESM dep) so it is instrumented + counted."
    _note_kind denominator-incomplete
    OVERALL_FAILED=1
  else
    pass "website/src/lib: all source modules present in coverage-summary (none silently dropped)"
  fi
else
  info "website/src/lib: coverage-summary.json absent — completeness check skipped"
fi
echo ""

echo "=== Coverage Gate Summary ==="
if [ "$OVERALL_FAILED" -eq 0 ]; then
  echo -e "  ${GREEN}PASS: all packages >= their coverage-floors.json floor${NC}"
  exit 0
else
  # A failure whose KIND nobody declared cannot be summarised — and must not be summarised
  # generically, because a generic summary is exactly how "the suite failed" was reported as
  # "below the coverage floor". If a new failure site is added without _note_kind, say so
  # LOUDLY rather than falling back to a plausible sentence.
  if [ -z "$FAIL_KINDS" ]; then
    echo -e "  ${RED}FAIL: the coverage gate failed but NO failure site declared its kind.${NC}"
    echo -e "  ${YELLOW}This is a defect in this script, not in your coverage: a fail site is${NC}"
    echo -e "  ${YELLOW}missing its _note_kind call, so the reason cannot be reported. Read the${NC}"
    echo -e "  ${YELLOW}per-package FAIL lines above for the real cause.${NC}"
    exit 1
  fi

  echo -e "  ${RED}FAIL: coverage gate failed — reason(s): ${FAIL_KINDS}${NC}"
  case " $FAIL_KINDS " in *" unmeasured "*)
    echo -e "  ${YELLOW}unmeasured${NC}: coverage was NOT produced, so NO percentage was ever compared"
    echo -e "    against any floor. This is almost always a FAILING TEST (the suite aborted"
    echo -e "    before writing coverage-summary.json) — adding tests cannot fix a run that"
    echo -e "    never completed."
    echo -e "    REMEDY: fix the suite first. The per-package FAIL line above names the file,"
    echo -e "    and its full log is at /tmp/massu-coverage-<key>.log." ;;
  esac
  case " $FAIL_KINDS " in *" below-floor "*)
    echo -e "  ${YELLOW}below-floor${NC}: a package was measured and came in under its floor."
    echo -e "    REMEDY: raise coverage with tests. Floors: $FLOORS_JSON (monotonic — raise"
    echo -e "    tests, never lower the floor)." ;;
  esac
  case " $FAIL_KINDS " in *" denominator-incomplete "*)
    echo -e "  ${YELLOW}denominator-incomplete${NC}: a module was silently dropped from the"
    echo -e "    denominator, so the reported % is higher than the truth. See the REMEDY above." ;;
  esac
  case " $FAIL_KINDS " in *" floor-config "*)
    echo -e "  ${YELLOW}floor-config${NC}: a package has no numeric floor in coverage-floors.json."
    echo -e "    REMEDY: add the numeric floor for the named key — nothing was measured for it." ;;
  esac
  exit 1
fi

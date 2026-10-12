#!/usr/bin/env bash
# Measure the inter-event gap distribution of a HEALTHY vitest run.
#
# WHY THIS EXISTS (CR-68): the hang detector's silence bound is a claim about the outside
# world -- how long this runner legitimately goes without emitting a reporter event. Typing a
# number would make it an invention. This script measures it, so the bound can be re-derived
# on any host at any time instead of being trusted because someone once ran something.
#
# WHAT IT DOES NOT MEASURE, stated plainly (G20): it measures the gaps a HEALTHY run produces.
# It cannot tell you the bound is safe for a suite whose slowest single unit legitimately
# exceeds the observed maximum -- a test that sleeps longer than the bound is a false positive
# by construction, and the remedy for such a test is an explicit beat, not a wider bound.
#
# Usage:
#   scripts/ops/measure-vitest-event-gaps.sh [--runs N] [--package DIR] [--out DIR]
#                                            [--list] [--dry-run]
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RUNS=3
PACKAGE=""
OUT_DIR=""
DO_LIST=0
DRY_RUN=0

die() { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 2; }

usage() {
  cat <<'EOF'
Measure the inter-event gap distribution of a healthy vitest run.

  --runs N       number of repetitions (default 3). More runs widen the observed maximum;
                 a bound derived from ONE run is a bound derived from one scheduling accident.
  --package DIR  package directory holding a vitest.config.ts (default: every discovered one)
  --out DIR      where to write the raw event logs (default: a mktemp -d)
  --list         print the discovered packages and exit without running anything
  --dry-run      print the commands that would run, then exit
  -h, --help     this text
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runs)    [ "$#" -ge 2 ] || die "--runs needs a value"; RUNS="$2"; shift 2 ;;
    --package) [ "$#" -ge 2 ] || die "--package needs a value"; PACKAGE="$2"; shift 2 ;;
    --out)     [ "$#" -ge 2 ] || die "--out needs a value"; OUT_DIR="$2"; shift 2 ;;
    --list)    DO_LIST=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    # R-011: refuse an unmatched argument, never resolve it to the likeliest candidate.
    *) die "unrecognised argument: $1 (see --help)" ;;
  esac
done

case "$RUNS" in
  ''|*[!0-9]*) die "--runs must be a positive integer, got: $RUNS" ;;
esac
[ "$RUNS" -ge 1 ] || die "--runs must be at least 1"

# The candidate set is DISCOVERED from the tree, never a roster (G32/G18). A package that
# grows a vitest.config.ts is covered the first time it is committed.
discover_packages() {
  git -C "$REPO_ROOT" ls-files \
    | /usr/bin/grep -E '(^|/)vitest\.config\.(ts|mts|js)$' \
    | while read -r cfg; do
        d="$(dirname "$cfg")"
        [ "$d" = "." ] && d=""
        printf '%s\n' "${d:-.}"
      done \
    | LC_ALL=C sort -u
}

PKGS="$(discover_packages || true)"
[ -n "$PKGS" ] || die "discovered ZERO vitest config files — refusing to report a distribution over nothing"

PKG_COUNT="$(printf '%s\n' "$PKGS" | /usr/bin/grep -c . || true)"

if [ -n "$PACKAGE" ]; then
  if ! printf '%s\n' "$PKGS" | /usr/bin/grep -qxF "$PACKAGE"; then
    printf '%s: --package %s is not one of the discovered packages:\n' "$SCRIPT_NAME" "$PACKAGE" >&2
    printf '%s\n' "$PKGS" | sed 's/^/  /' >&2
    exit 2
  fi
  PKGS="$PACKAGE"
  PKG_COUNT=1
fi

# M1: report the denominator every run.
printf 'DISCOVERED_VITEST_CONFIGS: %s\n' "$(discover_packages | /usr/bin/grep -c . || true)"
printf 'PACKAGES_TO_MEASURE: %s\n' "$PKG_COUNT"
printf '%s\n' "$PKGS" | sed 's/^/  - /'
printf 'RUNS_PER_PACKAGE: %s\n' "$RUNS"

if [ "$DO_LIST" -eq 1 ]; then
  exit 0
fi

REPORTER="$REPO_ROOT/scripts/lib/vitest-gap-reporter.mjs"
[ -f "$REPORTER" ] || die "reporter not found at $REPORTER"

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="$(mktemp -d)"
fi
mkdir -p "$OUT_DIR"
printf 'OUT_DIR: %s\n\n' "$OUT_DIR"

run_one() {
  local pkg="$1" n="$2"
  local log
  log="$OUT_DIR/$(printf '%s' "$pkg" | tr '/.' '__')-run$n.jsonl"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would run: (cd %s && GAP_LOG=%s npx vitest run --reporter=%s)\n' \
      "$REPO_ROOT/$pkg" "$log" "$REPORTER"
    return 0
  fi

  : > "$log"
  printf '  run %s/%s (%s) ... ' "$n" "$RUNS" "$pkg"
  # The suite's own pass/fail is NOT the subject here -- a red test still emits events, and
  # the gaps are still valid. But a run that produced NO events is a measurement failure and
  # is caught below by the zero-event check, not by this exit code.
  (
    cd "$REPO_ROOT/$pkg" \
      && GAP_LOG="$log" npx vitest run --reporter="$REPORTER" >"$log.stdout" 2>&1
  ) || true
  printf 'events=%s\n' "$(/usr/bin/grep -c . "$log" || true)"
}

for pkg in $PKGS; do
  n=1
  while [ "$n" -le "$RUNS" ]; do
    run_one "$pkg" "$n"
    n=$((n + 1))
  done
done

if [ "$DRY_RUN" -eq 1 ]; then
  exit 0
fi

printf '\n'
node "$REPO_ROOT/scripts/lib/vitest-gap-analyse.mjs" "$OUT_DIR"

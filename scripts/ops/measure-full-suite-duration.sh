#!/usr/bin/env bash
# MEASURE the full-suite wall-clock duration, so D-8's absolute ceiling is DERIVED rather than typed.
#
# ⛔ WHY THIS SCRIPT EXISTS INSTEAD OF A NUMBER IN A COMMENT (CR-68). D-8's criterion is that the
# absolute ceiling sit "at least an order of magnitude above the measured full-suite duration, so it
# can never pre-empt the detector". A constant about the outside world is a CLAIM, and a comment
# asserting one is safe ("well under", "typical") is an unprobed capability claim. The ceiling is
# only defensible if the number under it can be re-derived on demand, on THIS host, under whatever
# load it actually runs with.
#
# ⛔ AND THE CEILING MUST NEVER BE THE THING THAT FIRES. The detector's bound is 90s of SILENCE; this
# ceiling bounds TOTAL RUNTIME. A healthy suite legitimately runs far longer than 90s while never
# going quiet for 90s, so if the ceiling sat anywhere near the suite's real duration it would kill
# healthy runs and — worse — its kill would be indistinguishable from a detection to anyone reading
# only the exit status. An order of magnitude is the margin that makes "the ceiling fired" mean
# "something is catastrophically wrong", never "this suite was a bit slow today".
#
# ⚠️ WALL CLOCK IS A PROPERTY OF THE HOST, NOT THE CODE (G27). That is exactly why this is a
# MEASUREMENT feeding a deliberately enormous margin, and NOT an assertion. Nothing here asserts a
# duration; a bound asserted against wall clock fails in both directions — red when the machine is
# busy, green when the implementation regressed on a fast box. Several sessions work this repo
# concurrently, so a contended host is the NORMAL state and the measurement should be taken under it.
#
# M1: reports its denominator (runs completed) and the spread, never a lone number.
# M2: a run that produced no usable duration is an ERROR, never a silent zero.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

RUNS=3
PACKAGE="packages/core"
usage() {
  cat <<'USAGE'
usage: measure-full-suite-duration.sh [--runs N] [--package DIR]

  --runs N       how many full-suite runs to time (default 3)
  --package DIR  which workspace's suite to time (default packages/core)

Reports every run's duration, the min/median/max, and the ceiling an order of
magnitude above the MAX. Exits 2 if any run failed to yield a duration.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="${2:?--runs needs a value}"; shift 2 ;;
    --package) PACKAGE="${2:?--package needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'measure-full-suite-duration.sh: unrecognised argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$RUNS" in
  ''|*[!0-9]*) printf 'ERROR: --runs must be a positive integer, got %s\n' "$RUNS" >&2; exit 2 ;;
esac
[ "$RUNS" -ge 1 ] || { printf 'ERROR: --runs must be >= 1\n' >&2; exit 2; }

TARGET="$ROOT/$PACKAGE"
# `-e` not `-f`: the target is a DIRECTORY here, and a `-f` preflight on a directory is a check that
# can only ever refuse — a mistake this session has already paid for once.
[ -e "$TARGET" ] || { printf 'ERROR: package path does not exist: %s\n' "$TARGET" >&2; exit 2; }

printf 'MEASURING full-suite duration\n'
printf '  package : %s\n' "$PACKAGE"
printf '  runs    : %s\n' "$RUNS"
printf '  host    : load %s\n' "$(sysctl -n vm.loadavg 2>/dev/null || echo unknown)"
printf '\n'

DURATIONS=()
OK_RUNS=0
FAILED_RUNS=0

i=0
while [ "$i" -lt "$RUNS" ]; do
  i=$((i + 1))
  LOG="$(mktemp "${TMPDIR:-/tmp}/suite-dur-XXXXXX")"
  # `date +%s` rather than a shell SECONDS delta, so the value survives a subshell.
  START="$(date +%s)"
  ( cd "$TARGET" && npx vitest run >"$LOG" 2>&1 )
  RC=$?
  END="$(date +%s)"
  ELAPSED=$((END - START))

  # ⛔ A FAILING SUITE STILL YIELDS A VALID DURATION, and that distinction matters: the ceiling is
  # about how long a run TAKES, not whether it passed. But a run that could not START yields a
  # duration of roughly zero, which would silently drag the measurement down — so an implausibly
  # short run is an ERROR rather than a data point.
  if [ "$ELAPSED" -lt 5 ]; then
    printf '  run %s: ERROR — completed in %ss (exit %s), too short to be a real full suite\n' \
      "$i" "$ELAPSED" "$RC" >&2
    printf '          first lines of its log:\n' >&2
    head -5 "$LOG" >&2
    FAILED_RUNS=$((FAILED_RUNS + 1))
  else
    printf '  run %s: %ss (suite exit %s)\n' "$i" "$ELAPSED" "$RC"
    DURATIONS+=("$ELAPSED")
    OK_RUNS=$((OK_RUNS + 1))
  fi
  rm -f "$LOG"
done

printf '\nRUNS_COMPLETED: %s of %s\n' "$OK_RUNS" "$RUNS"
printf 'RUNS_UNUSABLE:  %s\n' "$FAILED_RUNS"

# M1/M2: "0 runs, 0 seconds" must be a LOUD error, never a pass that yields a tiny ceiling.
if [ "$OK_RUNS" -eq 0 ]; then
  printf 'ERROR: no run produced a usable duration — this measurement proves NOTHING.\n' >&2
  exit 2
fi

SORTED="$(printf '%s\n' "${DURATIONS[@]}" | LC_ALL=C sort -n)"
MIN="$(printf '%s\n' "$SORTED" | head -1)"
MAX="$(printf '%s\n' "$SORTED" | tail -1)"
MED="$(printf '%s\n' "$SORTED" | awk '{a[NR]=$1} END {print (NR%2) ? a[(NR+1)/2] : int((a[NR/2]+a[NR/2+1])/2)}')"

printf 'DURATIONS_S (sorted): %s\n' "$(printf '%s\n' "$SORTED" | tr '\n' ' ')"
printf 'MIN_S: %s   MEDIAN_S: %s   MAX_S: %s\n' "$MIN" "$MED" "$MAX"

# The ceiling is an order of magnitude above the WORST observed run, not the median: the margin has
# to absorb the contention that makes the worst case worse, and the whole point is that the ceiling
# is never the thing that fires.
CEIL=$((MAX * 10))
printf '\nRECOMMENDED_ABSOLUTE_CEILING_S: %s   (10x the MAX observed run, not the median)\n' "$CEIL"
printf '  The detector bounds SILENCE at 90s. This bounds TOTAL RUNTIME, which is a different\n'
printf '  quantity: a healthy suite runs far longer than 90s while never going quiet that long.\n'
printf '  At %ss the ceiling cannot pre-empt the detector on any run resembling those measured.\n' "$CEIL"
exit 0

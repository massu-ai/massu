#!/usr/bin/env bash
# D-4: MEASURE LAUNCH-TO-FIRST-BEAT. Ship the measuring script, never the number (CR-68).
#
# The supervisor needs a STARTUP GRACE, and the plan says why it cannot be invented: before the
# first heartbeat exists there IS no heartbeat, and `classify` correctly returns CANNOT_LOOK for a
# missing beat. CANNOT_LOOK is designed to be FATAL, so a supervisor that treated its first poll as
# fatal would kill every run before it started, and one that treated it as benign would be blind to
# a collection deadlock forever. The resolution is a bounded grace — and a grace is a claim about
# the outside world, so it gets measured.
#
# ⛔ WHAT IS BEING MEASURED, PRECISELY: the interval from `exec`ing the runner to the moment the
# FIRST `heartbeat.json` becomes readable under a fresh base. Not "how long the suite takes"; not
# "how long collection takes". The FIRST EVENT NAME is reported alongside each figure, so a run
# that caught a later beat instead of the first one is visible rather than silently averaged in.
#
# ⚠️ THE CONTENTION ASYMMETRY, AND IT RUNS THE OPPOSITE WAY FROM D-1's BOUND. For the SILENCE
# bound, host load was the enemy: a loaded host inflates gaps and a bound widened to absorb that is
# exactly G27's forbidden move. For a STARTUP GRACE the inflation is CONSERVATIVE — a loaded host
# gives a LARGER launch time, hence a larger grace, hence fewer false "it never started" verdicts.
# That is the safe direction, so measuring under load is acceptable here in a way it was not there.
# ⛔ It is NOT free, and the trade must not be buried: every second of grace is a second a genuine
# collection deadlock goes unreported. Report the host's load with the figures so the reader can
# see which regime the numbers came from.
#
# ⛔ NOTHING IS DELETED. Each run gets its own `mktemp -d` base and the paths are reported rather
# than removed. On a machine whose history includes two autonomous mass deletions, an instrument
# that leaves temp directories for the OS to reclaim is preferable to one that carries an `rm` it
# does not need (G8/G17). The bases are named in the output if you want them gone.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

RUNS=6
PACKAGE="packages/core"
TARGET="src/__tests__/license.test.ts"
POLL_S=0.05
LIST=0

usage() {
  cat <<'USAGE'
usage: measure-heartbeat-startup.sh [--runs N] [--package DIR] [--target REL] [--list]

  --runs N      how many launches to measure (default 6, matching D-1's derivation)
  --package DIR the vitest RUN ROOT to launch, repo-relative (default packages/core)
  --target REL  the test file to run, relative to the package (default a small one)
  --list        print the discovered run roots and exit, running nothing

Reports every run's launch-to-first-beat in ms, the first event name observed, and the
DENOMINATOR (requested / completed / produced-a-beat). Exits 2 if any run produced no beat —
a missing measurement is an error, never a smaller sample.
USAGE
}

# R-011: refuse an unrecognised argument and LIST the candidates rather than resolving to the
# likeliest one.
while [ $# -gt 0 ]; do
  case "$1" in
    --runs)    RUNS="${2:?--runs needs a value}"; shift 2 ;;
    --package) PACKAGE="${2:?--package needs a value}"; shift 2 ;;
    --target)  TARGET="${2:?--target needs a value}"; shift 2 ;;
    --list)    LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'measure-heartbeat-startup: unrecognised argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# The run-root set is DISCOVERED, never a roster (G32) — and it is also the --package candidate
# list, so a refusal can name real options.
# ⛔ ASK THE ONE MODULE THAT OWNS THIS PREDICATE. The first draft of this function re-derived
# it with `grep -q defineProject` and SILENTLY DROPPED the repo's most important run root, because
# the root config's line 6 is a COMMENT reading "…or an inline `defineProject({...})` call". A
# grep cannot tell code from prose, and this was the third occurrence of that defect in one
# session. `scripts/lib/vitest-run-roots.mjs` is comment-aware and fails closed; a consumer that
# asks it is correct by construction rather than detectably wrong (Rule 25 / G32).
discover_run_roots() {
  node "$ROOT/scripts/lib/vitest-run-roots.mjs" --run-roots-only
}

if ! ROOTS="$(discover_run_roots)"; then
  printf 'FATAL: run-root discovery FAILED (see its message above). An empty candidate set from a\n' >&2
  printf '       broken discoverer is indistinguishable from a tree with no run roots, so this\n' >&2
  printf '       exits rather than measuring nothing (M2).\n' >&2
  exit 2
fi
ROOT_COUNT="$(printf '%s\n' "$ROOTS" | /usr/bin/grep -c . || true)"

printf 'DISCOVERED_RUN_ROOTS: %s\n' "$ROOT_COUNT"
printf '%s\n' "$ROOTS" | sed 's/^/  /'

# M1: an empty candidate set is a LOUD error, never a quiet zero.
if [ "$ROOT_COUNT" -eq 0 ]; then
  printf 'FATAL: discovered ZERO vitest run roots — the instrument cannot measure anything\n' >&2
  exit 2
fi

if [ "$LIST" -eq 1 ]; then
  printf '\n--list: discovery only, nothing was launched.\n'
  exit 0
fi

if ! printf '%s\n' "$ROOTS" | /usr/bin/grep -qx "$PACKAGE"; then
  printf '\nmeasure-heartbeat-startup: --package %s is not a discovered RUN ROOT.\n' "$PACKAGE" >&2
  printf 'Candidates are listed above. Refusing to resolve to the likeliest one (R-011).\n' >&2
  exit 2
fi

# A FILE or a DIRECTORY, both of which vitest accepts as a filter. The first draft required a
# file, which made the most important question unanswerable: whether a FULL-SUITE launch reaches
# its first beat as fast as a single-file one. It refused correctly rather than passing an
# unresolvable target to vitest (which would have silently run the whole suite and measured a
# different thing) — but refusing a legitimate case is still a gap in the instrument, not in the
# question.
[ -e "$ROOT/$PACKAGE/$TARGET" ] || {
  printf 'measure-heartbeat-startup: target not found (need an existing file or directory): %s/%s\n' \
    "$PACKAGE" "$TARGET" >&2
  exit 2
}

printf '\nHOST LOAD AT START: %s\n' "$(uptime | sed 's/.*load averages*: //')"
printf 'MEASURING: %s launch(es) of %s running %s\n\n' "$RUNS" "$PACKAGE" "$TARGET"

COMPLETED=0
WITH_BEAT=0
MS_LIST=""

i=0
while [ "$i" -lt "$RUNS" ]; do
  i=$((i + 1))
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/hb-startup-XXXXXX")"

  T0_NS="$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')"

  ( cd "$ROOT" && HANG_HEARTBEAT_BASE="$BASE" \
      npx vitest run --root "$PACKAGE" "$TARGET" > "$BASE/suite.log" 2>&1 ) &
  RUNNER=$!

  FIRST_BEAT=""
  while kill -0 "$RUNNER" 2>/dev/null; do
    FIRST_BEAT="$(find "$BASE" -name heartbeat.json -type f 2>/dev/null | head -1)"
    [ -n "$FIRST_BEAT" ] && break
    sleep "$POLL_S"
  done

  if [ -n "$FIRST_BEAT" ]; then
    T1_NS="$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
    # The first event's NAME, so a run that caught a LATER beat is visible rather than averaged in.
    EV="$(node -e '
      try {
        const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(d.event || "(no event field)"));
      } catch (e) { process.stdout.write("UNREADABLE"); }
    ' "$FIRST_BEAT" 2>/dev/null || echo UNREADABLE)"
    MS="$(node -e 'process.stdout.write(String(Math.round(Number(BigInt(process.argv[2]) - BigInt(process.argv[1])) / 1e6)))' "$T0_NS" "$T1_NS")"
    WITH_BEAT=$((WITH_BEAT + 1))
    MS_LIST="$MS_LIST $MS"
    printf 'run %s: launch_to_first_beat_ms=%-6s first_event=%-22s base=%s\n' "$i" "$MS" "$EV" "$BASE"
  else
    printf 'run %s: NO BEAT — the run finished without ever writing a heartbeat  base=%s\n' "$i" "$BASE"
  fi

  wait "$RUNNER" 2>/dev/null
  COMPLETED=$((COMPLETED + 1))
done

printf '\n=== DENOMINATOR ===\n'
printf 'RUNS_REQUESTED: %s\n' "$RUNS"
printf 'RUNS_COMPLETED: %s\n' "$COMPLETED"
printf 'RUNS_WITH_A_BEAT: %s\n' "$WITH_BEAT"

# M2: a run that never beat is an ERROR. Silently reporting a statistic over the survivors would
# be a measurement of the wrong population — and "some runs never beat" is itself the finding.
if [ "$WITH_BEAT" -ne "$COMPLETED" ]; then
  printf 'FATAL: %s of %s run(s) produced NO heartbeat. The grace cannot be derived from a\n' \
    "$((COMPLETED - WITH_BEAT))" "$COMPLETED" >&2
  printf '       population that excludes them — and a run that never beats is exactly the\n' >&2
  printf '       state the grace exists to bound, so this is a finding, not a smaller sample.\n' >&2
  exit 2
fi
if [ "$WITH_BEAT" -eq 0 ]; then
  printf 'FATAL: zero measurements — this run proves nothing (M1)\n' >&2
  exit 2
fi

printf '\n=== LAUNCH-TO-FIRST-BEAT (ms) ===\n'
node -e '
  const xs = process.argv.slice(1).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) { console.error("FATAL: no finite samples"); process.exit(2); }
  const med = xs.length % 2 ? xs[(xs.length - 1) / 2] : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  console.log("samples : " + xs.length);
  console.log("values  : " + xs.join(" "));
  console.log("min     : " + xs[0]);
  console.log("median  : " + med);
  console.log("max     : " + xs[xs.length - 1]);
  console.log("spread  : " + (xs[0] > 0 ? (xs[xs.length - 1] / xs[0]).toFixed(1) + "x" : "n/a (min is 0)"));
  console.log("");
  console.log("The GRACE is derived from the MAX, not the median: it must cover the slowest");
  console.log("legitimate launch or it fails a healthy run. Apply a margin deliberately and");
  console.log("state it — and remember every second of grace is a second a real collection");
  console.log("deadlock goes unreported, so this is a trade, not a free choice.");
' $MS_LIST

printf '\nHOST LOAD AT END: %s\n' "$(uptime | sed 's/.*load averages*: //')"
exit 0

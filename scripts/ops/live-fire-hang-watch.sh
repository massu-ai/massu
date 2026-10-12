#!/usr/bin/env bash
# CR-72 attacker for the hang detector — plan-a-hang-is-the-absence-of-events, D-7.
#
# ⛔ THIS IS BUILT BEFORE THE DETECTOR, DELIBERATELY. The plan orders D-7's skeleton ahead of
# D-2/D-3 so the attacker cannot be shaped to pass the thing it judges. Writing it first has
# already paid: it surfaced a requirement ON D-3 that the plan did not state (see BOUND below).
#
# ⛔ AND IT FAILS CLOSED UNTIL THE DETECTOR EXISTS. `scripts/lib/hang_watch.mjs` is D-3's
# deliverable. Until it lands, this harness exits 2 — "could not adjudicate" — and NEVER 0. A
# harness that reported success while its subject did not exist would be the purest form of the
# blind-gate defect: nothing to look at, nothing found, green.
#
# THE STOP CONDITION IS PRESENCE, NOT ABSENCE (G24). This does not ask "were there no
# problems?" — a check that cannot run answers that the same way a healthy one does. It asks
# "do all six cases exist, is each wired to a declared verdict, and does each get that
# verdict?" Only the third part needs the detector; the first two are assertable today, and
# `--list` prints them.
#
# ⛔ THE BOUND IS INJECTED, NOT THE PRODUCTION ONE. D-1 measured the production silence bound
# at 90 s (worst legitimate inter-event gap 6,911 ms over 6 contended runs, times an order of
# magnitude). Driving six cases at 90 s each would cost over nine minutes per run, so the
# attacker injects a small bound via the environment. THAT IS A REQUIREMENT ON D-3: the bound
# must be env-overridable, or this harness is unaffordable and will be skipped, and a skipped
# attacker is decoration (CR-72). Recorded in the plan as a D-3 criterion.
#
# ⛔ EVERY CASE RUNS UNDER CONTAINMENT. A hang fixture whose detector is broken hangs the
# HARNESS (G25 one layer out), so each subject goes through br_run_bounded with a ceiling well
# above the injected bound. Reaching that ceiling is its OWN verdict — the detector failed to
# act — and is never collapsed into "the subject exited non-zero".
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# shellcheck source-path=SCRIPTDIR/../lib source=bounded-run.sh
. "$ROOT/scripts/lib/bounded-run.sh"

DETECTOR="$ROOT/scripts/lib/hang_watch.mjs"      # D-3's deliverable
REPORTER="$ROOT/scripts/lib/vitest-gap-reporter.mjs"   # D-1's, already landed

# Injected bounds. Small ON PURPOSE — see the header. The production values are D-1's 90 s.
INJECTED_SILENCE_S="${HANG_SILENCE_S:-5}"
# The harness ceiling must exceed the injected bound by enough that reaching it means the
# DETECTOR failed, not that the bound had not yet elapsed.
HARNESS_CEILING_S="${LF_HANG_CEILING_S:-45}"

DO_LIST=0
case "${1:-}" in
  --list) DO_LIST=1 ;;
  "") ;;
  *) printf '%s: unrecognised argument: %s (only --list)\n' "$(basename "$0")" "$1" >&2; exit 2 ;;
esac

# ── THE SIX CASES ─────────────────────────────────────────────────────────────────────────
# Each row: id | required verdict | what it proves. The verdict vocabulary is CLOSED; an
# unrecognised one is an ERROR rather than a skipped row (G3).
#
# ⛔ CASE 2 IS THE ONE TO LEAD WITH. It is the case a wall-clock bound FAILS (it fires on a
# slow-but-healthy suite) and the case CPU-progress CANNOT SEE (a busy suite and a spinning
# deadlock look identical). Event-silence is the only one of the three that gets it right.
#
# ⛔ CASE 3 IS SPLIT, AND THE SPLIT IS A CORRECTION. This plan's first draft demanded a
# sleeping test "must NOT be reported" — unsatisfiable, because a sleeping test emits no events,
# so past the bound the detector fires and is RIGHT to. 3a/3b state what the design actually
# promises.
CASES="
hung-forever|REPORTED|a test awaiting a promise that never settles is reported, exit 142
slow-but-progressing|SILENT|⭐ a slow suite that keeps emitting events is NOT reported — the case wall-clock fails and CPU-progress cannot see
sleep-under-bound|SILENT|a unit blocking for less than the bound is not a false positive
sleep-over-bound|REPORTED|a unit blocking for longer than the bound IS reported, and named
beforeall-hang|REPORTED_NAMES_HOOK|a hang in beforeAll is reported AND names the hook — D-6's precondition for deleting hookTimeout
import-hang|REPORTED_NAMES_MODULE|a never-resolving top-level await is reported AND names the module
zero-events|ERROR|a run that emits nothing is an ERROR, never a pass (M2)
"

valid_verdict() {
  case "$1" in
    REPORTED|SILENT|REPORTED_NAMES_HOOK|REPORTED_NAMES_MODULE|ERROR) return 0 ;;
    *) return 1 ;;
  esac
}

n_cases=0
bad_verdicts=0
while IFS='|' read -r id verdict why; do
  [ -n "$id" ] || continue
  n_cases=$((n_cases + 1))
  if ! valid_verdict "$verdict"; then
    printf '  ERROR case %s declares an unrecognised verdict: %s\n' "$id" "$verdict" >&2
    bad_verdicts=$((bad_verdicts + 1))
  fi
  if [ "$DO_LIST" -eq 1 ]; then
    printf '  %-22s %-22s %s\n' "$id" "$verdict" "$why"
  fi
done <<EOF
$(printf '%s\n' "$CASES")
EOF

# M1 — report the denominator every run, and ASSERT it. "0 cases, 0 failures" must be loud.
printf 'CASES_DECLARED: %s\n' "$n_cases"
printf 'INJECTED_SILENCE_S: %s   (production bound is 90s — D-1 measured)\n' "$INJECTED_SILENCE_S"
printf 'HARNESS_CEILING_S: %s    (containment; reaching it means the DETECTOR failed)\n' "$HARNESS_CEILING_S"

if [ "$n_cases" -eq 0 ]; then
  printf 'ERROR: zero cases declared — a harness over nothing is not a harness\n' >&2
  exit 2
fi
if [ "$bad_verdicts" -gt 0 ]; then
  printf 'ERROR: %s case(s) declare a verdict outside the closed vocabulary\n' "$bad_verdicts" >&2
  exit 2
fi
if [ "$n_cases" -ne 7 ]; then
  # 7 rows = 6 numbered cases, because case 3 is split into 3a/3b.
  printf 'ERROR: expected 7 declared rows (6 cases, case 3 split), found %s\n' "$n_cases" >&2
  exit 2
fi

[ "$DO_LIST" -eq 1 ] && exit 0

# ── M2: FAIL CLOSED WHILE THE SUBJECT DOES NOT EXIST ──────────────────────────────────────
missing=0
if [ ! -f "$DETECTOR" ]; then
  printf '\nCANNOT ADJUDICATE: the detector does not exist yet.\n' >&2
  printf '  expected: scripts/lib/hang_watch.mjs   (D-3)\n' >&2
  missing=1
fi
if [ ! -f "$REPORTER" ]; then
  printf 'CANNOT ADJUDICATE: the progress reporter is missing.\n' >&2
  printf '  expected: scripts/lib/vitest-gap-reporter.mjs   (D-1)\n' >&2
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  printf '\n%s: EXIT 2 — could not adjudicate.\n' "$(basename "$0")" >&2
  printf '  This is NOT a pass and NOT a failure of the detector. It is the harness refusing\n' >&2
  printf '  to report a verdict it cannot have. All %s cases are declared and wired; run\n' "$n_cases" >&2
  printf '  --list to see them. They adjudicate once D-2 and D-3 land.\n' >&2
  exit 2
fi

# ── THE CASE BODIES ───────────────────────────────────────────────────────────────────────
#
# ⛔ THE SUBJECT IS DRIVEN THROUGH THE SUPERVISOR, NOT THROUGH A POLL LOOP WRITTEN HERE.
# `hang-supervise.mjs` already composes the rule and polls it, and it is proven across seven
# outcomes by its own attacker. Re-implementing that loop in bash would put the decision in two
# places, and when two implementations of one decision drift, the harness and production
# disagree about what a hang IS — which is the same reasoning that put the observation surface in
# one module. So this harness supplies REAL VITEST RUNS with real hang shapes and asserts the
# verdict; the sibling attacker supplies synthetic beats and asserts the plumbing. Complementary,
# not redundant.
#
# ⛔ EACH CASE GETS AN ISOLATED HEARTBEAT BASE. Several sessions work this repo at once, and the
# supervisor's attribution rule exists precisely so one run never reports on another's. Sharing a
# base between cases would let case N's stale beat decide case N+1.
#
# ⛔ THE FIXTURES SET testTimeout AND hookTimeout ABSURDLY HIGH, ON PURPOSE. If vitest's own
# timeout fired first the hang would self-resolve, the detector would never be the thing that
# acted, and the case would pass while proving nothing about the detector. The whole point of
# D-6 is that those timeouts are the wrong instrument; here they are neutralised so the right
# instrument is the only one that can act.
#
# ⛔ G25 — EVERY FIXTURE IS INERT UNDER EVERY PLANT. They block, and that is all they do: no
# deletion, no signal, no spawn, no path interpolated into any command. They are GENERATED at
# runtime into a temp dir, never tracked, so no file in this repo carries a payload whose job is
# to never finish where a glob could pick it up.

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lf-hang-watch-XXXXXX")"
printf 'WORK DIR (kept for inspection, nothing deleted): %s\n\n' "$WORK"

PASS=0
FAIL=0
ok() { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  BAD  %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

# write_fixture <case-id> <dir> — materialises the vitest project for one case.
# Returns 1 for an unrecognised id: a case declared in the table with no fixture must be a LOUD
# error, never a silently skipped row (G3).
write_fixture() {
  fx_id="$1"
  fx_dir="$2"
  mkdir -p "$fx_dir/tests"
  ln -sfn "$ROOT/node_modules" "$fx_dir/node_modules"
  cat > "$fx_dir/vitest.config.ts" <<'VCFG'
import { defineConfig } from 'vitest/config';
// The timeouts are deliberately enormous — see the header. If vitest timed the hang out, the
// detector would never be the thing that acted and the case would prove nothing.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 600000, hookTimeout: 600000 },
});
VCFG

  case "$fx_id" in
    hung-forever)
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
import { it } from 'vitest';
it('awaits a promise that never settles', async () => {
  await new Promise(() => {});
});
TEOF
      ;;
    slow-but-progressing)
      # ⭐ THE CASE THAT DISCRIMINATES. Total runtime EXCEEDS the bound while every inter-event
      # gap stays well under it. A wall-clock budget fires here and is WRONG; CPU-progress
      # sampling cannot tell this from a spinning deadlock. Event-silence gets it right, and
      # this row is the only evidence of that.
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
import { it } from 'vitest';
const STEP_MS = 400;
const STEPS = 20; // 20 * 400ms = 8s total, each gap 0.4s — long run, short silences.
for (let i = 0; i < STEPS; i += 1) {
  it(`step ${i} finishes quickly and emits events`, async () => {
    await new Promise((r) => setTimeout(r, STEP_MS));
  });
}
TEOF
      ;;
    sleep-under-bound)
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
import { it } from 'vitest';
// Blocks for less than the injected bound, so the detector must NOT fire.
it('blocks briefly', async () => {
  await new Promise((r) => setTimeout(r, Number(process.env.LF_UNDER_MS || '1500')));
});
TEOF
      ;;
    sleep-over-bound)
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
import { it } from 'vitest';
// Blocks for LONGER than the injected bound. A sleeping test emits no events, so past the
// bound the detector fires and is RIGHT to — this is the 3a/3b split the plan corrected.
it('blocks past the bound', async () => {
  await new Promise((r) => setTimeout(r, Number(process.env.LF_OVER_MS || '600000')));
});
TEOF
      ;;
    beforeall-hang)
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
import { beforeAll, it } from 'vitest';
beforeAll(async () => {
  await new Promise(() => {});
});
it('never runs because beforeAll never returns', () => {});
TEOF
      ;;
    import-hang)
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
// Measured 2026-09-24: this shape emits EXACTLY ONE event, onTestModuleQueued. It never reaches
// onTestModuleCollected or onTestModuleStart, so it is nameable only because the heartbeat opens
// an open_modules row on Queued as well as Start.
await new Promise(() => {});

import { it } from 'vitest';
it('never runs because the import never completes', () => {});
TEOF
      ;;
    zero-events)
      # The fixture itself is healthy. What is broken is the OBSERVATION: the run's heartbeat
      # base is made unreadable, so the rule cannot look. See the ERROR branch below for why
      # this shape and not the no-beat-within-grace one.
      cat > "$fx_dir/tests/subject.test.ts" <<'TEOF'
import { it, expect } from 'vitest';
it('is a perfectly healthy test', () => {
  expect(1 + 1).toBe(2);
});
TEOF
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

# run_case <case-id> <dir> — drives the fixture through the supervisor under containment.
# Echoes "<exit> <report-path-or-NONE>"; never interprets. Interpretation is the caller's job so
# that "what happened" and "was that right" stay separable.
run_case() {
  rc_id="$1"
  rc_dir="$2"
  rc_base="$rc_dir/hb"
  mkdir -p "$rc_base"

  if [ "$rc_id" = "zero-events" ]; then
    # M2's subject: an UNREADABLE base. `discoverRuns` returns null (never []), the supervisor
    # reports CANNOT_LOOK, and the run's own success is NOT allowed to stand in for a verdict.
    chmod 000 "$rc_base" 2>/dev/null || true
  fi

  br_run_bounded "$HARNESS_CEILING_S" "$rc_dir/run.log" \
    env \
      HANG_HEARTBEAT_BASE="$rc_base" \
      HANG_SILENCE_S="$INJECTED_SILENCE_S" \
      HANG_STARTUP_GRACE_S="${LF_HANG_GRACE_S:-25}" \
      node "$ROOT/scripts/lib/hang-supervise.mjs" --on-hang report -- \
        npx vitest run --root "$rc_dir" \
          --reporter="$ROOT/scripts/lib/vitest-heartbeat-reporter.mjs"
  rc_exit=$?

  # Restore permissions immediately, so a failure later in this script cannot leave an
  # unreadable directory behind for the operator to discover.
  [ "$rc_id" = "zero-events" ] && chmod 755 "$rc_base" 2>/dev/null

  rc_report="$(find "$rc_base/_reports" -name 'hang-*.txt' -type f 2>/dev/null | head -1)"
  printf '%s %s\n' "$rc_exit" "${rc_report:-NONE}"
}

EXIT_HUNG=142
EXIT_CANNOT_LOOK=2

adjudicated=0
while IFS='|' read -r id verdict why; do
  [ -n "$id" ] || continue
  printf '%s  (requires %s)\n' "$id" "$verdict"

  case_dir="$WORK/$id"
  if ! write_fixture "$id" "$case_dir"; then
    bad "$id: DECLARED IN THE TABLE WITH NO FIXTURE — a row with no body is a silent skip"
    continue
  fi

  observed="$(run_case "$id" "$case_dir")"
  obs_exit="${observed%% *}"
  obs_report="${observed##* }"
  adjudicated=$((adjudicated + 1))

  # ⛔ THE CEILING IS ITS OWN VERDICT AND IS NEVER COLLAPSED INTO "the subject failed".
  # Reaching it means the DETECTOR did not act — which is the state this harness exists to
  # detect — so it must be reported as that and not as an ordinary non-zero exit.
  if [ "$obs_exit" = "$BR_EXIT_CEILING" ]; then
    bad "$id: reached the ${HARNESS_CEILING_S}s HARNESS CEILING — the detector never acted"
    continue
  fi

  case "$verdict" in
    REPORTED)
      if [ "$obs_exit" -eq "$EXIT_HUNG" ]; then
        ok "$id: exit $EXIT_HUNG — reported"
      else
        bad "$id: expected exit $EXIT_HUNG, got $obs_exit"
      fi
      if [ "$obs_report" != "NONE" ] && [ -s "$obs_report" ]; then
        ok "$id: a non-empty report was written"
      else
        bad "$id: exit said HUNG but no report names what was stuck"
      fi
      ;;
    SILENT)
      # The subject's own status passes through. 0 here also proves the fixture is genuinely
      # healthy, so a false-positive row cannot pass by the suite happening to fail.
      if [ "$obs_exit" -eq 0 ]; then
        ok "$id: exit 0 — the subject's own status, no false positive"
      else
        bad "$id: expected exit 0 (no detection), got $obs_exit"
      fi
      if [ "$obs_report" = "NONE" ]; then
        ok "$id: no report was written"
      else
        bad "$id: a report was written for a healthy run — FALSE POSITIVE"
      fi
      ;;
    REPORTED_NAMES_HOOK)
      if [ "$obs_exit" -eq "$EXIT_HUNG" ]; then
        ok "$id: exit $EXIT_HUNG — reported"
      else
        bad "$id: expected exit $EXIT_HUNG, got $obs_exit"
      fi
      # D-6's precondition: the report must name the HOOK, not merely the file. Before
      # 2026-09-24 the observation surface preferred one identity field and recorded only
      # `name=beforeAll`, discarding the owner; this assertion is what would have caught that.
      if [ "$obs_report" != "NONE" ] && /usr/bin/grep -q 'name=beforeAll' "$obs_report"; then
        ok "$id: the report NAMES the hook (name=beforeAll)"
      else
        bad "$id: the report does not name the hook — D-6 cannot delete hookTimeout"
      fi
      if [ "$obs_report" != "NONE" ] && /usr/bin/grep -q 'subject.test.ts' "$obs_report"; then
        ok "$id: the report also names the OWNING MODULE"
      else
        bad "$id: the hook is named but its owning module is not — attribution is half done"
      fi
      ;;
    REPORTED_NAMES_MODULE)
      if [ "$obs_exit" -eq "$EXIT_HUNG" ]; then
        ok "$id: exit $EXIT_HUNG — reported"
      else
        bad "$id: expected exit $EXIT_HUNG, got $obs_exit"
      fi
      if [ "$obs_report" != "NONE" ] && /usr/bin/grep -q 'subject.test.ts' "$obs_report"; then
        ok "$id: the report NAMES the stuck module"
      else
        bad "$id: the report does not name the module that never finished importing"
      fi
      # An import hang emits ONLY onTestModuleQueued (measured). If the heartbeat ever stops
      # opening a row on Queued, the module vanishes from the open set and this row goes RED —
      # which is the point: that branch is load-bearing and must not be tidied to Start-only.
      if [ "$obs_report" != "NONE" ] && /usr/bin/grep -q 'onTestModuleQueued' "$obs_report"; then
        ok "$id: named via onTestModuleQueued — the Queued branch is doing the work"
      else
        bad "$id: the module is named but not via Queued — check the open-module branch"
      fi
      ;;
    ERROR)
      # ⛔ WHY THE UNREADABLE BASE AND NOT "a run that never beats".
      # "Zero events" has TWO causes and they are indistinguishable from outside: the
      # observation surface broke, or the suite deadlocked before its first event. The
      # supervisor resolves the second to 142 (hang-supervise.mjs:304) and reserves 2 for an
      # unreadable base (:260). Resolving toward 142 is sound — 142 is the ALARMING direction,
      # and the blind-gate law forbids resolving ambiguity toward the PASSING value, not toward
      # the loud one. So this row drives the cause that genuinely produces ERROR rather than
      # rewriting the declared verdict to match whatever the code happens to do.
      if [ "$obs_exit" -eq "$EXIT_CANNOT_LOOK" ]; then
        ok "$id: exit $EXIT_CANNOT_LOOK — COULD NOT LOOK, never the subject's status"
      else
        bad "$id: expected exit $EXIT_CANNOT_LOOK, got $obs_exit"
      fi
      # THE POINT OF THE ROW: the underlying suite PASSES. If an unobservable run were allowed
      # to inherit its subject's success, this is exactly where a 0 would sneak through.
      if [ "$obs_exit" -ne 0 ]; then
        ok "$id: a healthy-but-unobserved run did NOT inherit exit 0"
      else
        bad "$id: an unobserved run passed on its subject's status — M2 violated"
      fi
      ;;
    *)
      bad "$id: unrecognised verdict $verdict reached the body — the vocabulary is not closed"
      ;;
  esac
done <<EOF
$(printf '%s\n' "$CASES")
EOF

# M1 — the bodies get a denominator too, and it must equal the declared count. A harness that
# adjudicated fewer cases than it declared has silently lost rows, which is the failure this
# whole file exists to make impossible.
printf '\nCASES_ADJUDICATED: %s of %s declared\n' "$adjudicated" "$n_cases"
if [ "$adjudicated" -ne "$n_cases" ]; then
  printf 'ERROR: %s declared case(s) were never adjudicated\n' "$((n_cases - adjudicated))" >&2
  FAIL=$((FAIL + 1))
fi
if [ "$PASS" -eq 0 ]; then
  printf 'ERROR: zero assertions ran — a harness that asserts nothing cannot pass\n' >&2
  FAIL=$((FAIL + 1))
fi

printf '\n=== %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

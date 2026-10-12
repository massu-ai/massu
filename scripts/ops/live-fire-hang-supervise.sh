#!/usr/bin/env bash
# CR-72 attacker for scripts/lib/hang-supervise.mjs — D-4's supervisor.
#
# ⛔ THIS IS NOT D-7's HARNESS AND DOES NOT DUPLICATE IT. `live-fire-hang-watch.sh` attacks the
# DETECTOR's classification against seven real vitest scenarios. This attacks the SUPERVISOR's
# CONTRACT: which exit code each outcome produces, whether the report is written BEFORE any
# termination decision, whether the startup grace ends on the clock or on the subject's death, and
# whether a run belonging to another session is left alone. Different subject, different failures.
#
# ⛔ THE THREE OUTCOMES MUST STAY APART, AND THAT IS THE WHOLE POINT OF THE EXIT CODES:
#     142  the watcher decided HUNG and acted
#     2    COULD NOT LOOK — an infrastructure fault, NEVER the subject's status
#     else the subject's own status, untouched
# Collapsing 142 into "just another failure" is how a DEAD detector looks like a working one, so
# every row below asserts an EXACT code rather than merely "non-zero".
#
# ⛔ EVERY HANG ROW RUNS UNDER CONTAINMENT. A fixture that never finishes will hang this harness if
# the supervisor is broken — which is exactly the state the harness exists to detect — so each runs
# under `br_run_bounded`, whose ceiling returns its OWN code (124) so "the harness had to intervene"
# can never be read as "the subject failed normally".
#
# ⛔ AND THE FIXTURE IS INERT UNDER EVERY PLANT (G25). The beater BLOCKS; it deletes nothing,
# signals nothing, and carries no destructive token beside a shell metacharacter. Asked of it: "if
# the detector were completely broken, what would this do?" — sit idle until the ceiling reaps it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SUP="$ROOT/scripts/lib/hang-supervise.mjs"
RULE="$ROOT/scripts/lib/hang_watch.mjs"

for f in "$SUP" "$RULE" "$ROOT/scripts/lib/bounded-run.sh"; do
  [ -f "$f" ] || { printf 'live-fire: not found: %s\n' "$f" >&2; exit 2; }
done

# shellcheck source-path=SCRIPTDIR/../lib source=bounded-run.sh
. "$ROOT/scripts/lib/bounded-run.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lf-supervise-XXXXXX")"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  BAD  %s\n' "$1"; }

# A short bound and grace so the proof costs seconds, not 90. TESTABILITY overrides — the
# production constants are untouched, and that distinction is the plan's, not a convenience.
export HANG_SILENCE_S=3
export HANG_STARTUP_GRACE_S=3
export HANG_POLL_MS=200

# ── the inert fixture, generated rather than tracked ────────────────────────────────────────
# Generated so no tracked file in this repo contains a payload whose job is to never finish —
# a glob somewhere else could otherwise pick it up and hang an unrelated run.
BEATER="$WORK/beater.mjs"
cat > "$BEATER" <<'BEATER_EOF'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const base = process.env.HANG_HEARTBEAT_BASE;
if (!base) { process.stderr.write('beater: base unset\n'); process.exit(2); }
const dir = join(base, String(process.pid));
mkdirSync(dir, { recursive: true });
const now = Number(process.hrtime.bigint() / 1000000n);
const beat = {
  t_ms: now, wall: new Date().toISOString(),
  event: 'onTestCaseReady', subject: 'fullName=synthetic > a test that never returns',
  pid: process.pid,
  open_modules: [{ module: '/synthetic/src/__tests__/never-returns.test.ts',
                   opened_at_ms: now, last_event: 'onTestCaseReady', last_t_ms: now }],
};
const t = join(dir, 'heartbeat.json');
writeFileSync(`${t}.tmp`, JSON.stringify(beat) + '\n');
renameSync(`${t}.tmp`, t);
process.stdout.write('beater: beat once, now silent forever\n');
setInterval(() => {}, 1_000_000);
BEATER_EOF

# ⛔ THE PROGRESSOR — the beater's OPPOSITE, and D-8's actual subject.
# The beater beats ONCE and goes silent, which is a HANG. This one beats FOREVER and never
# finishes, which is a RUNAWAY: the detector is asked on every poll and correctly never fires,
# because the run genuinely never goes quiet. No silence bound can catch this shape by
# construction — that is the entire reason the absolute ceiling exists.
#
# ⚠️ IT REPLACES A SUBJECT THAT WAS TOO SHORT, AND THE FIRST ATTEMPT AT R8a PROVED NOTHING.
# R8a originally supervised `vitest run license.test.ts` under a 3s ceiling. That suite completes
# in 2s (measured), so the subject exited BEFORE the ceiling could be reached, the progress branch
# returned its status, and the row failed with `expected 143, got 0`. The control was fine; the
# FIXTURE could not reach the branch under test — a positive control must reach the branch it
# names. A subject that never ends removes the race entirely.
#
# G25: it blocks and beats. It deletes nothing, signals nothing, spawns nothing, and interpolates
# no path into any command. Generated at runtime, never tracked.
PROGRESSOR="$WORK/progressor.mjs"
cat > "$PROGRESSOR" <<'PROGRESSOR_EOF'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const base = process.env.HANG_HEARTBEAT_BASE;
if (!base) { process.stderr.write('progressor: base unset\n'); process.exit(2); }
const dir = join(base, String(process.pid));
mkdirSync(dir, { recursive: true });
const t = join(dir, 'heartbeat.json');
let n = 0;
// 400ms between beats: far below any silence bound, so the rule must always say HEALTHY.
setInterval(() => {
  n += 1;
  const now = Number(process.hrtime.bigint() / 1000000n);
  const beat = {
    t_ms: now, wall: new Date().toISOString(),
    event: 'onTestCaseReady', subject: `fullName=synthetic > progressing step ${n}`,
    pid: process.pid,
    open_modules: [{ module: '/synthetic/src/__tests__/forever.test.ts',
                     opened_at_ms: now, last_event: 'onTestCaseReady', last_t_ms: now }],
  };
  writeFileSync(`${t}.tmp`, JSON.stringify(beat) + '\n');
  renameSync(`${t}.tmp`, t);
}, 400);
process.stdout.write('progressor: beating every 400ms, forever\n');
PROGRESSOR_EOF

fresh_base() {
  local b="$WORK/$1"
  rm -rf "$b"
  mkdir -p "$b"
  printf '%s' "$b"
}

# Assert an EXACT exit code, and branch on the ceiling explicitly.
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$BR_EXIT_CEILING" ]; then
    bad "$label — the HARNESS hit its ceiling; the supervisor never decided, which is the DETECTOR failing"
  elif [ "$got" = "$want" ]; then
    ok "$label — exit $got"
  else
    bad "$label — expected exit $want, got $got"
  fi
}

printf '\n=== live-fire: D-4 supervisor contract ===\n\n'

# ── R1: a healthy subject's own status passes through ───────────────────────────────────────
B="$(fresh_base r1)"
HANG_HEARTBEAT_BASE="$B" br_run_bounded 60 "$WORK/r1.log" \
  node "$SUP" -- node "$ROOT/node_modules/.bin/vitest" run --root packages/core \
  src/__tests__/license.test.ts
expect_exit 'R1 a healthy supervised suite returns ITS OWN status' 0 "$?"

# ── R2: a genuine hang is REPORTED and returns 142 ─────────────────────────────────────────
B="$(fresh_base r2)"
HANG_HEARTBEAT_BASE="$B" br_run_bounded 45 "$WORK/r2.log" \
  node "$SUP" --on-hang terminate -- node "$BEATER"
expect_exit 'R2 a subject that beats once then goes silent returns 142' 142 "$?"

REPORT="$(find "$B/_reports" -name 'hang-*.txt' -type f 2>/dev/null | head -1)"
if [ -z "$REPORT" ]; then
  bad 'R2 no report written — D-4 requires the report BEFORE any termination decision'
else
  ok "R2 report written: $(basename "$REPORT")"
  # A verdict with no named subject is the "something stopped" report every rejected design
  # could already produce. Naming the stuck unit is what makes this one actionable.
  if /usr/bin/grep -q 'never-returns.test.ts' "$REPORT"; then
    ok 'R2 the report NAMES the stuck module, from observed data'
  else
    bad 'R2 the report does not name the stuck module'
  fi
  if /usr/bin/grep -q 'verdict         : HUNG' "$REPORT"; then
    ok 'R2 the report records the HUNG verdict'
  else
    bad 'R2 the report does not record a HUNG verdict'
  fi
fi

if pgrep -f 'beater.mjs' > /dev/null 2>&1; then
  bad 'R2 a beater survives — the hang was reported but NOT contained under --on-hang terminate'
else
  ok 'R2 no beater survives (terminate policy honoured)'
fi

# ── R3: the subject DIES during the grace -> its own status, never CANNOT_LOOK ──────────────
# The requirement that is easy to miss: a config error must surface as the subject's own error,
# not as an infrastructure fault aimed at the wrong layer.
B="$(fresh_base r3)"
HANG_HEARTBEAT_BASE="$B" br_run_bounded 30 "$WORK/r3.log" node "$SUP" -- false
expect_exit 'R3 a subject that dies during the grace returns ITS OWN status' 1 "$?"

# ── R4: the subject is ALIVE and never beats -> grace expires -> 142 ───────────────────────
# The collection / worker-startup deadlock shape: the one that produces a 0-byte log.
B="$(fresh_base r4)"
HANG_HEARTBEAT_BASE="$B" br_run_bounded 30 "$WORK/r4.log" \
  node "$SUP" --on-hang terminate -- node -e 'setInterval(()=>{},1000000)'
expect_exit 'R4 alive-but-never-beats returns 142 when the grace expires' 142 "$?"

# ── R5: an unreadable base is COULD NOT LOOK (2), never the subject's status ───────────────
B="$WORK/r5-not-a-dir"
rm -rf "$B"
printf 'a FILE where a base should be\n' > "$B"
HANG_HEARTBEAT_BASE="$B" br_run_bounded 30 "$WORK/r5.log" \
  node "$SUP" -- node "$ROOT/node_modules/.bin/vitest" run --root packages/core \
  src/__tests__/license.test.ts
expect_exit 'R5 an unreadable base returns 2 (COULD NOT LOOK), not the subject status' 2 "$?"

# ── R6: A FOREIGN hung run must be IGNORED. THE SAFETY PROPERTY. ──────────────────────────
# Several sessions work this repo concurrently, so an unattributed supervisor would report on —
# and under terminate KILL — another session's healthy run.
B="$(fresh_base r6)"
FOREIGN=4194304   # above the macOS default pid maximum, so it cannot be in any process tree
mkdir -p "$B/$FOREIGN"
node -e '
  const fs = require("fs");
  const now = Number(process.hrtime.bigint() / 1000000n);
  fs.writeFileSync(process.argv[1], JSON.stringify({
    t_ms: now - 600000, wall: new Date().toISOString(),
    event: "onTestCaseReady", subject: "fullName=FOREIGN > someone elses stuck test",
    pid: 4194304,
    open_modules: [{ module: "/foreign/never.test.ts", opened_at_ms: now - 600000,
                     last_event: "onTestCaseReady", last_t_ms: now - 600000 }],
  }) + "\n");
' "$B/$FOREIGN/heartbeat.json"

# ⛔ POSITIVE CONTROL. If the rule would NOT call that beat HUNG, R6 passes for the wrong reason —
# the beat being benign rather than attribution working. This is the assertion that makes R6
# evidence instead of decoration.
CTRL="$(node -e '
  import(process.argv[1]).then((m) => process.stdout.write(m.check(process.argv[2], 3).verdict));
' "$RULE" "$B/$FOREIGN")"
if [ "$CTRL" = "HUNG" ]; then
  ok "R6 positive control: the rule DOES call the foreign beat HUNG"
else
  bad "R6 positive control FAILED (rule says $CTRL) — a pass below would prove nothing"
fi

HANG_HEARTBEAT_BASE="$B" br_run_bounded 60 "$WORK/r6.log" \
  node "$SUP" -- node "$ROOT/node_modules/.bin/vitest" run --root packages/core \
  src/__tests__/license.test.ts
expect_exit 'R6 a FOREIGN hung run is IGNORED; our healthy subject status passes through' 0 "$?"

if find "$B/_reports" -name 'hang-*.txt' -type f 2>/dev/null | /usr/bin/grep -q .; then
  bad 'R6 a report was written for a run this subject does not own'
else
  ok 'R6 no report written — nothing of ours was hung'
fi
if [ -f "$B/$FOREIGN/heartbeat.json" ]; then
  ok "R6 the foreign run's heartbeat is untouched"
else
  bad "R6 the foreign run's heartbeat was removed — the supervisor mutated what it does not own"
fi

# ── R7: the CLI's closed vocabulary refuses rather than defaulting ─────────────────────────
node "$SUP" > "$WORK/r7a.log" 2>&1;                       expect_exit 'R7 a missing -- separator refuses' 2 "$?"
node "$SUP" --on-hang bogus -- true > "$WORK/r7b.log" 2>&1; expect_exit 'R7 an unrecognised --on-hang refuses' 2 "$?"
node "$SUP" -- > "$WORK/r7c.log" 2>&1;                    expect_exit 'R7 an empty command refuses' 2 "$?"

# ── R8: D-8's ABSOLUTE CEILING — it must FIRE, and it must NOT be what fires on a hang ──────
#
# ⛔ AN UNATTACKED CONTROL IS DECORATION (CR-72). Every other row here asserts 142/2/own-status,
# so the ceiling could have been dead code and all 16 would still have passed. These two rows are
# the only evidence it exists at all.
#
# ⛔ AND THEY MUST BE READ AS A PAIR. R8a alone would prove "the ceiling fires", which a ceiling
# that fires on EVERYTHING also satisfies. R8b is what makes R8a mean something.

# R8a — a HEALTHY, PROGRESSING subject that outlives a small ceiling. This is the shape no silence
# bound can catch by construction: the run keeps emitting events the whole time, so the detector is
# asked on every poll and correctly never fires.
B="$(fresh_base r8a)"
# The ceiling (3s) is far above the beat interval (400ms) and far below the harness bound (60s),
# so the ONLY thing that can end this run is the ceiling. If the ceiling were dead code the
# harness bound would fire instead and report its own distinct code — never a silent pass.
HANG_HEARTBEAT_BASE="$B" HANG_ABSOLUTE_MAX_S=3 br_run_bounded 60 "$WORK/r8a.log" \
  node "$SUP" -- node "$PROGRESSOR"
expect_exit 'R8a a run that PROGRESSES FOREVER past the ceiling returns 143, NOT 142' 143 "$?"

R8AREP="$(find "$B/_reports" -name 'hang-*.txt' -type f 2>/dev/null | head -1)"
if [ -n "$R8AREP" ] && [ -s "$R8AREP" ]; then
  ok 'R8a the ceiling wrote a report'
else
  bad 'R8a the ceiling fired but named nothing'
fi
# ⛔ THE REPORT MUST DISCLAIM A DETECTION IN ITS OWN WORDS. A reader who finds a report and an
# unfamiliar exit code will otherwise conclude a hang was diagnosed, which is the collapse the
# separate exit code exists to prevent.
if [ -n "$R8AREP" ] && /usr/bin/grep -q 'THIS IS NOT A DETECTION' "$R8AREP"; then
  ok 'R8a the report says, in its own words, that nothing was DETECTED'
else
  bad 'R8a the report does not disclaim a detection — 143 reads as a hang'
fi

# R8b — THE ORDERING PROOF, and it deliberately PRESERVES THE REAL RELATIONSHIP between the two
# bounds (ceiling >> silence, as 750 >> 90 in production). A genuinely hanging subject must be
# adjudicated by the DETECTOR.
#
# ⚠️ WHY NOT A TINY CEILING HERE. With ceilingS < boundS the ceiling's deadline simply arrives
# first and it WOULD win — correcting an over-claim the first draft of the source comment made.
# Setting ceilingS below boundS would therefore prove the opposite of the intended property, so
# the row pins the configuration that actually ships.
B="$(fresh_base r8b)"
HANG_HEARTBEAT_BASE="$B" HANG_SILENCE_S=3 HANG_ABSOLUTE_MAX_S=60 br_run_bounded 45 "$WORK/r8b.log" \
  node "$SUP" --on-hang terminate -- node "$BEATER"
expect_exit 'R8b a HANG under a larger ceiling is adjudicated by the DETECTOR (142, not 143)' 142 "$?"

R8BREP="$(find "$B/_reports" -name 'hang-*.txt' -type f 2>/dev/null | head -1)"
if [ -n "$R8BREP" ] && ! /usr/bin/grep -q 'ABSOLUTE CEILING REACHED' "$R8BREP"; then
  ok 'R8b the hang report does NOT mention the ceiling — the detector alone decided'
else
  bad 'R8b the ceiling contaminated a hang verdict'
fi

printf '\nWORK DIR (kept for inspection, nothing deleted): %s\n' "$WORK"
printf '\n=== %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
[ "$PASS" -gt 0 ] || { printf 'ZERO assertions ran — proves nothing (M1)\n' >&2; exit 2; }
exit 0

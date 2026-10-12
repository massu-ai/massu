#!/usr/bin/env bash
# Attack scripts/lib/bounded-run.sh (CR-72). A containment primitive that cannot contain makes
# every harness built on it decoration, so this is run BEFORE anything depends on it.
#
# ⛔ THE TWO CASES THAT MATTER ARE 4 AND 5, and neither is obvious from reading the source:
#   4. the subject's WORKERS ARE GRANDCHILDREN — killing only the child orphans them and the
#      ceiling silently contains nothing;
#   5. THE HARNESS MUST SURVIVE — a primitive that signals its own process group kills the
#      thing that was supposed to report, and that failure looks like an ordinary crash
#      rather than like a defect in the primitive. This one is prior art, not invention: it
#      has been observed killing a real watchdog, and case 8 below is what exercises it.
# And since 2026-09-26, case 9: a subject that RETURNS BEFORE THE CEILING may not leave anything
# running. The ceiling was the only path that killed, so a hang supervisor exiting 142 in report
# mode left its vitest tree alive for 38 hours (and on Linux the ceiling itself contained nothing:
# `tail -r` is BSD-only).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# ⛔ source-path, NOT a relative source=. shellcheck resolves `source=` against the
# INVOCATION directory, not the script's own directory, so `source=../lib/x.sh` run from the
# repo root points OUTSIDE the repo and silently resolves to nothing — the directive looks
# like diligence and does nothing. SCRIPTDIR is the script's own directory.
# shellcheck source-path=SCRIPTDIR/../lib
. "$ROOT/scripts/lib/assert.sh"
. "$ROOT/scripts/lib/bounded-run.sh"

TMP="$(mktemp -d)"
# ⛔ THIS ATTACKER MUST CLEAN UP WHAT ITS FIXTURES START, INDEPENDENTLY OF THE LIBRARY UNDER TEST.
# Cases 4 and 9 start loops that never end on their own. When bounded-run.sh contains them this
# finds nothing; when a PLANT breaks containment (live-fire-bounded-run.sh does exactly that), the
# loop survives — and before 2026-09-26 it survived forever: ten such loops from 2026-09-24 were
# still appending to deleted markers two days later. Relying on the primitive under attack to
# clean up after its own failure is circular, so this reaps by the one thing every fixture
# process carries and nothing else does: this run's unique mktemp path on its command line.
reap_fixture_leftovers() {
  local pids
  pids="$(pgrep -f -- "$TMP" 2>/dev/null | tr '\n' ' ')"
  [ -n "${pids// /}" ] || return 0
  printf 'test-bounded-run: reaping fixture processes left behind: %s\n' "$pids" >&2
  # shellcheck disable=SC2086  # a word list of pids, by construction
  kill -TERM $pids 2>/dev/null
  sleep 1
  pids="$(pgrep -f -- "$TMP" 2>/dev/null | tr '\n' ' ')"
  # shellcheck disable=SC2086
  [ -z "${pids// /}" ] || kill -KILL $pids 2>/dev/null
  return 0
}
cleanup() {
  reap_fixture_leftovers
  rm -rf "$TMP"
}
trap cleanup EXIT

HARNESS_PID=$$

# ── 1/2: a subject that finishes reports ITS OWN status, never the ceiling ────────────────
rc=0
br_run_bounded 10 "$TMP/a.log" true || rc=$?
check_eq "a subject that exits 0 returns 0, not the ceiling" "0" "$rc"

rc=0
br_run_bounded 10 "$TMP/b.log" sh -c 'exit 7' || rc=$?
check_eq "a subject's own exit code survives (7)" "7" "$rc"

# ── 3: a hanging subject hits the ceiling, and gets a DISTINCT code ───────────────────────
# ⛔ EVERY HANG FIXTURE HERE IS BOUNDED BY THE LIFETIME OF $TMP, and that is G25, not tidiness.
# The live-fire plants defects that STOP br_kill_tree reaching these processes (plant 1 orphans
# the grandchild; plant 6 signals nothing), so under a plant they outlive this script. A fixture
# written `while :` then loops FOREVER on the machine that ran it — measured 2026-10-11: one was
# still running on the dev host after a live-fire. Looping only while $TMP exists keeps the hang
# real for the whole run and ends it within a second of the cleanup trap above removing $TMP.
rc=0
# shellcheck disable=SC2016  # $1 is the INNER sh positional, deliberately unexpanded here
br_run_bounded 2 "$TMP/c.log" sh -c 'while [ -d "$1" ]; do sleep 1; done' _ "$TMP" || rc=$?
check_eq "a hanging subject returns BR_EXIT_CEILING, distinguishable from any subject exit" \
  "$BR_EXIT_CEILING" "$rc"

# ── 4: GRANDCHILDREN are contained, not orphaned ──────────────────────────────────────────
# The subject spawns a child that spawns a grandchild; only the grandchild writes a marker.
# If containment stops at the direct child, the grandchild survives and keeps writing.
MARK="$TMP/grandchild.marker"
cat > "$TMP/gp.sh" <<'SH'
#!/usr/bin/env bash
# parent -> child -> grandchild; the grandchild touches its marker every second for as long as
# the marker's directory exists (see the G25 note at case 3 — never `while :`).
d="$(dirname "$1")"
sh -c 'sh -c "while [ -d '"$d"' ]; do date +%s >> '"$1"'; sleep 1; done"'
SH
chmod +x "$TMP/gp.sh"

rc=0
br_run_bounded 3 "$TMP/d.log" "$TMP/gp.sh" "$MARK" || rc=$?
check_eq "a subject whose work is in a GRANDCHILD still hits the ceiling" \
  "$BR_EXIT_CEILING" "$rc"

# Snapshot the marker, wait, and require it to STOP growing. A surviving grandchild keeps
# appending; a contained one cannot. This is the assertion that would have caught a
# child-only kill, and reading the source would not have.
before="$(wc -l < "$MARK" 2>/dev/null | tr -d ' ')"
[ -n "$before" ] || before=0
sleep 3
after="$(wc -l < "$MARK" 2>/dev/null | tr -d ' ')"
[ -n "$after" ] || after=0
check_eq "the GRANDCHILD is dead — its marker stopped growing after the kill" "$before" "$after"

# POSITIVE CONTROL for that assertion: the marker must have been written at ALL, or the
# comparison above passes for the wrong reason (0 == 0 proves nothing about containment).
check_cmd "positive control: the grandchild really did run and write its marker" \
  test "$before" -gt 0

# ── 5: THE HARNESS SURVIVED ───────────────────────────────────────────────────────────────
# If br_kill_tree had signalled its own process group, execution would never reach here —
# so reaching here is necessary but NOT sufficient. Assert our pid is unchanged and alive,
# which also catches a primitive that re-execs or forks away its reporting path.
check_eq "the harness pid is unchanged (br_kill_tree never signalled itself)" \
  "$HARNESS_PID" "$$"
check_cmd "the harness process is still alive and able to report" kill -0 "$HARNESS_PID"

# ── 6: refusals — a primitive that guesses its arguments is worse than none (R-011) ───────
rc=0
br_run_bounded 10 "$TMP/e.log" || rc=$?
check_eq "no command given is refused with exit 2" "2" "$rc"

rc=0
br_run_bounded "ten" "$TMP/f.log" true || rc=$?
check_eq "a non-integer ceiling is refused with exit 2" "2" "$rc"

# ── 7: br_tree_pids includes the root and never loops forever ─────────────────────────────
out="$(br_tree_pids "$$" | tr '\n' ' ')"
case " $out " in
  *" $$ "*) assert_ok "br_tree_pids includes the root pid itself" ;;
  *) assert_bad "br_tree_pids includes the root pid itself (got: $out)" ;;
esac

# ── 8: THE SELF-PROTECTION GUARD, EXERCISED DIRECTLY ─────────────────────────────────────
# ⛔ CASE 5 ABOVE DOES NOT EXERCISE THE GUARD, and the live-fire proved it: removing the
# never-signal-ourselves check left the suite fully GREEN. The reason is that
# `br_tree_pids "$subject"` never contains the harness, so the guard is unreachable from the
# br_run_bounded path. An unexercised guard is decoration (CR-72) — so call br_kill_tree with a
# root that IS our own ancestry and require that we live through it.
br_kill_tree "$$"
check_eq "br_kill_tree \$\$ did NOT kill the harness (the self-chain guard is live)" \
  "$HARNESS_PID" "$$"
check_cmd "the harness is still alive after being handed its own pid as the kill root" \
  kill -0 "$HARNESS_PID"

# ── 9: A SUBJECT THAT RETURNS ON ITS OWN MAY NOT LEAVE ANYTHING RUNNING ───────────────────
# The ceiling is not the only way out. A hang supervisor under `--on-hang report` exits 142 and
# leaves the hung run alive BY DESIGN; before 2026-09-26 this primitive trusted any subject that
# returned before the ceiling, so three live-fire runs left three vitest trees alive for 38 hours.
# Once the subject exits its descendants are ORPHANED, so a descendant walk cannot find them —
# only the subject's process group can. This subject starts a looping grandchild and exits 0.
MARK9="$TMP/leftover.marker"
cat > "$TMP/leaver.sh" <<'SH'
#!/usr/bin/env bash
# starts a grandchild that appends to its marker every second for as long as the marker's
# directory exists (the G25 note at case 3 — never `while :`), then exits 0 at once
d="$(dirname "$1")"
sh -c 'while [ -d '"$d"' ]; do date +%s >> '"$1"'; sleep 1; done' &
sleep 2
exit 0
SH
chmod +x "$TMP/leaver.sh"

rc=0
br_run_bounded 30 "$TMP/g.log" "$TMP/leaver.sh" "$MARK9" || rc=$?
check_eq "a subject that exits 0 leaving a descendant still reports ITS OWN status (0)" "0" "$rc"

before="$(wc -l < "$MARK9" 2>/dev/null | tr -d ' ')"
[ -n "$before" ] || before=0
sleep 3
after="$(wc -l < "$MARK9" 2>/dev/null | tr -d ' ')"
[ -n "$after" ] || after=0
check_eq "the descendant it left behind is DEAD — its marker stopped growing after the call returned" \
  "$before" "$after"
# POSITIVE CONTROL: the descendant must really have run, or 0 == 0 proves nothing.
check_cmd "positive control: the left-behind descendant really ran and wrote its marker" \
  test "$before" -gt 0

# ── 10: "the group is empty" and "I could not look at the group" are DIFFERENT VALUES ────────
# The reap is only as good as the question "is anything left?". If a missing or failing pgrep
# answered "nothing left", every reap would pass while reaping nothing — the blind-gate law at the
# bottom of this primitive. So br_group_members is three-valued, and each value is demanded here.
#
# ⛔ THE LIVE GROUP IS A DEDICATED ONE, NEVER OUR OWN. BSD pgrep (macOS) excludes itself AND ALL
# ITS ANCESTORS from every match, so `pgrep -g <our own group>` is EMPTY whenever every member of
# this script's group is an ancestor of pgrep — exactly the case when it runs as a br_run_bounded
# subject (the live-fire runs it that way, so it is the leader of a group holding only itself).
# Measured 2026-10-12: "a LIVE group (our own)" read 1 under the live-fire and 0 from a terminal.
# A group we create, holding one process that is not our ancestor, is live on every host.
had_monitor=0
case "$-" in *m*) had_monitor=1 ;; esac
set -m
# shellcheck disable=SC2016  # $1 is the INNER sh positional, deliberately unexpanded here
sh -c 'while [ -d "$1" ]; do sleep 1; done' _ "$TMP" </dev/null >/dev/null 2>&1 &
live_pg=$!
[ "$had_monitor" -eq 1 ] || set +m
st=0; br_group_members "$live_pg" >/dev/null || st=$?
check_eq "a LIVE group (one we started, not our ancestor) reads as 0 — members found" "0" "$st"
true & gone_pid=$!; wait "$gone_pid"
st=0; br_group_members "$gone_pid" >/dev/null || st=$?
check_eq "an EMPTY group (an exited process's pid) reads as 1 — nothing left" "1" "$st"
st=0
# shellcheck disable=SC2123  # deliberate: PATH is emptied INSIDE a subshell so pgrep is unavailable
( PATH=/nonexistent-bounded-run-path; br_group_members "$live_pg" >/dev/null ) || st=$?
check_eq "with pgrep UNAVAILABLE it reads as 2 — could not look, never 'empty'" "2" "$st"
{ kill -TERM -- "-$live_pg"; wait "$live_pg"; } 2>/dev/null || true

assert_summary "test-bounded-run.sh"

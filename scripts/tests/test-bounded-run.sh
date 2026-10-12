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
cleanup() {
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
# the grandchild; plant 4 signals nothing), so under a plant they outlive this script. A fixture
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

assert_summary "test-bounded-run.sh"

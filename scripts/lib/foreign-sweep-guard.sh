# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# foreign-sweep-guard.sh — "is a FOREIGN sweep running?", the one implementation.
#
# WHY THIS EXISTS. Tools that measure by MUTATING the real tree (the requires[] probe, the
# guard mutation tests) must refuse to run alongside another such tool: a foreign plant
# flips a verdict for reasons unrelated to the measurement, and per the blind-gate law the
# ambiguity resolves to a confident wrong answer. Several sessions routinely work this repo
# at once, so "someone else is sweeping" is a NORMAL state, not an edge case.
#
# ── THE PROPERTY ─────────────────────────────────────────────────────────────────────────
# "Could another agent mutate this tree underneath me?" Everything below is that question
# and nothing else. Three relationships are NOT competitors, and each cost a CI run to learn:
#
#   SELF        me. Obviously.
#   ANCESTOR    the thing that INVOKED this measurement. It is blocked waiting on me.
#   DESCENDANT  my own forks. A bash `$(cmd)` subshell INHERITS the invoking script's argv,
#               so when that script's own path matches the pattern, my own command
#               substitution appears in the process table as a sweep.
#
# A SIBLING is deliberately still FOREIGN: another guard-defeat spawned by the same sweep
# really is planting into this same real tree — the sweep's guard-defeat phase is serial for
# exactly that reason (massu-gate-anti-vacuity.sh:769). Excluding siblings would widen this
# to "never refuse", which is the brick direction (CR-72) and would re-open the 2026-07-27
# concurrent-sweep contamination.
#
# ── DEFECT 1 (CI run 30428800020, fixed 2026-07-29): SELF-DETECTION VIA ANCESTOR ──────────
# Three hand-written `pgrep -f` guards had grown up across two files with three different
# patterns, and the strictest of them asked only "is ANY process matching the pattern alive?"
# The anti-vacuity sweep DISCOVERS every tracked scripts/tests/*.sh and runs it as a child,
# so when the sweep ran that test, the test's pgrep matched THE SWEEP THAT INVOKED IT:
#
#     FATAL: a sweep or probe is running; this test plants into the repo.
#       162995 bash        <- massu-gate-anti-vacuity.sh, its grandparent
#       3000671 python3    <- _run_guard_defeat.py, its parent
#
# ── DEFECT 2 (CI run 30493858521, fixed here): SELF-DETECTION VIA DESCENDANT ──────────────
# The fix for defect 1 excluded self + ancestors. It did not exclude the guard's OWN FORKS,
# and the evidence it printed says so — two "foreign" pids with EMPTY commands, because they
# had already exited by the time it asked what they were:
#
#     foreign pid 3002465:                              <- ps found nothing: already dead
#     foreign pid 3002497:
#     my ancestry (excluded): 3002464 3002385 3002384 3002383 163047
#                            ^^^^^^^ 3002465 is 3002464 + 1: my own next fork
#
# 3002464 was a script whose path matched the pattern. Its very first act was
# `foreign="$(foreign_sweep_pids)"` — bash forked a subshell, that subshell inherited argv
# `bash .../parent-massu-gate-anti-vacuity.sh`, and the guard reported its own fork as a
# competitor. THE SAME LAW BROKEN TWICE (G28/CR-91): "a process matching the pattern exists"
# is a CORRELATE. The property is "a process OUTSIDE MY PROCESS TREE could mutate my tree."
# This is not hypothetical for the real caller either: scripts/ops/probe-gate-requires.sh is
# itself named in the pattern, so every one of ITS command substitutions was a candidate.
#
# ── WHY NEITHER DEFECT COULD BE REPRODUCED LOCALLY (G9) ───────────────────────────────────
# `pgrep` is not the same tool on the two execution paths, and the difference is documented:
#
#   macOS/BSD  `man pgrep`: "the current pgrep or pkill process and all of its ANCESTORS are
#              excluded" (unless -a). So on macOS the kernel hid both defects for free: the
#              sweep, this script, and the forking subshell are all pgrep's own ancestors.
#   Linux      procps pgrep excludes only ITSELF. Ancestors and sibling forks are visible.
#
# Defect 1's fix was proven "7/7 locally" and was structurally incapable of exercising the
# CI cause. So this file does NOT use pgrep. It reads the process table itself, which makes
# behaviour IDENTICAL on both platforms and the local proof actually worth something.
#
# ── HOW: ONE SNAPSHOT, THEN EVERY QUESTION ANSWERED FROM IT ───────────────────────────────
# The previous implementation forked ~5 `ps` calls plus a `pgrep` while classifying, so the
# process table it was reasoning about changed underneath it — which is why it printed pids
# it could no longer describe. `_sweep_report` takes ONE `ps -Ao pid=,ppid=,command=` and
# derives matching, ancestry and descendancy from that single consistent view. A process
# that exits mid-classification can no longer flip a verdict, and every refusal can name
# what it saw (M1).
#
# Bash 3.2 compatible (macOS /bin/bash): no mapfile, no associative arrays, no readarray.
#
# Usage:
#   . "$REPO_ROOT/scripts/lib/foreign-sweep-guard.sh"
#   assert_no_foreign_sweep "this test plants into the repo" || exit 2
#
# Exit contract for assert_no_foreign_sweep:
#   0  exclusive — no foreign sweep
#   1  a foreign sweep IS running (evidence printed, each pid named with its command)
#   2  COULD NOT DETERMINE (no python3, unreadable process table, empty denominator).
#      Fail closed: "I could not look" must never produce the value "clean".
# ─────────────────────────────────────────────────────────────────────────────────────────

# The ONE pattern. Previously three divergent copies: one omitted probe-gate-requires.sh,
# one excluded $$ and one excluded nothing at all.
FOREIGN_SWEEP_PATTERN='massu-gate-anti-vacuity\.sh|_run_guard_defeat\.py|probe-gate-requires\.sh'

# ONE read of the process table, classified in one pass. Prints a small parseable report:
#
#   FSG-SCANNED <n>                 the DENOMINATOR (M1). 0 or 1 is an ERROR, never a pass.
#   FSG-MINE <pid> <pid> ...        self + ancestors, leaf-ward first.
#   FSG-FOREIGN <pid>\t<command>    one line per live foreign sweep.
#   FSG-ERROR <reason>              could not look — callers MUST fail closed.
#
# $1 = the pid to reason as (default $$).
#
# The pattern and the pid travel in the ENVIRONMENT, never in argv: `python3 -` keeps the
# pattern out of this process's own command line, so the classifier cannot match itself. It
# would be excluded as a descendant anyway; belt and braces, because a self-match here is
# precisely the bug being fixed.
_sweep_report() {
  MASSU_FSG_PATTERN="$FOREIGN_SWEEP_PATTERN" MASSU_FSG_SELF="${1:-$$}" python3 - <<'PY'
import os, re, subprocess, sys

pat_src = os.environ.get("MASSU_FSG_PATTERN", "")
try:
    self_pid = int(os.environ.get("MASSU_FSG_SELF", "0"))
except ValueError:
    self_pid = 0
if not pat_src or self_pid <= 0:
    print("FSG-ERROR pattern or self pid not supplied to the classifier")
    sys.exit(3)
try:
    pat = re.compile(pat_src)
except re.error as exc:
    print("FSG-ERROR pattern does not compile: %s" % exc)
    sys.exit(3)

# THE one read. `-Ao pid=,ppid=,command=` is accepted by both BSD/macOS ps and procps.
try:
    proc = subprocess.run(["ps", "-Ao", "pid=,ppid=,command="],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
except OSError as exc:
    print("FSG-ERROR could not exec ps: %s" % exc)
    sys.exit(3)
if proc.returncode != 0:
    err = proc.stderr.decode("utf-8", "replace").strip().replace("\n", " ")[:200]
    print("FSG-ERROR ps exited %d: %s" % (proc.returncode, err))
    sys.exit(3)

ppid = {}
cmd = {}
for line in proc.stdout.decode("utf-8", "replace").splitlines():
    fields = line.split(None, 2)
    if len(fields) < 3:
        continue
    try:
        pid, parent = int(fields[0]), int(fields[1])
    except ValueError:
        continue
    ppid[pid] = parent
    cmd[pid] = fields[2]

# M1/M2 — an unparseable or near-empty table is an ERROR. "Scanned 0, found 0" is the
# blind-gate value: it is what a broken probe and an exclusive tree both return.
if len(ppid) < 2:
    print("FSG-ERROR process table parsed to %d row(s) — refusing to report exclusivity"
          % len(ppid))
    sys.exit(3)

def chain(pid, limit=256):
    """pid + every ancestor, from the SNAPSHOT. Bounded: a cycle must not hang."""
    out = []
    cur = pid
    while cur and cur > 1 and len(out) < limit:
        out.append(cur)
        nxt = ppid.get(cur)
        if nxt is None or nxt == cur or nxt in out:
            break
        cur = nxt
    return out

mine_chain = chain(self_pid)
mine = set(mine_chain)

foreign = []
for pid in sorted(cmd):
    if not pat.search(cmd[pid]):
        continue
    if pid in mine:
        continue                      # SELF, or the ancestor chain that invoked me
    if self_pid in chain(pid):
        continue                      # MY OWN DESCENDANT — a fork inherits my argv
    foreign.append(pid)

print("FSG-SCANNED %d" % len(ppid))
print("FSG-MINE " + " ".join(str(p) for p in mine_chain))
for pid in foreign:
    print("FSG-FOREIGN %d\t%s" % (pid, cmd[pid][:200]))
PY
}

# Self + every ancestor up to init, space-delimited and space-padded so a substring test
# cannot match a pid prefix (12 must not match 123). A projection of _sweep_report, not a
# second ancestry implementation — one walk, one place it can be wrong.
_sweep_ancestor_pids() {
  local rep mine
  rep="$(_sweep_report "${1:-$$}")"
  case "$rep" in
    *"FSG-ERROR"*|'') printf ' '; return 1 ;;
  esac
  mine="$(printf '%s\n' "$rep" | sed -n 's/^FSG-MINE //p' | head -1)"
  printf ' %s ' "$mine"
}

# Pids of sweeps/probes that are neither this process, nor an ancestor, nor a descendant.
# Prints them space-separated; empty output with status 0 means exclusive access.
# Returns 1 without printing when exclusivity COULD NOT BE DETERMINED — callers that treat
# empty-output as clean must therefore also check the status. assert_no_foreign_sweep does.
foreign_sweep_pids() {
  local rep
  rep="$(_sweep_report "$$")"
  case "$rep" in
    *"FSG-ERROR"*|'') return 1 ;;
  esac
  printf '%s' "$(printf '%s\n' "$rep" | sed -n 's/^FSG-FOREIGN \([0-9]*\).*/\1 /p' | tr -d '\n')"
}

# Refuse if a foreign sweep is running. $1 = why this caller needs exclusivity.
assert_no_foreign_sweep() {
  local why="${1:-this tool mutates the real tree}"
  local rep scanned line pid

  rep="$(_sweep_report "$$")"

  # M2 — FAIL CLOSED, and distinguish the two failures. `python3` absent, `ps` unreadable
  # or an empty report all land here and return 2; none of them may return 0.
  case "$rep" in
    *"FSG-ERROR"*)
      echo "FATAL: cannot determine whether a foreign sweep is running; ${why}." >&2
      printf '%s\n' "$rep" | sed -n 's/^FSG-ERROR/       FSG-ERROR/p' >&2
      echo "       Refusing rather than assuming an exclusive tree." >&2
      return 2 ;;
  esac

  # M1 — ASSERT the denominator. A report with no FSG-SCANNED line means the classifier did
  # not run at all (no python3 on PATH being the likely cause), which must not read as clean.
  scanned="$(printf '%s\n' "$rep" | sed -n 's/^FSG-SCANNED //p' | head -1)"
  case "$scanned" in
    ''|*[!0-9]*)
      echo "FATAL: the sweep classifier produced no denominator; ${why}." >&2
      echo "       Is python3 on PATH? A probe that could not look is an ERROR, not a" >&2
      echo "       clean tree — reporting 'no foreign sweep' here would be a blind gate." >&2
      return 2 ;;
  esac
  if [ "$scanned" -lt 2 ]; then
    echo "FATAL: scanned only $scanned process(es); ${why}." >&2
    echo "       A process table this small cannot be real — refusing to infer exclusivity." >&2
    return 2
  fi

  case "$rep" in
    *"FSG-FOREIGN "*) : ;;
    *) return 0 ;;
  esac

  echo "FATAL: another anti-vacuity sweep or probe is running against this tree; ${why}." >&2
  # M1 — name the evidence. A refusal that does not say WHAT it saw is unactionable, and the
  # command comes from the SAME snapshot that classified it, so it can no longer come back
  # empty because the process exited in between (that empty line was defect 2's signature).
  printf '%s\n' "$rep" | sed -n 's/^FSG-FOREIGN //p' | while IFS=$'\t' read -r pid line; do
    echo "       foreign pid $pid: $line" >&2
  done
  echo "       my process tree (excluded):$(printf '%s\n' "$rep" | sed -n 's/^FSG-MINE / /p' | head -1)" >&2
  echo "       processes scanned: $scanned" >&2
  echo >&2
  echo "       A differential measurement needs exclusive access: guard gates plant into" >&2
  echo "       the REAL tree, so a foreign plant flips a verdict for reasons unrelated to" >&2
  echo "       this measurement. Refusing rather than producing a confident wrong answer." >&2
  echo "       Wait for the other sweep to finish, then re-run. This tool is idempotent." >&2
  return 1
}

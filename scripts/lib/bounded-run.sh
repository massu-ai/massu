# shellcheck shell=bash
# bounded-run — run a subject process under a HARD external ceiling, and report WHICH
# outcome happened rather than collapsing them.
#
# ⛔ WHY THIS EXISTS, AND WHY IT IS NOT THE DETECTOR.
# A harness that attacks a hang detector must plant a test that HANGS FOREVER. If the
# detector is absent or broken — precisely the state the harness exists to detect — that
# fixture hangs the HARNESS. This is G25's law one layer out: a test payload must be inert
# under every plant, and here the "plant" is "the detector does not work".
#
# So this ceiling is CONTAINMENT FOR THE HARNESS, never a hang decision. It must be set far
# above anything the detector would allow, so that reaching it means the detector FAILED —
# and that outcome is returned as its OWN code, distinct from every exit the subject could
# produce on its own. Collapsing "the harness had to kill it" into "it exited non-zero"
# would make a dead detector look like a working one (THE BLIND-GATE LAW).
#
# ⛔ `timeout(1)` DOES NOT EXIST ON THIS HOST. Hence the poll loop.
#
# ⛔ AND THIS FILE RUNS ON TWO USERLANDS — the BSD one on the dev host and GNU on the CI
# runner. Measured 2026-10-11: the kill list was reversed with `tail -r`, which GNU tail does
# not have. On Linux it printed "invalid option -- 'r'", the kill list came out EMPTY, nothing
# was signalled, and the reap below was an unbounded `wait` on a subject that was never killed
# — so the containment primitive HUNG the CI job it existed to protect (78+ minutes, twice),
# while passing 6/0 on macOS. Two consequences, both enforced below: only POSIX-portable
# tools, and NO step in this file may block without its own bound. A containment primitive
# that can wait forever is the defect it exists to prevent.
#
# ⛔ AND WORKERS ARE GRANDCHILDREN, NOT CHILDREN. vitest's `forks` pool and pytest's xdist
# both put the real work one level below the process you launched, so killing only the child
# orphans the workers and the ceiling silently fails to contain anything.
#
# ⛔ AND NEVER SIGNAL YOURSELF. A primitive that signals its own process group ends the
# watchdog that was supposed to report, and that failure presents as an ordinary crash rather
# than as a defect here — so it is the one trap this file's own attacker must exercise
# directly. Both of these are prior art rather than invention; the provenance is recorded in
# the owning plan, which is not part of this distribution.

# Distinct sentinel. 124 is what timeout(1) uses for "deadline exceeded"; we return it for
# "the HARNESS had to intervene", which is a strictly stronger statement.
BR_EXIT_CEILING=124

# Seconds to wait for a killed tree to actually die before declaring containment FAILED.
# Bounded on purpose: see the header — an unbounded reap is how this file once hung CI.
BR_REAP_GRACE=10

# br_reverse_lines — print stdin's lines last-first. POSIX awk, because `tail -r` is BSD-only
# and `tac` is GNU-only, and this file must behave identically on both (see header).
br_reverse_lines() {
  awk '{ line[NR] = $0 } END { for (i = NR; i >= 1; i--) print line[i] }'
}

# br_is_alive <pid> — true while <pid> exists and is NOT a zombie.
# ⛔ `kill -0` alone is wrong here: it SUCCEEDS on an unreaped zombie, so a killed-but-unreaped
# child would read as alive forever. ps stat 'Z' is a corpse, not a running subject.
br_is_alive() {
  local stat
  stat="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -n "$stat" ] || return 1
  case "$stat" in
    Z*) return 1 ;;
  esac
  return 0
}

# br_tree_pids <root> — every descendant of <root>, inclusive, newest-last.
# Depth-bounded so a pid-reuse cycle cannot spin forever.
br_tree_pids() {
  local root="${1:?br_tree_pids: root pid required}"
  local seen="$root"
  local frontier="$root"
  local depth=0
  local next p c
  while [ -n "$frontier" ] && [ "$depth" -lt 12 ]; do
    next=""
    for p in $frontier; do
      # pgrep -P lists DIRECT children; the loop supplies the depth.
      for c in $(pgrep -P "$p" 2>/dev/null); do
        case " $seen " in
          *" $c "*) ;;                       # already collected
          *) seen="$seen $c"; next="$next $c" ;;
        esac
      done
    done
    frontier="$next"
    depth=$((depth + 1))
  done
  # Emit one pid per line WITHOUT relying on unquoted word splitting.
  printf '%s' "$seen" | tr ' ' '\n' | /usr/bin/grep -v '^$'
}

# br_kill_tree <root> — TERM then KILL every descendant, deepest first.
# ⛔ REFUSES to signal itself or any of its own ancestors. Without that check this function
# ends the harness, and a harness that killed itself reports nothing at all.
br_kill_tree() {
  local root="${1:?br_kill_tree: root pid required}"
  local self_chain="" p ppid ordered

  # Walk our OWN ancestry so we can never signal it.
  p=$$
  while [ "$p" -gt 1 ]; do
    self_chain="$self_chain $p"
    ppid="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    [ -n "$ppid" ] || break
    [ "$ppid" = "$p" ] && break
    p="$ppid"
  done

  # Deepest first: br_tree_pids emits parents before children, so reverse it.
  ordered="$(br_tree_pids "$root" | tr ' ' '\n' | /usr/bin/grep -v '^$' | br_reverse_lines | tr '\n' ' ')"

  # ⛔ FAIL CLOSED. br_tree_pids always includes the root, so an EMPTY kill list means the
  # pipeline above broke (it did, on GNU, for a month) — never "nothing to kill". Saying so
  # loudly is the difference between a diagnosable failure and a silent no-op kill.
  case "$ordered" in
    *[0-9]*) ;;
    *)
      printf 'br_kill_tree: kill list for root %s is EMPTY — the tree walk failed; nothing was signalled\n' "$root" >&2
      return 2
      ;;
  esac

  local sig
  for sig in TERM KILL; do
    for p in $ordered; do
      case " $self_chain " in
        *" $p "*) continue ;;                # never ourselves or an ancestor
      esac
      kill -"$sig" "$p" 2>/dev/null || true
    done
  done
  return 0
}

# br_run_bounded <ceiling_s> <logfile> <cmd> [args...]
#
# Runs <cmd> with stdout+stderr to <logfile>. Returns the subject's own exit status if it
# finished on its own, or $BR_EXIT_CEILING if the harness had to kill it.
#
# The caller MUST branch on $BR_EXIT_CEILING explicitly. Treating it as "just another
# failure" is the collapse this function exists to prevent.
br_run_bounded() {
  local ceiling="${1:?br_run_bounded: ceiling seconds required}"
  local log="${2:?br_run_bounded: logfile required}"
  shift 2
  if [ "$#" -lt 1 ]; then
    printf 'br_run_bounded: no command given\n' >&2
    return 2
  fi
  case "$ceiling" in
    ''|*[!0-9]*) printf 'br_run_bounded: ceiling must be an integer, got: %s\n' "$ceiling" >&2; return 2 ;;
  esac

  : > "$log" || return 2

  "$@" >"$log" 2>&1 &
  local pid=$!
  local waited=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$ceiling" ]; then
      br_kill_tree "$pid" || true   # its failure is judged by the OUTCOME below, not trusted
      # ⛔ BOUNDED reap. Only `wait` once the subject is provably dead; an unbounded `wait` on
      # a subject the kill did not reach is exactly how this function once hung CI.
      local grace=0
      while br_is_alive "$pid" && [ "$grace" -lt "$BR_REAP_GRACE" ]; do
        sleep 1
        grace=$((grace + 1))
      done
      if br_is_alive "$pid"; then
        # Containment FAILED. That is an infrastructure fault, not a ceiling verdict: returning
        # BR_EXIT_CEILING here would claim the harness contained something it did not.
        printf 'br_run_bounded: subject %s SURVIVED the kill for %ss — containment FAILED\n' \
          "$pid" "$BR_REAP_GRACE" >&2
        return 2
      fi
      # Reap so the shell does not report it later as an unrelated job.
      wait "$pid" 2>/dev/null || true
      return "$BR_EXIT_CEILING"
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Subject finished on its own — report ITS status, not the loop's.
  local rc=0
  wait "$pid" || rc=$?
  return "$rc"
}

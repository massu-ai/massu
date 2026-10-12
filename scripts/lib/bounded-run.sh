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
# ⛔ AND WORKERS ARE GRANDCHILDREN, NOT CHILDREN. vitest's `forks` pool and pytest's xdist
# both put the real work one level below the process you launched, so killing only the child
# orphans the workers and the ceiling silently fails to contain anything.
#
# ⛔ AND NEVER SIGNAL YOURSELF. A primitive that signals its own process group ends the
# watchdog that was supposed to report, and that failure presents as an ordinary crash rather
# than as a defect here — so it is the one trap this file's own attacker must exercise
# directly. Both of these are prior art rather than invention; the provenance is recorded in
# the owning plan, which is not part of this distribution.
#
# ⛔ AND THIS FILE RUNS ON TWO USERLANDS — the BSD one on the dev host and GNU on the CI
# runner. Measured 2026-10-11: the kill list was reversed with `tail -r`, which GNU tail does
# not have. On Linux it printed "invalid option -- 'r'", the kill list came out EMPTY, nothing
# was signalled, and the reap below was an unbounded `wait` on a subject that was never killed
# — so the containment primitive HUNG the CI job it existed to protect (78+ minutes, twice),
# while passing 6/0 on macOS. Two consequences, both enforced below: only POSIX-portable
# tools, and NO step in this file may block without its own bound. A containment primitive
# that can wait forever is the defect it exists to prevent.

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

# br_await_death <pid> — wait at most BR_REAP_GRACE seconds for <pid> to stop being alive.
# 0 = dead (safe to `wait`), 1 = still alive. The ONLY gate in front of every `wait` on a
# signalled subject: an unbounded `wait` on a subject the kill did not reach is how this file
# once hung CI (see header).
br_await_death() {
  local grace=0
  while br_is_alive "$1" && [ "$grace" -lt "$BR_REAP_GRACE" ]; do
    sleep 1
    grace=$((grace + 1))
  done
  ! br_is_alive "$1"
}

# ⛔ AND NOTHING THE SUBJECT STARTED MAY OUTLIVE THE CALL — on EITHER return path.
#
# Measured 2026-09-26: this primitive only ever killed on the CEILING path. A subject that
# returned on its own before the ceiling was trusted to have taken its descendants with it, and
# a hang supervisor running under `--on-hang report` does exactly the opposite BY DESIGN: it
# reports, exits 142, and leaves the hung run alive. Three runs of live-fire-hang-watch.sh on
# 2026-09-24 left three vitest trees (npm exec -> vitest -> forks worker) alive 38 hours later,
# 540 MiB resident, re-parented to launchd; the three other REPORTED cases each lived ~10 more
# minutes until vitest's own 600000 ms timeouts fired. After the subject exits its tree is
# ORPHANED, so a descendant walk from its pid (br_tree_pids) finds nothing: the tree is gone
# from under the root it would be walked from.
#
# So every subject runs as the leader of its OWN PROCESS GROUP, and the whole group is reaped
# (TERM, then KILL after a grace) whenever the call returns. This is BORROWED, not invented:
# coreutils timeout(1) puts the command in its own group and signals the group, because "all
# subprocesses can be killed" that way; POSIX kill(2) with a negative pid signals every process
# whose process group ID equals |pid|. What timeout(1) does NOT do — and what this adds — is reap
# the group when the command exits ON ITS OWN, which is precisely the leak above.
#
# Why signalling `-pgid` cannot hit a stranger: POSIX.1-2024 §4.17 — "if there exists a process
# group whose process group ID is equal to that process ID, the process ID shall not be reused by
# the system until the process group lifetime ends". While any member survives, the number still
# names our group. An EMPTY group is never signalled (pgrep -g decides first).
#
# The group is created with bash job control (`set -m` around the launch — this host has no
# setsid(1)), and the prior monitor state is restored immediately. The subject's stdin is
# /dev/null: without job control a background job already gets that, but with it the job
# inherits the caller's stdin — which, in a `while read … done <<EOF` case loop, is the case
# table itself, and a subject that read stdin would eat the harness's remaining rows.
BR_EXIT_UNREAPED=125          # the group survived SIGKILL: containment FAILED, never a pass
BR_KILL_GRACE_S="${BR_KILL_GRACE_S:-5}"

# br_reap_group <pgid> — TERM, then KILL after BR_KILL_GRACE_S, every process still in the
# group. Silent and 0 when the group is already empty; says what it reaped otherwise; returns
# BR_EXIT_UNREAPED if anything survives SIGKILL. REFUSES this harness's own group (exit 2).
br_reap_group() {
  local pg="${1:?br_reap_group: process group id required}"
  case "$pg" in
    ''|*[!0-9]*) printf 'br_reap_group: not a process group id: %s\n' "$pg" >&2; return 2 ;;
  esac
  if [ "$pg" -le 1 ]; then
    printf 'br_reap_group: refusing process group %s\n' "$pg" >&2
    return 2
  fi
  local own_pg
  own_pg="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')"
  if [ -z "$own_pg" ] || [ "$pg" = "$own_pg" ]; then
    # Signalling our own group ends the harness that was supposed to report (the same law as
    # br_kill_tree's self-chain guard below). An unreadable own-group is refused too: "could
    # not tell" must never resolve to "go ahead".
    printf 'br_reap_group: REFUSING group %s — it is this harness'"'"'s own group, or that could not be read (own=%s)\n' \
      "$pg" "${own_pg:-unreadable}" >&2
    return 2
  fi

  local members n waited=0 st
  members="$(br_group_members "$pg")" && st=0 || st=$?
  case "$st" in
    1) return 0 ;;                             # empty: nothing was left behind
    0) ;;
    *) printf 'bounded-run: COULD NOT LOOK at group %s (pgrep failed) — containment unverified\n' "$pg" >&2
       return "$BR_EXIT_UNREAPED" ;;
  esac
  n="$(printf '%s' "$members" | wc -w | tr -d ' ')"
  printf 'bounded-run: reaping %s process(es) the subject left in its group %s: %s\n' \
    "$n" "$pg" "$members" >&2

  # The braces keep bash's job-control notice ("Terminated: 15 …") for the group leader out of
  # the caller's output; the outcome is asserted below, not inferred from that line.
  {
    kill -TERM -- "-$pg" 2>/dev/null || true
    while [ "$waited" -lt "$BR_KILL_GRACE_S" ] && br_group_members "$pg" >/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    if br_group_members "$pg" >/dev/null; then
      kill -KILL -- "-$pg" 2>/dev/null || true
      sleep 1
    fi
  } 2>/dev/null

  members="$(br_group_members "$pg")" && st=0 || st=$?
  case "$st" in
    1) return 0 ;;
    0) printf 'bounded-run: CONTAINMENT FAILED — group %s survived SIGKILL: %s\n' "$pg" "$members" >&2 ;;
    *) printf 'bounded-run: COULD NOT LOOK at group %s after the reap — containment unverified\n' "$pg" >&2 ;;
  esac
  return "$BR_EXIT_UNREAPED"
}

# br_group_members <pgid> — the group's live members on one line. THREE-VALUED, because "no
# members" and "could not look" must never share a value (the blind-gate law): 0 members listed,
# 1 the group is empty, 2 pgrep is missing or failed.
br_group_members() {
  local out st
  command -v pgrep >/dev/null 2>&1 || return 2
  out="$(pgrep -g "$1" 2>/dev/null)" && st=0 || st=$?
  case "$st" in
    0) printf '%s\n' "$out" | tr '\n' ' '; return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
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
  #
  # ⛔ PORTABLY. This was `tail -r`, which is BSD-only: GNU coreutils has no `-r` ("tail: invalid
  # option -- 'r'", measured in node:22 / Debian on 2026-09-26 and again on 2026-10-11). On the
  # Linux CI runner the pipeline produced NOTHING, br_kill_tree signalled nothing, and the
  # unbounded `wait` behind it hung the Type Check job (6h0m17s in run 36096051038; 78+ min in
  # runs 38206542983 and 38212570485). br_reverse_lines is POSIX awk, identical on both hosts.
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
# Runs <cmd> with stdout+stderr to <logfile> and stdin from /dev/null, as the leader of its own
# process group. Returns the subject's own exit status if it finished on its own, or
# $BR_EXIT_CEILING if the harness had to kill it — and on BOTH paths reaps whatever the subject
# left in its group, so nothing it started outlives the call. If that reap fails, returns
# $BR_EXIT_UNREAPED instead of a status that would read as the subject's own.
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

  # Own process group: `set -m` for the launch only, prior monitor state restored.
  local had_monitor=0
  case "$-" in *m*) had_monitor=1 ;; esac
  set -m
  "$@" </dev/null >"$log" 2>&1 &
  local pid=$!
  [ "$had_monitor" -eq 1 ] || set +m
  local waited=0

  # ASSERT the group exists as designed rather than trusting `set -m`. If the subject is alive
  # and NOT its own group leader, a group reap would target the wrong group — possibly ours — so
  # this refuses, contains by the descendant walk, and says so (exit 2: could not contain as
  # designed). An already-exited subject reads as empty here; job control guarantees pgid == pid.
  local seen_pg
  seen_pg="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$seen_pg" ] && [ "$seen_pg" != "$pid" ]; then
    printf 'br_run_bounded: job control did not give the subject its own process group (pid %s, pgid %s) — refusing to run uncontained\n' \
      "$pid" "$seen_pg" >&2
    br_kill_tree "$pid" || true
    if br_await_death "$pid"; then { wait "$pid"; } 2>/dev/null; fi
    return 2
  fi

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$ceiling" ]; then
      # The descendant walk first (it also reaches a descendant that moved to another group
      # while its ancestors are alive), then the group (it reaches what the walk cannot) — and
      # only THEN wait, and only once the subject is PROVABLY dead. The group includes the
      # subject itself, so the reap does not depend on the walk having worked; and neither is
      # trusted: their failures are judged by the OUTCOME (br_await_death), because waiting on a
      # subject neither reached would block forever on exactly the failure the ceiling exists for.
      br_kill_tree "$pid" || true
      local reap_rc=0
      br_reap_group "$pid" || reap_rc=$?
      if ! br_await_death "$pid"; then
        # Containment FAILED. That is an infrastructure fault, not a ceiling verdict: returning
        # BR_EXIT_CEILING here would claim the harness contained something it did not.
        printf 'br_run_bounded: subject %s SURVIVED the kill for %ss — containment FAILED\n' \
          "$pid" "$BR_REAP_GRACE" >&2
        return "$BR_EXIT_UNREAPED"
      fi
      { wait "$pid"; } 2>/dev/null || true
      [ "$reap_rc" -eq 0 ] || return "$BR_EXIT_UNREAPED"
      return "$BR_EXIT_CEILING"
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Subject finished on its own — report ITS status, not the loop's. Then reap what it left:
  # an orphaned descendant is invisible to the walk, and still in the group.
  local rc=0
  wait "$pid" || rc=$?
  br_reap_group "$pid" || return "$BR_EXIT_UNREAPED"
  return "$rc"
}

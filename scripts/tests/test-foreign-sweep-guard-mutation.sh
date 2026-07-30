#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# test-foreign-sweep-guard-mutation.sh — CR-72 proof for scripts/lib/foreign-sweep-guard.sh.
#
# The helper must be right in FOUR directions, and they are easy to confuse. Three of them
# are "not a competitor" and only the first is a refusal:
#
#   FOREIGN sweep alive    -> REFUSE    (the property: someone else can mutate the tree)
#   my own ANCESTOR        -> PROCEED   (it invoked me and is blocked waiting on me)
#   my own DESCENDANT      -> PROCEED   (my forks inherit my argv, so they match the pattern)
#   nothing at all         -> PROCEED   (the NEGATIVE CONTROL; without it a brick passes)
#
# Each PROCEED case is a shipped defect, not a hypothetical:
#
#   ANCESTOR    CI 30428800020. The old check asked "is ANY sweep alive?", the anti-vacuity
#               sweep runs this test as a CHILD, and it FATAL'd on its own grandparent every
#               run (`proven can-fail: 412, failures: 1`).
#   DESCENDANT  CI 30493858521. The fix for the above excluded self + ancestors but not the
#               guard's OWN FORKS. `foreign="$(foreign_sweep_pids)"` forks a subshell that
#               inherits the invoking script's argv; when that script's path matches the
#               pattern — as scripts/ops/probe-gate-requires.sh does — the guard reported its
#               own command substitution as a competitor. Its evidence named two pids with
#               EMPTY commands, already dead, one of them literally its own pid + 1.
#
# A SIBLING stays FOREIGN by design and is NOT tested as a PROCEED case: another guard-defeat
# from the same sweep really is planting into this same real tree.
#
# WHY EACH CASE IS NON-VACUOUS. The cases check each other, so no single broken predicate
# passes them all: a helper that always returns "foreign" fails the three PROCEED cases; one
# that always returns "clean" fails FOREIGN->REFUSE. Every fixture additionally carries a
# positive control proving the process it created is real and visible — measured 2026-07-29,
# `pgrep`-based controls made this suite pass while the CI cause was untouched.
#
# PLATFORM (G9 — the two execution paths differ, and this suite was VACUOUS because of it).
# `man pgrep` on macOS/BSD: "the current pgrep or pkill process and all of its ANCESTORS are
# excluded". Linux procps excludes only itself. So both defects above were invisible to any
# pgrep-based test on macOS while being deterministic on the Linux CI runner — this file
# reported 7/7 locally against a live CI failure. The helper no longer uses pgrep and neither
# does this test: both read the process table, so a local PASS now means something.
#
# PAYLOAD SAFETY (G25/CR-88): every fixture's payload is `sleep`, in a file named to match
# the pattern. No shell metacharacter is combined with any destructive token, so if every
# guard under test were disabled these fixtures would still do nothing but sleep.
#
# Usage: bash scripts/tests/test-foreign-sweep-guard-mutation.sh
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'

HELPER="$REPO_ROOT/scripts/lib/foreign-sweep-guard.sh"
[ -r "$HELPER" ] || { echo "FATAL: cannot read $HELPER (M2)" >&2; exit 2; }

PASSED=0; FAILED=0
ok()  { echo "  ${GREEN}OK${NC}   $1"; PASSED=$((PASSED + 1)); }
bad() { echo "  ${RED}FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/foreign-sweep.XXXXXX")" || exit 2
# The fake sweep must be a real file whose PATH matches the pattern — `bash -c 'sleep 9 #
# massu-gate-anti-vacuity.sh'` does NOT work: bash exec's straight through to sleep and the
# comment never appears in any process's argv. That false negative cost a probe run.
FAKE="$SCRATCH/massu-gate-anti-vacuity.sh"
# 30s, not 120s: every fixture here is named to MATCH the exclusivity pattern, so any that
# escapes reaping makes OTHER tools legitimately refuse for as long as it lives. The window is
# the blast radius, so keep it short — 30s is ample for a `sleep`+`ps` handshake.
printf '#!/usr/bin/env bash\nsleep 30\n' > "$FAKE"
chmod +x "$FAKE"

FAKE_PID=""
cleanup() {
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
  # REAP BY SCRATCH PATH, not by captured pid. The foreign fixture is deliberately re-parented
  # to init so it falls outside this process's tree — which also means a process-tree kill
  # cannot reach it, and if `ps` did not return its pid then $FAKE_PID is EMPTY and the kill
  # above is a silent no-op. Every fixture path contains $SCRATCH, so this reaches all of them
  # (foreign, descendant, ancestor) whatever their pid and whichever branch exited early.
  # A leaked fixture is not cosmetic: it is named to match the exclusivity pattern, so it makes
  # every other real-tree gate in the same sweep refuse — cross-gate contamination, which is
  # the very class this guard exists to prevent.
  pkill -f "$SCRATCH" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT INT TERM

# INDEPENDENT observation that a pid exists AND its argv matches the pattern. Deliberately
# NOT via the helper: a fixture control that uses the detector it is validating cannot tell
# "the fixture is real" from "the detector always says yes".
# CAPTURE then match with a here-string, never `… | grep -qF`: grep -q exits on the first
# match, the producer takes SIGPIPE, and under `set -o pipefail` the pipeline returns 141 —
# a size- and timing-dependent FALSE NEGATIVE (incident 2026-07-16, enforced by
# packages/core/src/__tests__/gate-script-grep-q-pipeline-drift-guard.test.ts, which caught
# all three occurrences in this file).
proc_matches() {  # $1 = pid, $2 = substring that must appear in its command
  local __cmdline
  __cmdline="$(ps -Ao pid=,command= 2>/dev/null \
    | sed -n "s/^[[:space:]]*$1[[:space:]]\{1,\}//p" | head -1)"
  grep -qF "$2" <<<"$__cmdline"
}

echo "── mutation proof: foreign-sweep-guard ──"

# ── 1. NEGATIVE CONTROL: no FOREIGN sweep -> PROCEED ─────────────────────────────────────
# The baseline is "nothing FOREIGN", not "nothing matching" — under the anti-vacuity sweep
# this test's own ancestors always match, so a raw process scan here can never establish a
# baseline. That is exactly what it did until 2026-07-29, and the resulting SKIP-AS-FAIL was
# reported as a guard defect (CI 30493858521):
#
#     SKIP-AS-FAIL: a real sweep is already running (pids: 163047 3002383 3002384 )
#     FAIL NEGATIVE CONTROL could not be established
#
# 163047 was the sweep and 3002383/4 were _run_guard_defeat.py — this test's own ancestry.
# It was the third hand-written process scan the helper exists to consolidate, sitting inside
# the helper's own test (CR-74 — a fix is a set of SITES).
PRE="$( . "$HELPER"; foreign_sweep_pids )"
PRE_RC=$?
if [ "$PRE_RC" -ne 0 ]; then
  # M2 — could not determine is neither clean nor foreign. Never silently a pass.
  bad "NEGATIVE CONTROL: the classifier could not read the process table (exit $PRE_RC)"
elif [ -n "${PRE// /}" ]; then
  echo "  SKIP-AS-FAIL: a genuinely FOREIGN sweep is running (pids: $PRE); cannot establish" >&2
  echo "                the nothing-running baseline. A proof that could not run is not a pass." >&2
  bad "NEGATIVE CONTROL could not be established"
else
  # shellcheck source=scripts/lib/foreign-sweep-guard.sh
  if ( . "$HELPER"; assert_no_foreign_sweep "unit test" ) >/dev/null 2>&1; then
    ok "NEGATIVE CONTROL: nothing foreign -> PROCEED (exit 0)"
  else
    bad "NEGATIVE CONTROL: refused with no foreign sweep running — the guard is a brick"
  fi
fi

# ── 2. A FOREIGN sweep (not an ancestor, not a descendant) -> REFUSE ─────────────────────
# The fixture must be OUTSIDE this test's process tree, or the guard would correctly exclude
# it as a descendant and this case would assert nothing. `"$FAKE" &` — what this test did
# until 2026-07-29 — makes it a direct CHILD, i.e. a descendant, so it only appeared to prove
# a refusal because the descendant rule did not exist yet. `( "$FAKE" & )` starts it from a
# subshell that exits immediately, so the fake is orphaned and reparented to init: genuinely
# foreign. The parentage is then ASSERTED below rather than assumed.
( "$FAKE" >/dev/null 2>&1 & )
sleep 1
FAKE_PID="$(ps -Ao pid=,command= 2>/dev/null | grep -F "$FAKE" | grep -v ' grep ' \
  | awk '{print $1}' | head -1)"
if [ -z "$FAKE_PID" ] || ! proc_matches "$FAKE_PID" "massu-gate-anti-vacuity.sh"; then
  bad "fixture is inert: the fake sweep is not in the process table — nothing was proven"
else
  ok "fixture positive control: the fake sweep IS live and matching (pid $FAKE_PID)"
  # It must be OUTSIDE this test's tree, or it would legitimately be excluded and case 2
  # would prove nothing. Its parent should no longer be this test.
  if [ "$(ps -o ppid= -p "$FAKE_PID" 2>/dev/null | tr -d ' ')" = "$$" ]; then
    bad "fixture is a direct child — it is a DESCENDANT, so REFUSE below would be wrong"
  else
    ok "fixture positive control: the fake sweep is outside this process's tree"
  fi

  # shellcheck source=scripts/lib/foreign-sweep-guard.sh
  ( . "$HELPER"; assert_no_foreign_sweep "unit test" ) >"$SCRATCH/foreign.txt" 2>&1
  rc=$?
  if [ "$rc" -eq 1 ]; then ok "FOREIGN sweep -> REFUSE (exit $rc)"
  elif [ "$rc" -eq 0 ]; then bad "FOREIGN sweep -> PROCEEDED; the guard does not guard"
  else bad "FOREIGN sweep -> exit $rc; expected 1 (refusal), not an error"; fi

  # M1 — the refusal must NAME what it saw, WITH the command. An empty command was defect
  # 2's signature: the pid had already exited by the time the old code asked about it.
  if grep -q "foreign pid $FAKE_PID: .*massu-gate-anti-vacuity" "$SCRATCH/foreign.txt"; then
    ok "refusal names the offending pid AND its command (M1)"
  else
    bad "refusal did not name the foreign pid with its command — evidence-free refusal"
    sed 's/^/        /' "$SCRATCH/foreign.txt" >&2
  fi
  if grep -q 'processes scanned: [0-9]' "$SCRATCH/foreign.txt"; then
    ok "refusal reports its DENOMINATOR (M1)"
  else
    bad "refusal reports no denominator — 'scanned 0, found 0' would read as clean"
  fi

  kill "$FAKE_PID" 2>/dev/null; FAKE_PID=""
  sleep 1
fi

# ── 3. THE FIRST REGRESSION: the same sweep as an ANCESTOR -> PROCEED ────────────────────
# TWO levels, and the split is load-bearing. The matching process must be a STRICT ancestor
# of the process that asserts — never the asserting process itself. An earlier draft had the
# matching script call the guard directly, so the only matching process was SELF, which the
# descendant rule also excludes (`chain(self)` contains self). Removing the ancestor
# exclusion entirely then left this case GREEN: it never tested an ancestor at all. Caught by
# scripts/tests/live-fire-foreign-sweep-guard.sh, and it is the same vacuity class as the
# defects under test — a fixture that cannot enter the guarded path (CR-72/M4).
#
# outer (name MATCHES the pattern) -> inner (name does NOT match) -> assert.
# This is the CI shape: sweep -> _run_guard_defeat.py -> a test whose own name matches
# nothing, which is why the ancestor exclusion is what CI 30428800020 needed.
cat > "$SCRATCH/outer-massu-gate-anti-vacuity.sh" <<'OUTER'
#!/usr/bin/env bash
# NOT `exec` — exec REPLACES this process, so its matching argv would vanish and the ancestor
# would not exist at all. Same trap as the `bash -c 'sleep 9 # name'` fixture noted above.
"$FSG_INNER"
exit $?
OUTER
cat > "$SCRATCH/inner-assert-runner.sh" <<'INNER'
#!/usr/bin/env bash
. "$FSG_HELPER"
# POSITIVE CONTROL: a matching STRICT ancestor must really be in the process table, or a
# PROCEED here proves nothing about the ancestor rule.
ANC_PID="$PPID"
# Capture, then match with a here-string — never `… | grep -q` (broken-pipe false negative).
ANC_CMD="$(ps -Ao pid=,command= 2>/dev/null \
  | sed -n "s/^[[:space:]]*$ANC_PID[[:space:]]\{1,\}//p" | head -1)"
if [ "$ANC_PID" != "$$" ] && grep -qF 'outer-massu-gate-anti-vacuity.sh' <<<"$ANC_CMD"; then
  echo "ANCESTOR-VISIBLE $ANC_PID"
else
  echo "ANCESTOR-INVISIBLE"
fi
assert_no_foreign_sweep "unit test"
exit $?
INNER
chmod +x "$SCRATCH/outer-massu-gate-anti-vacuity.sh" "$SCRATCH/inner-assert-runner.sh"

FSG_HELPER="$HELPER" FSG_INNER="$SCRATCH/inner-assert-runner.sh" \
  "$SCRATCH/outer-massu-gate-anti-vacuity.sh" >"$SCRATCH/ancestor.txt" 2>&1
rc=$?
if grep -q '^ANCESTOR-VISIBLE [0-9]' "$SCRATCH/ancestor.txt"; then
  ok "fixture positive control: a matching strict ANCESTOR is live and visible ($(sed -n 's/^ANCESTOR-VISIBLE //p' "$SCRATCH/ancestor.txt" | head -1))"
else
  bad "fixture is inert: no matching ancestor was visible — case 3 proved nothing"
  sed 's/^/        /' "$SCRATCH/ancestor.txt" >&2
fi
if [ "$rc" -eq 0 ]; then
  ok "OWN ANCESTOR -> PROCEED (exit 0) — CI 30428800020's self-detection is fixed"
else
  bad "OWN ANCESTOR -> REFUSED (exit $rc); CI 30428800020's failure is live again"
  sed 's/^/        /' "$SCRATCH/ancestor.txt" >&2
fi

# ── 4. THE SECOND REGRESSION: my own DESCENDANT -> PROCEED ───────────────────────────────
# The exact shape of CI 30493858521, made explicit and non-transient. The script's path
# matches the pattern, so when it forks — as `$(...)` does — the child inherits that argv and
# appears in the process table as a sweep. Here the fork is a deliberate long-lived `sleep`
# so the case cannot pass by winning a race against a subshell that exited too fast.
cat > "$SCRATCH/kid-massu-gate-anti-vacuity.sh" <<'KID'
#!/usr/bin/env bash
# `--linger` is the descendant itself: same argv (so it matches the pattern), inert payload.
if [ "${1:-}" = "--linger" ]; then sleep 30; exit 0; fi
. "$FSG_HELPER"
"$0" --linger >/dev/null 2>&1 &
KIDPID=$!
trap '[ -n "${KIDPID:-}" ] && kill "$KIDPID" 2>/dev/null' EXIT
sleep 1
# POSITIVE CONTROL: the descendant must really exist and really match, or the PROCEED below
# proves nothing (CR-72/M4 — a fixture that cannot fire is decoration).
# Capture, then match with a here-string — never `… | grep -q` (broken-pipe false negative).
KID_CMD="$(ps -Ao pid=,command= 2>/dev/null \
  | sed -n "s/^[[:space:]]*$KIDPID[[:space:]]\{1,\}//p" | head -1)"
if grep -qF 'kid-massu-gate-anti-vacuity.sh' <<<"$KID_CMD"; then
  echo "DESCENDANT-VISIBLE $KIDPID"
else
  echo "DESCENDANT-INVISIBLE"
fi
assert_no_foreign_sweep "unit test"
exit $?
KID
chmod +x "$SCRATCH/kid-massu-gate-anti-vacuity.sh"

FSG_HELPER="$HELPER" "$SCRATCH/kid-massu-gate-anti-vacuity.sh" >"$SCRATCH/kid.txt" 2>&1
rc=$?
if grep -q '^DESCENDANT-VISIBLE [0-9]' "$SCRATCH/kid.txt"; then
  ok "fixture positive control: a matching DESCENDANT is live and visible ($(sed -n 's/^DESCENDANT-VISIBLE //p' "$SCRATCH/kid.txt" | head -1))"
else
  bad "fixture is inert: no matching descendant was visible — case 4 proved nothing"
  sed 's/^/        /' "$SCRATCH/kid.txt" >&2
fi
if [ "$rc" -eq 0 ]; then
  ok "OWN DESCENDANT -> PROCEED (exit 0) — CI 30493858521's self-detection is fixed"
else
  bad "OWN DESCENDANT -> REFUSED (exit $rc); a fork of mine is not a competitor"
  sed 's/^/        /' "$SCRATCH/kid.txt" >&2
fi

# ── 5. The ancestry walk terminates and includes self ────────────────────────────────────
# shellcheck source=scripts/lib/foreign-sweep-guard.sh
ANC="$( . "$HELPER"; _sweep_ancestor_pids "$$" )"
case "$ANC" in
  *" $$ "*) ok "ancestry set includes this process" ;;
  *)        bad "ancestry set omits \$\$ ($ANC) — self would be read as foreign" ;;
esac
# A pid prefix must not match a longer pid: the set is space-padded for exactly this reason.
if [ "${#ANC}" -gt 2 ] && [ "${#ANC}" -lt 400 ]; then
  ok "ancestry walk terminated (len ${#ANC}), no runaway"
else
  bad "ancestry walk produced a suspicious set (len ${#ANC}): $ANC"
fi

# ── 6. M2: the classifier FAILS CLOSED when it cannot look ───────────────────────────────
# The one failure mode that must never resolve to "clean" — and there are TWO independent
# blind paths, which must be injected SEPARATELY. An earlier draft emptied PATH entirely,
# which removed `ps` AND `python3` at once, so it only ever exercised the denominator branch
# and left the FSG-ERROR branch untested: a plant that made FSG-ERROR return 0 stayed GREEN
# (found by scripts/tests/live-fire-foreign-sweep-guard.sh). One injection per path, each
# surgical — the rest of PATH stays intact so nothing fails for an unrelated reason.
mkdir -p "$SCRATCH/badbin"
# 6a — `ps` runs and FAILS: the classifier reaches its FSG-ERROR path.
printf '#!/usr/bin/env bash\necho "ps: simulated failure (injected)" >&2\nexit 1\n' \
  > "$SCRATCH/badbin/ps"
# 6b — `python3` is effectively absent: the classifier emits nothing, so there is no
#      denominator, which must ALSO refuse rather than read as an empty (clean) result.
printf '#!/usr/bin/env bash\nexit 127\n' > "$SCRATCH/badbin/python3"
chmod +x "$SCRATCH/badbin/ps" "$SCRATCH/badbin/python3"

assert_fails_closed() {  # $1 = label, $2 = shadowed binary, $3 = ERE the reason must match
  local label="$1" shadow="$2" reason="$3" out rc
  out="$SCRATCH/blind-$shadow.txt"
  mkdir -p "$SCRATCH/only-$shadow"
  cp "$SCRATCH/badbin/$shadow" "$SCRATCH/only-$shadow/$shadow"
  ( PATH="$SCRATCH/only-$shadow:$PATH"; . "$HELPER"; assert_no_foreign_sweep "unit test" ) \
    >"$out" 2>&1
  rc=$?
  if [ "$rc" -eq 2 ]; then
    ok "M2 FAIL-CLOSED [$label] -> exit 2 (not 0, not 1)"
  elif [ "$rc" -eq 0 ]; then
    bad "M2 [$label]: could not look and reported CLEAN — the blind-gate value"
    sed 's/^/        /' "$out" >&2
  else
    bad "M2 [$label]: exit $rc; expected 2"
    sed 's/^/        /' "$out" >&2
  fi
  # POSITIVE CONTROL for the injection: prove the sabotage was real and took the intended
  # branch. Without it, "it refused" and "it never ran" look identical (G17 applied here).
  if grep -qE "$reason" "$out"; then
    ok "M2 [$label]: the injection is real and took its own branch"
  else
    bad "M2 [$label]: expected /$reason/ — the injection may not have taken effect"
    sed 's/^/        /' "$out" >&2
  fi
}
assert_fails_closed "ps fails"       ps      'FSG-ERROR ps exited'
assert_fails_closed "python3 absent" python3 'no denominator'

echo
echo "  passed: $PASSED   failed: $FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "${RED}FAIL${NC}: foreign-sweep-guard is not proven."
  exit 1
fi
echo "${GREEN}PASS${NC}: refuses a foreign sweep; proceeds under its own ancestor, its own"
echo "      descendant, and a clean tree; fails CLOSED when it cannot look."

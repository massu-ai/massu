#!/usr/bin/env bash
# CR-72 live-fire for scripts/lib/bounded-run.sh.
#
# Plants each defect the attacker exists to catch INTO THE REAL FILE, demands the attacker go
# RED *for its own declared reason*, restores, and proves the restore is byte-identical by
# sha256. Then proves the attacker still OPENS on the genuine file — a brick gets disabled.
#
# ⛔ A REGRESSION TEST CANNOT FIND A FALSE NEGATIVE. test-bounded-run.sh passing 11/11 says
# nothing about whether those 11 assertions can fail. This script is what makes them evidence.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$ROOT/scripts/lib/bounded-run.sh"
ATTACKER="$ROOT/scripts/tests/test-bounded-run.sh"

[ -f "$LIB" ] || { printf 'live-fire: subject not found: %s\n' "$LIB" >&2; exit 2; }
[ -f "$ATTACKER" ] || { printf 'live-fire: attacker not found: %s\n' "$ATTACKER" >&2; exit 2; }

BACKUP="$(mktemp)"
SHA_BEFORE="$(shasum -a 256 "$LIB" | cut -c1-16)"
cp "$LIB" "$BACKUP"

restore() {
  cp "$BACKUP" "$LIB"
}
_cleanup() {
  restore
  # Defined further down, before any attacker runs; guarded so an early exit is still clean.
  if declare -F _lf_cleanup >/dev/null; then _lf_cleanup; fi
  rm -f "$BACKUP"
}
trap _cleanup EXIT

# ⛔ ONE DECLARATION. This count changed the moment an attacker case was added, and it is
# referenced three times below — exactly the shape that lands at one site of three (CR-74).
CLEAN_PASS_RE="passed, 0 failed"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  BAD  %s\n' "$1"; }

# ⛔ A PLANT THAT BREAKS CONTAINMENT LEAKS A REAL PROCESS, AND THIS FILE MUST REAP IT.
# Plant 1 exists to orphan the attacker's looping grandchild. Before 2026-09-26 nothing reaped it:
# ten such loops from 2026-09-24 runs were still alive two days later, appending every second to
# markers whose directory had been deleted. The attacker now reaps its own fixtures on EXIT, but a
# plant can kill the attacker before that trap finishes (plant 3 may SIGKILL it), so this file
# keeps an INDEPENDENT sweep: the attacker's TMPDIR is rooted in LF_SCRATCH, every fixture process
# carries that unique path on its command line, and nothing else does.
LF_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/lf-bounded-run-XXXXXX")"
sweep_scratch() {
  local pids
  pids="$(pgrep -f -- "$LF_SCRATCH" 2>/dev/null | tr '\n' ' ')"
  [ -n "${pids// /}" ] || { printf '0'; return 0; }
  # shellcheck disable=SC2086  # a word list of pids, by construction
  kill -TERM $pids 2>/dev/null
  sleep 1
  local left
  left="$(pgrep -f -- "$LF_SCRATCH" 2>/dev/null | tr '\n' ' ')"
  # shellcheck disable=SC2086
  [ -z "${left// /}" ] || kill -KILL $left 2>/dev/null
  printf '%s' "$pids" | wc -w | tr -d ' '
}
_lf_cleanup() {
  sweep_scratch >/dev/null
  rm -rf "${LF_SCRATCH:?}"
}

# ⛔ THE ATTACKER IS CONTAINED BY THE *GENUINE* LIBRARY, NEVER BY THE PLANTED ONE.
# A plant that breaks containment makes the attacker's own hang fixtures hang FOREVER, and an
# uncontained attacker then hangs THIS script — which is precisely how the CI job "Type Check"
# hung for 78+ minutes on 2026-10-11 (on GNU, `tail -r` broke the real library the same way a
# plant would). So the bound comes from the byte-identical BACKUP of the subject, sourced into
# a namespace the plants never touch, and reaching it is scored as its OWN outcome.
#
# ATTACKER_CEILING is containment, not a pass criterion (G27): the attacker's own sleeps total
# ~12s and a full live-fire measured 52s for 6 attacker runs on the dev host. 120s is ~10x.
# Re-measured 2026-10-12 after plants 4-6 and case 9: 146s for 8 attacker runs on a loaded host,
# none contained — plant 6 is the slowest (each ceiling case spends BR_REAP_GRACE proving death).
ATTACKER_CEILING=120
# Markers, printed INTO the captured output. run_attacker runs inside `$(...)`, so a variable it
# set would die with the subshell; the outcome has to travel in the bytes the caller reads.
HUNG_MARK="LIVE-FIRE-VERDICT: ATTACKER HUNG (contained at ceiling)"
# shellcheck disable=SC1090  # the genuine subject, copied above; path is a mktemp file
. "$BACKUP"

# Run the attacker with BOUNDED output too. A defect in a containment primitive can produce
# unbounded output, and a probe for that must not itself be unbounded (measured this session:
# an unbounded first run of freshly converted code cost 5GB).
run_attacker() {
  local log errf rc=0
  log="$(mktemp)"
  errf="$(mktemp)"
  # The OUTER bound's own stderr goes to its own file: the attacker's log can legitimately carry
  # the PLANTED library's "containment FAILED" line (plant 6 expects exactly that), and reading
  # one stream for both would score the subject's correct behaviour as the harness hanging.
  # TMPDIR roots the attacker's scratch in LF_SCRATCH, so sweep_scratch can find what it leaks.
  br_run_bounded "$ATTACKER_CEILING" "$log" env TMPDIR="$LF_SCRATCH" bash "$ATTACKER" 2>"$errf" || rc=$?
  head -c 200000 "$log"
  # Either outer outcome means the attacker produced no trustworthy verdict: the ceiling, or a
  # containment failure (BR_EXIT_UNREAPED; the two failure lines differ in case, hence -i).
  if [ "$rc" -eq "$BR_EXIT_CEILING" ] || [ "$rc" -eq "$BR_EXIT_UNREAPED" ] \
    || /usr/bin/grep -qi 'containment FAILED' "$errf"; then
    printf '\n%s %ss\n' "$HUNG_MARK" "$ATTACKER_CEILING"
    cat "$errf"
  fi
  rm -f "$log" "$errf"
}

# True when the attacker had to be contained. A contained attacker produced NO verdict, so
# every check that reads OUT must treat this as BAD, never as a RED it can score.
attacker_hung() { printf '%s' "$1" | /usr/bin/grep -qF "$HUNG_MARK"; }

# expect_no_leftovers <label> — after an attacker run, NOTHING may still name the scratch root.
# The attacker's own EXIT trap is what should have reaped it; a non-zero count means that trap
# did not run or did not work, which is the leak this section exists to end.
expect_no_leftovers() {
  local n
  n="$(sweep_scratch)"
  if [ "$n" = "0" ]; then
    ok "$1: nothing the attacker started outlived it"
  else
    bad "$1: $n process(es) outlived the attacker and had to be reaped HERE"
  fi
}

# expect_attacker_reaped <label> — POSITIVE CONTROL for expect_no_leftovers under a plant that
# breaks containment: "nothing outlived the attacker" is only evidence if something LEAKED and the
# attacker's own cleanup reaped it. Without this, a plant that leaked nothing would pass the same.
expect_attacker_reaped() {
  if printf '%s' "$OUT" | /usr/bin/grep -q 'test-bounded-run: reaping fixture processes left behind'; then
    ok "$1: the plant really leaked a process, and the attacker's own cleanup reaped it"
  else
    bad "$1: no leak was reaped by the attacker — the no-leftover assertion proves nothing here"
  fi
}

printf '== baseline: the attacker OPENS on the genuine file ==\n'
OUT="$(run_attacker)"
if attacker_hung "$OUT"; then
  bad "genuine file: the attacker HUNG and had to be contained — refusing to trust any RED below"
  printf '%s\n' "$OUT" | tail -20
  printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
  exit 1
elif printf '%s' "$OUT" | /usr/bin/grep -q "$CLEAN_PASS_RE"; then
  ok "genuine file passed cleanly (the gate is not a brick)"
else
  bad "genuine file did NOT pass cleanly — refusing to trust any RED below"
  printf '%s\n' "$OUT" | tail -20
  printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
  exit 1
fi
expect_no_leftovers "baseline"

# ── PLANT 1: containment stops at the direct child (grandchildren orphaned) ────────────────
# ⛔ TWO MECHANISMS NOW CONTAIN A GRANDCHILD AT THE CEILING — the descendant walk AND the
# subject's process group (added 2026-09-26). Planting only the walk would leave the group reap
# containing the grandchild, the case would stay GREEN, and this plant would read as DEAD while
# measuring nothing. "Containment stops at the direct child" means BOTH are gone.
printf '\n== plant 1: kill only the root, orphaning grandchildren ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = 'ordered="$(br_tree_pids "$root" | tr \' \' \'\\n\' | /usr/bin/grep -v \'^$\' | br_reverse_lines | tr \'\\n\' \' \')"'
new = 'ordered="$root"   # AV-PLANT: direct child only'
assert s.count(old) == 1, "plant 1 walk anchor not found exactly once — the plant would be inert"
s = s.replace(old, new, 1)
old2 = '  local pg="${1:?br_reap_group: process group id required}"\n'
new2 = '  return 0   # AV-PLANT: the group is never reaped\n' + old2
assert s.count(old2) == 1, "plant 1 group anchor not found exactly once — the plant would be inert"
io.open(p, "w", encoding="utf-8").write(s.replace(old2, new2, 1))
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 1 could not be applied — anchor drift"; else
  OUT="$(run_attacker)"
  # Must go RED, and specifically on the GRANDCHILD assertion — not merely "some failure".
  if attacker_hung "$OUT"; then
    bad "plant 1: the attacker HUNG — it produced no verdict, so nothing was proven"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '0 failed'; then
    bad "plant 1: the attacker stayed GREEN with grandchildren orphaned — the case is DEAD"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '✗.*GRANDCHILD is dead'; then
    ok "plant 1 reddened the GRANDCHILD assertion, which is its declared reason"
  else
    bad "plant 1 reddened, but NOT on the grandchild assertion — wrong reason"
    printf '%s' "$OUT" | /usr/bin/grep '✗' | head -5
  fi
fi
# The plant above leaks a real looping grandchild ON PURPOSE. This is the assertion that it did
# not outlive the attacker — the leak that left ten loops running from 2026-09-24.
expect_attacker_reaped "plant 1"
expect_no_leftovers "plant 1"

# ── PLANT 2: the ceiling sentinel collapses into the subject's own status ──────────────────
printf '\n== plant 2: return the killed subject status instead of BR_EXIT_CEILING ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = '      return "$BR_EXIT_CEILING"'
new = '      return 1   # AV-PLANT: collapse the ceiling into an ordinary failure'
assert old in s, "plant 2 anchor not found — the plant would be inert"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 2 could not be applied — anchor drift"; else
  OUT="$(run_attacker)"
  if attacker_hung "$OUT"; then
    bad "plant 2: the attacker HUNG — it produced no verdict, so nothing was proven"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '0 failed'; then
    bad "plant 2: the attacker stayed GREEN with the ceiling collapsed — the case is DEAD"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '✗.*BR_EXIT_CEILING'; then
    ok "plant 2 reddened the sentinel-distinctness assertion, which is its declared reason"
  else
    bad "plant 2 reddened, but NOT on the sentinel assertion — wrong reason"
    printf '%s' "$OUT" | /usr/bin/grep '✗' | head -5
  fi
fi

# ── PLANT 3: the self-protection is removed (the primitive may signal its own ancestry) ────
printf '\n== plant 3: remove the never-signal-ourselves guard ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = """      case " $self_chain " in
        *" $p "*) continue ;;                # never ourselves or an ancestor
      esac
"""
new = "      # AV-PLANT: self-protection removed\n"
assert old in s, "plant 3 anchor not found — the plant would be inert"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 3 could not be applied — anchor drift"; else
  # ⛔ THE EXPECTED OUTCOME HERE IS NOT A TIDY RED. With self-protection gone the attacker may
  # kill its own shell mid-run, so the honest assertion is that it does NOT report success.
  # "It died" and "it reported failure" are both acceptable; only a clean PASS is a defect.
  OUT="$(run_attacker)"
  if attacker_hung "$OUT"; then
    bad "plant 3: the attacker HUNG — it produced no verdict, so nothing was proven"
  elif printf '%s' "$OUT" | /usr/bin/grep -q "$CLEAN_PASS_RE"; then
    bad "plant 3: the attacker reported a FULL CLEAN PASS while able to signal its own ancestry"
  else
    ok "plant 3 did not produce a clean pass (the harness cannot certify itself while suicidal)"
  fi
fi
# Plant 3 may SIGKILL the attacker before its EXIT trap runs, so a leftover here is EXPECTED and
# is reaped rather than judged; the sweep is what keeps it from outliving this file.
printf '  note plant 3: reaped %s leftover process(es) from a possibly-killed attacker\n' "$(sweep_scratch)"

# ── PLANT 4: nothing is reaped when the subject returns ON ITS OWN ─────────────────────────
# The 2026-09-26 defect itself: before it, only the ceiling path killed anything. Case 9 is the
# only case that depends on the natural-exit reap alone (the ceiling cases are also covered by
# the walk), so it must be the one that reddens — and case 4 must NOT, which is what makes this
# plant discriminate rather than merely break things.
printf '\n== plant 4: do not reap the group when the subject exits before the ceiling ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = '  wait "$pid" || rc=$?\n  br_reap_group "$pid" || return "$BR_EXIT_UNREAPED"\n'
new = '  wait "$pid" || rc=$?\n  : # AV-PLANT: nothing reaped on a natural exit\n'
assert s.count(old) == 1, "plant 4 anchor not found exactly once — the plant would be inert"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 4 could not be applied — anchor drift"; else
  OUT="$(run_attacker)"
  if attacker_hung "$OUT"; then
    bad "plant 4: the attacker HUNG — it produced no verdict, so nothing was proven"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '0 failed'; then
    bad "plant 4: the attacker stayed GREEN with natural-exit reaping removed — case 9 is DEAD"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '✗.*descendant it left behind is DEAD'; then
    ok "plant 4 reddened the left-behind-descendant assertion, which is its declared reason"
  else
    bad "plant 4 reddened, but NOT on the left-behind-descendant assertion — wrong reason"
    printf '%s' "$OUT" | /usr/bin/grep '✗' | head -5
  fi
  if printf '%s' "$OUT" | /usr/bin/grep -q '✗.*GRANDCHILD is dead'; then
    bad "plant 4 also reddened the CEILING grandchild case — it is not discriminating the two paths"
  else
    ok "plant 4 left the ceiling grandchild case GREEN — the natural-exit path is what it isolates"
  fi
fi
expect_attacker_reaped "plant 4"
expect_no_leftovers "plant 4"

# ── PLANT 5: "could not look at the group" collapses into "the group is empty" ─────────────
printf '\n== plant 5: a missing/failed pgrep reads as an empty group ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
pairs = [
  ('  command -v pgrep >/dev/null 2>&1 || return 2\n',
   '  command -v pgrep >/dev/null 2>&1 || return 1   # AV-PLANT: could-not-look reads as empty\n'),
  ('    1) return 1 ;;\n    *) return 2 ;;\n',
   '    1) return 1 ;;\n    *) return 1 ;;   # AV-PLANT\n'),
]
for old, new in pairs:
    assert s.count(old) == 1, "plant 5 anchor not found exactly once — the plant would be inert: %r" % old
    s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8").write(s)
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 5 could not be applied — anchor drift"; else
  OUT="$(run_attacker)"
  if attacker_hung "$OUT"; then
    bad "plant 5: the attacker HUNG — it produced no verdict, so nothing was proven"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '0 failed'; then
    bad "plant 5: the attacker stayed GREEN with could-not-look collapsed into empty — case 10 is DEAD"
  elif printf '%s' "$OUT" | /usr/bin/grep -q "✗.*could not look, never 'empty'"; then
    ok "plant 5 reddened the three-valued assertion, which is its declared reason"
  else
    bad "plant 5 reddened, but NOT on the three-valued assertion — wrong reason"
    printf '%s' "$OUT" | /usr/bin/grep '✗' | head -5
  fi
fi
expect_no_leftovers "plant 5"

# ── PLANT 6: nothing is signalled — an EMPTY kill list AND no group reap ──────────────────
# This is the defect that hung CI on 2026-10-11, planted deliberately: GNU tail has no `-r`, the
# reversal printed nothing, and br_kill_tree signalled no process at all. Two things must hold:
# the attacker reddens on the CEILING assertion (containment did not happen, and the primitive
# must SAY so rather than return the ceiling code), and the attacker must NOT HANG — a
# containment primitive that blocks forever when its kill fails is the original defect.
# Since the process-group reap (plant 4's subject), an empty kill list ALONE is contained by the
# group, so it would stay GREEN and read as DEAD; "the kill reached nothing" means both are gone.
printf '\n== plant 6: an empty kill list and no group reap (signal nothing) ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = 'ordered="$(br_tree_pids "$root" | tr \' \' \'\\n\' | /usr/bin/grep -v \'^$\' | br_reverse_lines | tr \'\\n\' \' \')"'
new = 'ordered=""   # AV-PLANT: the reversal produced nothing (the GNU `tail -r` failure)'
assert s.count(old) == 1, "plant 6 walk anchor not found exactly once — the plant would be inert"
s = s.replace(old, new, 1)
old2 = '  local pg="${1:?br_reap_group: process group id required}"\n'
new2 = '  return 0   # AV-PLANT: the group is never reaped\n' + old2
assert s.count(old2) == 1, "plant 6 group anchor not found exactly once — the plant would be inert"
io.open(p, "w", encoding="utf-8").write(s.replace(old2, new2, 1))
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 6 could not be applied — anchor drift"; else
  OUT="$(run_attacker)"
  if attacker_hung "$OUT"; then
    bad "plant 6: the attacker HUNG when the kill reached nothing — containment can block forever"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '0 failed'; then
    bad "plant 6: the attacker stayed GREEN while nothing was killed — the case is DEAD"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '✗ a hanging subject returns BR_EXIT_CEILING'; then
    ok "plant 6 reddened the ceiling assertion WITHOUT hanging, which is its declared reason"
  else
    bad "plant 6 reddened, but NOT on the ceiling assertion — wrong reason"
    printf '%s' "$OUT" | /usr/bin/grep '✗' | head -5
  fi
fi
expect_no_leftovers "plant 6"

# ── restore and prove it ──────────────────────────────────────────────────────────────────
printf '\n== restore ==\n'
restore
SHA_AFTER="$(shasum -a 256 "$LIB" | cut -c1-16)"
if [ "$SHA_BEFORE" = "$SHA_AFTER" ]; then
  ok "bounded-run.sh restored byte-identically ($SHA_AFTER)"
else
  bad "RESTORE FAILED: $SHA_BEFORE -> $SHA_AFTER"
fi

OUT="$(run_attacker)"
if attacker_hung "$OUT"; then
  bad "the restored library: the attacker HUNG and had to be contained"
elif printf '%s' "$OUT" | /usr/bin/grep -q "$CLEAN_PASS_RE"; then
  ok "the restored library still OPENS on a genuine pass"
else
  bad "the restored library no longer passes — the tree is not as it was"
fi
expect_no_leftovers "restored"

printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

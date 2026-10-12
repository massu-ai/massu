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

# ⛔ THE ATTACKER IS CONTAINED BY THE *GENUINE* LIBRARY, NEVER BY THE PLANTED ONE.
# A plant that breaks containment makes the attacker's own hang fixtures hang FOREVER, and an
# uncontained attacker then hangs THIS script — which is precisely how the CI job "Type Check"
# hung for 78+ minutes on 2026-10-11 (on GNU, `tail -r` broke the real library the same way a
# plant would). So the bound comes from the byte-identical BACKUP of the subject, sourced into
# a namespace the plants never touch, and reaching it is scored as its OWN outcome.
#
# ATTACKER_CEILING is containment, not a pass criterion (G27): the attacker's own sleeps total
# ~12s and a full live-fire measured 52s for 6 attacker runs on the dev host. 120s is ~10x.
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
  # the PLANTED library's "containment FAILED" line (plant 4 expects exactly that), and reading
  # one stream for both would score the subject's correct behaviour as the harness hanging.
  br_run_bounded "$ATTACKER_CEILING" "$log" bash "$ATTACKER" 2>"$errf" || rc=$?
  head -c 200000 "$log"
  if [ "$rc" -eq "$BR_EXIT_CEILING" ] || /usr/bin/grep -q 'containment FAILED' "$errf"; then
    printf '\n%s %ss\n' "$HUNG_MARK" "$ATTACKER_CEILING"
    cat "$errf"
  fi
  rm -f "$log" "$errf"
}

# True when the attacker had to be contained. A contained attacker produced NO verdict, so
# every check that reads OUT must treat this as BAD, never as a RED it can score.
attacker_hung() { printf '%s' "$1" | /usr/bin/grep -qF "$HUNG_MARK"; }

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

# ── PLANT 1: containment stops at the direct child (grandchildren orphaned) ────────────────
printf '\n== plant 1: kill only the root, orphaning grandchildren ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = 'ordered="$(br_tree_pids "$root" | tr \' \' \'\\n\' | /usr/bin/grep -v \'^$\' | br_reverse_lines | tr \'\\n\' \' \')"'
new = 'ordered="$root"   # AV-PLANT: direct child only'
assert old in s, "plant 1 anchor not found — the plant would be inert (a plant that matches nothing reddens nothing)"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
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

# ── PLANT 4: the kill list comes out EMPTY, so nothing is signalled ───────────────────────
# This is the defect that hung CI on 2026-10-11, planted deliberately: GNU tail has no `-r`, the
# reversal printed nothing, and br_kill_tree signalled no process at all. Two things must hold:
# the attacker reddens on the CEILING assertion (containment did not happen, and the primitive
# must SAY so rather than return the ceiling code), and the attacker must NOT HANG — a
# containment primitive that blocks forever when its kill fails is the original defect.
printf '\n== plant 4: an empty kill list (signal nothing) ==\n'
restore
python3 - "$LIB" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = 'ordered="$(br_tree_pids "$root" | tr \' \' \'\\n\' | /usr/bin/grep -v \'^$\' | br_reverse_lines | tr \'\\n\' \' \')"'
new = 'ordered=""   # AV-PLANT: the reversal produced nothing (the GNU `tail -r` failure)'
assert old in s, "plant 4 anchor not found — the plant would be inert"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
PLANT_RC=$?
if [ "$PLANT_RC" -ne 0 ]; then bad "plant 4 could not be applied — anchor drift"; else
  OUT="$(run_attacker)"
  if attacker_hung "$OUT"; then
    bad "plant 4: the attacker HUNG when the kill reached nothing — containment can block forever"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '0 failed'; then
    bad "plant 4: the attacker stayed GREEN while nothing was killed — the case is DEAD"
  elif printf '%s' "$OUT" | /usr/bin/grep -q '✗ a hanging subject returns BR_EXIT_CEILING'; then
    ok "plant 4 reddened the ceiling assertion WITHOUT hanging, which is its declared reason"
  else
    bad "plant 4 reddened, but NOT on the ceiling assertion — wrong reason"
    printf '%s' "$OUT" | /usr/bin/grep '✗' | head -5
  fi
fi

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

printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

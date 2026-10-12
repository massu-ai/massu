#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, run the REAL gate, demand the verdict
# change for its OWN declared reason, restore, prove byte-identical.
#
# SUBJECT: `scripts/sweep-plan-citations.sh`'s in-flight scoping.
#
# A SCOPE NARROWING IS THE MOST DANGEROUS KIND OF CHANGE TO A GATE (G18/G28): it moves work
# out of view and the gate gets QUIETER, which is what a healthy gate also does. So the
# property under attack is not "does it pass" but "can a plan that MATTERS still be seen".
#
# ⛔ NO `rm -rf` AND NO INTERPOLATED DELETE PATH (G17). Nothing here deletes.
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2
SWEEP="scripts/sweep-plan-citations.sh"
[ -f "$SWEEP" ] || { echo "FATAL: $SWEEP not found" >&2; exit 2; }

# A plan that is ARCHIVED (Status SHIPPED/COMPLETE) *and* currently failing. If the scoping
# is honest, flipping its status must bring it back into view. Derived, never hardcoded —
# a hardcoded victim rots the first time that plan's status changes (G32).
# INJECTION SEAM, never a default. The baseline negative control added below refuses a victim
# that is ALREADY named at baseline -- and a refusal you cannot trigger is indistinguishable
# from a branch that never runs (G17: mutation-test the guard with the dependency INJECTED).
# The DERIVATION stays the default, so nothing about the normal run changes (G32).
VICTIM="${LF_SWEEP_VICTIM:-}"
if [ -n "$VICTIM" ]; then
  [ -f "$VICTIM" ] || { echo "FATAL: injected LF_SWEEP_VICTIM does not exist: $VICTIM" >&2; exit 2; }
fi
while IFS= read -r f; do
  [ -z "$VICTIM" ] || break
  head -40 "$f" | LC_ALL=C grep -qiE '^\*\*Status\*\*:.*(SHIPPED|COMPLETE|IMPLEMENTED|DONE)' || continue
  # rc 0 = clean, rc 3 = NO-CITATIONS. Only a genuine FAILURE can appear in the sweep's
  # failed list, so anything else makes a useless victim — the first draft of this harness
  # picked an rc=3 plan and then reported the SWEEP as broken when the plan simply had no
  # citations to resolve. The attack must be able to tell its own bug from its subject's.
  node scripts/verify-plan-citations.mjs "$f" --quiet >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || { VICTIM="$f"; break; }
done < <(git ls-files 'docs/plans/*.md' | LC_ALL=C sort)
[ -n "$VICTIM" ] || { echo "FATAL: found no archived+failing plan to attack with" >&2; exit 2; }
if [ -n "${LF_SWEEP_VICTIM:-}" ]; then
  echo "victim (INJECTED): $VICTIM"
else
  echo "victim (derived): $VICTIM"
fi

BEFORE_SHA="$(shasum -a 256 "$VICTIM" | cut -d' ' -f1)"
BACKUP="$(mktemp)" || exit 2
cp "$VICTIM" "$BACKUP" || exit 2
trap 'cp "$BACKUP" "$VICTIM" 2>/dev/null; rm -f "$BACKUP"' EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -8; FAIL=$((FAIL+1)); }
scanned() { printf '%s' "$1" | sed -n 's/^PLANS SCANNED (denominator): //p'; }
archived(){ printf '%s' "$1" | sed -n 's/^  ARCHIVED     : \([0-9]*\).*/\1/p'; }

echo "=== 0. BASELINE ==="
BASE="$(bash "$SWEEP" 2>&1)"; BASE_RC=$?
# ⛔ THE BASELINE WAS THE NEGATIVE CONTROL, AND ITS STATUS WAS CAPTURED AND NEVER READ.
# Case 1 below concludes "the plant reddened the sweep" from `RC -ne 0`. That inference is
# only valid if the sweep was GREEN before the plant. MEASURED 2026-09-24: it is NOT --
# `bash scripts/sweep-plan-citations.sh` exits 1 on this tree today, because in-flight plans
# legitimately carry unresolvable citations and this sweep is a REPORTER. So the `RC -ne 0`
# half of that conjunction is satisfied at baseline, carries no information, and would be
# satisfied by a plant that did nothing at all.
#
# Asserting BASE_RC == 0 would therefore BRICK this harness (CR-72 -- a brick gets disabled).
# The differential signal that DOES work is the victim's NAME: absent while it is archived,
# present once the plant re-opens it. That is asserted on both sides from here on, and the
# baseline status is REPORTED rather than assumed so a future reader can see which signal is
# load-bearing (M1).
echo "  baseline verdict: rc=$BASE_RC (recorded -- this sweep REPORTS, so rc is not the signal)"
if printf '%s' "$BASE" | grep -qF "$VICTIM"; then
  bad "the victim is ALREADY named at baseline -- no plant below could be attributed to itself" "$BASE"
  exit 1
fi
ok "the archived victim is ABSENT from the baseline output (the negative half of the differential)"
B_SCAN="$(scanned "$BASE")"; B_ARCH="$(archived "$BASE")"
if [ -n "$B_SCAN" ] && [ -n "$B_ARCH" ]; then
  ok "in-flight scope reports both denominators (scanned=$B_SCAN archived=$B_ARCH)"
else
  bad "the sweep did not report both denominators" "$BASE"; exit 1
fi
ALL="$(bash "$SWEEP" all 2>&1)"; ALL_RC=$?
A_SCAN="$(scanned "$ALL")"
# M1/M2: an unparseable probe is an ERROR, not a partition failure. Without this, a crashed
# `all` run leaves A_SCAN empty and the comparison below reports "the partition loses plans"
# -- a confident, specific, wrong diagnosis pointing away from the real cause.
if [ -z "$A_SCAN" ]; then
  bad "the 'all' sweep printed no denominator (rc=$ALL_RC) -- there is nothing to compare" "$ALL"
  exit 1
fi
if [ "$A_SCAN" = "$((B_SCAN + B_ARCH))" ]; then
  ok "in-flight + archived == all ($B_SCAN + $B_ARCH = $A_SCAN): nothing is unaccounted for"
else
  bad "the partition loses plans: $B_SCAN + $B_ARCH != $A_SCAN" "$ALL"
fi

echo "=== 1. PLANT: an archived plan goes back IN FLIGHT — it must reappear ==="
perl -0pi -e 's{^\*\*Status\*\*:.*$}{**Status**: IN PROGRESS — planted by live-fire-plan-sweep-scope.sh}m' "$VICTIM"
OUT="$(bash "$SWEEP" 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF "$VICTIM"; then
  ok "a re-opened plan is scanned again and its failure is reported"
else
  bad "a re-opened plan stayed invisible — the scoping hides live work (rc=$RC)" "$OUT"
fi
if [ "$(scanned "$OUT")" = "$((B_SCAN + 1))" ] && [ "$(archived "$OUT")" = "$((B_ARCH - 1))" ]; then
  ok "both denominators MOVED by exactly one, so the shift is visible in the numbers"
else
  bad "denominators did not move: scanned $(scanned "$OUT") archived $(archived "$OUT")"
fi
cp "$BACKUP" "$VICTIM"

echo "=== 2. PLANT: a plan with NO status line must be treated as in-flight (fail closed) ==="
perl -0pi -e 's{^\*\*Status\*\*:.*\n}{}m' "$VICTIM"
OUT="$(bash "$SWEEP" 2>&1)"; RC=$?
if printf '%s' "$OUT" | grep -qF "$VICTIM"; then
  ok "unknown status -> scanned, never skipped (M2)"
else
  bad "a plan with no status line was silently archived" "$OUT"
fi
cp "$BACKUP" "$VICTIM"

echo "=== 3. RESTORE — byte-identical, and the sweep reports the baseline again ==="
AFTER_SHA="$(shasum -a 256 "$VICTIM" | cut -d' ' -f1)"
[ "$BEFORE_SHA" = "$AFTER_SHA" ] && ok "victim restored byte-identical" || bad "RESTORE FAILED ($BEFORE_SHA -> $AFTER_SHA)"
OUT="$(bash "$SWEEP" 2>&1)"
[ "$(scanned "$OUT")" = "$B_SCAN" ] && [ "$(archived "$OUT")" = "$B_ARCH" ] \
  && ok "denominators back to $B_SCAN / $B_ARCH" \
  || bad "denominators did not return"

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# live-fire-foreign-sweep-guard.sh — attack the REAL guard in the REAL tree (CR-72).
#
# A mutation test that has never been mutated is a regression test in disguise, and a
# regression test cannot find a FALSE NEGATIVE. This plants each defect the guard exists to
# prevent INTO scripts/lib/foreign-sweep-guard.sh, runs the REAL mutation test, and demands
# it go RED **for that defect's own declared reason** — a RED for the wrong reason proves
# nothing about the check that was supposed to fire (G28/CR-91).
#
# PROVE BEFORE YOU DESTROY: the helper is snapshotted by sha256 and restored after every
# plant, and the restore is ASSERTED byte-identical — including when the helper is dirty, in
# which case the snapshot (not `git checkout`) is the recovery path and the run says so.
#
# PAYLOAD SAFETY (G25/CR-88): every plant is a text substitution in a guard's predicate. No
# plant introduces a shell metacharacter next to a destructive token, and the mutation test's
# own fixtures are `sleep`. If every guard here were disabled, nothing would be deleted.
#
# Usage: bash scripts/tests/live-fire-foreign-sweep-guard.sh
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

HELPER="scripts/lib/foreign-sweep-guard.sh"
TEST="scripts/tests/test-foreign-sweep-guard-mutation.sh"
for f in "$HELPER" "$TEST"; do
  [ -r "$f" ] || { echo "FATAL: cannot read $f (M2)" >&2; exit 2; }
done

# Another sweep planting into this tree while we plant into it would make every verdict
# below unattributable. Delegate to the very guard under test — before mutating it.
# shellcheck source=scripts/lib/foreign-sweep-guard.sh
. "$REPO_ROOT/$HELPER"
assert_no_foreign_sweep "this live-fire plants into the real tree" || exit 2

# PROVE BEFORE YOU DESTROY — but do NOT demand a clean tree. The snapshot below is of the
# WORKING TREE, so restoration is provable (sha256, asserted) whether or not the file is
# committed. An earlier draft refused on a dirty helper and created a stack with no legal
# ordering: validating the fix required committing it, and committing it required the
# validation. That is the CR-72 brick direction, and a brick gets bypassed — the same trap as
# the dirty-plant-target abort (incidents/2026-07-28-adjudicator-was-one-shot.md, G26/CR-89).
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fsg-livefire.XXXXXX")" || exit 2
PRISTINE="$SCRATCH/pristine.sh"
cp "$HELPER" "$PRISTINE"
SHA_BEFORE="$(shasum -a 256 < "$HELPER" | awk '{print $1}')"
# State WHICH bytes we will restore to, so an interrupted run has an unambiguous recovery
# path. When the file is dirty, `git checkout --` is the WRONG recovery: it would discard
# uncommitted work. Say so up front rather than in a footnote nobody reads mid-incident.
if git diff --quiet -- "$HELPER" && git diff --cached --quiet -- "$HELPER"; then
  echo "   restore source: the working tree copy (identical to HEAD)"
else
  echo "   ${YELLOW}NOTE${NC}: $HELPER has UNCOMMITTED changes. They are snapshotted at"
  echo "         $PRISTINE and restored byte-for-byte. If this run is killed, recover with"
  echo "         'cp $PRISTINE $HELPER' — NOT 'git checkout --', which would discard them."
fi

restore() {
  cp "$PRISTINE" "$HELPER"
  local now
  now="$(shasum -a 256 < "$HELPER" | awk '{print $1}')"
  if [ "$now" != "$SHA_BEFORE" ]; then
    echo "${RED}FATAL${NC}: restore of $HELPER did NOT return it byte-identical." >&2
    echo "        expected $SHA_BEFORE" >&2
    echo "        actual   $now" >&2
    echo "        Recover with: cp $PRISTINE $HELPER" >&2
    return 1
  fi
  return 0
}
# NAMED FUNCTIONS, never an inline trap STRING that chains a restore into a recursive delete.
#
# A trap body is a string the shell EVALUATES, so a metacharacter sitting beside a destructive
# token inside one literal is precisely the shape that wiped a home directory on this machine
# on 2026-07-24/25 (G25/CR-88): under a mutation plant that enables a shell, the literal
# executes. The payload-safety gate caught this exact line in THIS file and BLOCKED the
# public-mirror sync — the guard doing its job on work written in the same session.
#
# A function body is CODE, not a literal, so there is no string left for a plant to
# re-interpret. The sibling test-foreign-sweep-guard-mutation.sh already used this form.
_cleanup_restore_and_scratch() { restore; rm -rf "$SCRATCH"; }
_cleanup_scratch_only()        { rm -rf "$SCRATCH"; }
trap _cleanup_restore_and_scratch EXIT INT TERM

PROVEN=0; UNPROVEN=0

# $1 = label, $2 = python mutation program (edits $HELPER in place),
# $3 = ERE the test output MUST match for the RED to be attributable to THIS defect.
plant_and_demand_red() {
  local label="$1" prog="$2" expect="$3" out rc
  cp "$PRISTINE" "$HELPER"
  if ! python3 - "$HELPER" <<PY
import sys
p = sys.argv[1]
src = open(p).read()
$prog
open(p, "w").write(src)
PY
  then
    echo "  ${RED}UNPROVEN${NC} $label — the plant program itself failed"
    UNPROVEN=$((UNPROVEN + 1)); return
  fi
  # The plant must actually CHANGE the file. A no-op substitution would make the RED (or the
  # GREEN) unattributable — this is the "prove the plant is not vacuous" control.
  if cmp -s "$HELPER" "$PRISTINE"; then
    echo "  ${RED}UNPROVEN${NC} $label — plant was a NO-OP (the anchor text no longer exists)"
    UNPROVEN=$((UNPROVEN + 1)); return
  fi
  out="$(bash "$TEST" 2>&1)"; rc=$?
  out="$(printf '%s' "$out" | sed -E $'s/\033\\[[0-9;]*m//g')"
  if [ "$rc" -eq 0 ]; then
    echo "  ${RED}UNPROVEN${NC} $label — the test STAYED GREEN on a planted defect: DECORATION"
    UNPROVEN=$((UNPROVEN + 1))
  elif printf '%s' "$out" | grep -qE "$expect"; then
    echo "  ${GREEN}RED${NC}      $label (exit $rc, for its own reason)"
    PROVEN=$((PROVEN + 1))
  else
    echo "  ${YELLOW}UNPROVEN${NC} $label — went RED (exit $rc) but NOT for its declared reason."
    echo "           expected to match: $expect"
    printf '%s\n' "$out" | grep -E '^  (OK|FAIL)' | sed 's/^/           /'
    UNPROVEN=$((UNPROVEN + 1))
  fi
}

echo "── live fire: foreign-sweep-guard (real tree, real test) ──"
echo "   helper sha256 before: $SHA_BEFORE"
echo

# CONTROL — the test must PASS on the pristine helper, or every RED below is meaningless
# and the guard is a brick rather than a guard (CR-72: prove it OPENS on a genuine pass).
if bash "$TEST" >"$SCRATCH/control.txt" 2>&1; then
  echo "  ${GREEN}OK${NC}       CONTROL: the test passes on the pristine helper"
  PROVEN=$((PROVEN + 1))
else
  echo "  ${RED}UNPROVEN${NC} CONTROL: the test FAILS on the pristine helper — fix that first"
  sed -E $'s/\033\\[[0-9;]*m//g' "$SCRATCH/control.txt" | sed 's/^/           /'
  UNPROVEN=$((UNPROVEN + 1))
fi
echo

# ── DEFECT 2, the one this fix closes: drop the DESCENDANT exclusion ─────────────────────
plant_and_demand_red "descendant exclusion removed (CI 30493858521)" \
  'src = src.replace("    if self_pid in chain(pid):\n        continue", "    if False:\n        continue")' \
  'FAIL OWN DESCENDANT -> REFUSED'

# ── DEFECT 1, the previous fix: drop the ANCESTOR exclusion ──────────────────────────────
plant_and_demand_red "ancestor exclusion removed (CI 30428800020)" \
  'src = src.replace("    if pid in mine:\n        continue", "    if False:\n        continue")' \
  'FAIL OWN ANCESTOR -> REFUSED'

# ── THE BRICK DIRECTION: never refuse at all ─────────────────────────────────────────────
# The trap the handoff warned about explicitly: "widening the guard to never refuse" would
# make Anti-Vacuity green while re-opening the 2026-07-27 contamination. This proves the test
# catches that, so the easy wrong fix cannot pass.
plant_and_demand_red "guard never refuses (the widen-to-green trap)" \
  'src = src.replace("    foreign.append(pid)", "    pass")' \
  'FAIL FOREIGN sweep -> PROCEEDED'

# ── M2: could-not-look must not resolve to clean. TWO independent blind paths ────────────
# Both are planted separately because a single PATH-emptying injection exercises only one of
# them, which is how the FSG-ERROR branch sat untested while looking covered.
# Anchored by INDEX from each branch's unique message, then the FIRST `return 2` after it.
# Multi-line literal anchors were tried first and are too brittle to reflow to be trusted:
# a no-op plant is silently unattributable, which the non-vacuity control catches but only
# after wasting the run.
plant_and_demand_red "FSG-ERROR branch reports CLEAN (blind gate: ps failed)" \
  'i = src.index("cannot determine whether a foreign sweep is running"); j = src.index("return 2 ;;", i); src = src[:j] + "return 0 ;;" + src[j+len("return 2 ;;"):]' \
  'FAIL M2 \[ps fails\]: could not look and reported CLEAN'

plant_and_demand_red "missing-denominator branch reports CLEAN (blind gate: no python3)" \
  'i = src.index("produced no denominator"); j = src.index("return 2 ;;", i); src = src[:j] + "return 0 ;;" + src[j+len("return 2 ;;"):]' \
  'FAIL M2 \[python3 absent\]: could not look and reported CLEAN'

# ── The ancestor fixture must be a STRICT ancestor, not self ──────────────────────────────
# Guards the vacuity that live fire caught: if the matching process is the asserting process
# itself, the descendant rule covers it and the ancestor rule is never exercised. Deleting the
# ancestor exclusion must therefore be caught by case 3, which is asserted above; this plant
# instead breaks the ancestry WALK, so `mine` collapses to self alone.
plant_and_demand_red "ancestry walk truncated to self (mine = {self})" \
  'src = src.replace("mine_chain = chain(self_pid)", "mine_chain = [self_pid]")' \
  'FAIL OWN ANCESTOR -> REFUSED'

# ── M1: a refusal that names nothing ─────────────────────────────────────────────────────
plant_and_demand_red "refusal stops naming the denominator (M1)" \
  'src = src.replace("  echo \"       processes scanned: $scanned\" >&2\n", "")' \
  'FAIL refusal reports no denominator'

echo
if ! restore; then exit 2; fi
trap _cleanup_scratch_only EXIT INT TERM   # bash REPLACES the EXIT trap; restore already ran
echo "   helper sha256 after restore: $(shasum -a 256 < "$HELPER" | awk '{print $1}')"
if cmp -s "$HELPER" "$PRISTINE"; then
  echo "  ${GREEN}OK${NC}       tree restored: byte-identical to the pre-run snapshot"
  PROVEN=$((PROVEN + 1))
else
  echo "  ${RED}FATAL${NC}: $HELPER is still modified after restore." >&2
  UNPROVEN=$((UNPROVEN + 1))
fi

echo
echo "══ proven: $PROVEN   unproven: $UNPROVEN ══"
if [ "$UNPROVEN" -ne 0 ]; then
  echo "${RED}FAIL${NC}: $UNPROVEN check(s) did not fire. The mutation test is decoration in"
  echo "      exactly the proportion that is unproven."
  exit 1
fi
echo "${GREEN}PASS${NC}: every planted defect drove the mutation test RED for its own reason."

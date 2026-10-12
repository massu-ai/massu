#!/usr/bin/env bash
# live-fire-pushed-range.sh — attack the received-range resolver IN THE REAL TREE (CR-72).
#
# SUBJECT: scripts/lib/pushed-range.sh + its consumer scripts/massu-incident-coverage.sh.
#
# THE PROPERTY UNDER ATTACK: the CR-62 gate scans what the push DELIVERS, and when that
# cannot be determined it REFUSES. Both halves matter, and the second is the one the old
# code got wrong — it substituted `HEAD~1..HEAD`, so "I could not tell" arrived wearing
# the clothes of "here is the range".
#
# Each plant must produce RED FOR ITS OWN DECLARED REASON — not merely a non-zero exit.
# A positive control that reaches a different branch than the one it names proves nothing
# (memory `a-positive-control-must-reach-the-branch-it-names`).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 2
# shellcheck source-path=SCRIPTDIR/../lib source=git-env-scrub.sh
. "$REPO/scripts/lib/git-env-scrub.sh" || { echo "cannot source git-env-scrub.sh" >&2; exit 2; }
git_bind_or_die || exit 2

LIB="scripts/lib/pushed-range.sh"
GATE="scripts/massu-incident-coverage.sh"
TEST="scripts/tests/test-pushed-range.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }

SCRATCH="${LIVE_FIRE_SCRATCH:-${TMPDIR:-/tmp}}/live-fire-pushed-range-$$"
mkdir -p "$SCRATCH" || exit 2
for f in "$LIB" "$GATE"; do
  mkdir -p "$SCRATCH/$(dirname "$f")"
  cp "$f" "$SCRATCH/$f"
done
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
LIB_SHA="$(sha "$LIB")"; GATE_SHA="$(sha "$GATE")"
restore() { cp "$SCRATCH/$LIB" "$LIB"; cp "$SCRATCH/$GATE" "$GATE"; }
trap 'restore; rm -rf "$SCRATCH"' EXIT INT TERM

# A base that is ALWAYS several commits behind HEAD, derived from HEAD's own ancestry.
# The first draft used `origin/main`, which happened to be 8 commits behind on the branch
# where this was written and is 0 commits behind on a branch freshly cut from it — so the
# baseline silently became a zero-commit range and the harness failed about ITSELF.
HEADS="$(git rev-parse HEAD)"
BASE="$(git rev-parse --verify --quiet "HEAD~3")" || BASE=""
if [ -z "$BASE" ]; then
  echo "live-fire-pushed-range: FATAL — need at least 3 ancestors of HEAD to build a" >&2
  echo "  multi-commit baseline. Refusing: a one-commit baseline cannot distinguish this" >&2
  echo "  fix from the defect it replaces." >&2
  exit 2
fi
REFLINE="refs/heads/probe $HEADS refs/heads/probe $BASE"

# ── BASELINE: the gate must OPEN, and must name the AUTHORITATIVE source. A gate that is
#    red before the attack cannot prove anything about the attack (a brick gets disabled).
BASE_OUT="$(MASSU_PUSH_REFS="$REFLINE" bash "$GATE" 2>&1)"; BASE_RC=$?
if [ "$BASE_RC" -eq 0 ] && grep -q 'refs:update' <<< "$BASE_OUT"; then
  ok "baseline: gate OPENS and resolves from the ref lines (refs:update)"
else
  bad "baseline: rc=$BASE_RC — attacking from a red baseline proves nothing"
  echo "$BASE_OUT" | tail -4
fi
BASE_N="$(printf '%s' "$BASE_OUT" | sed -n 's/.*scanned \([0-9]*\) commit(s).*/\1/p')"
[ -n "$BASE_N" ] && [ "$BASE_N" -gt 1 ] \
  && ok "baseline scans $BASE_N commit(s) — more than the one HEAD~1..HEAD would give" \
  || bad "baseline commit count unreadable or 1: '$BASE_N'"

# ── PLANT 1 — make the resolver IGNORE the ref lines git handed it.
#    Declared reason: the authoritative branch must be the one actually taken.
python3 - "$LIB" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding="utf-8").read()
old='  if [ -n "${MASSU_PUSH_REFS:-}" ]; then'
assert s.count(old)==1, f"anchor x{s.count(old)}"
io.open(p,"w",encoding="utf-8").write(s.replace(old,'  if false; then  # AV-PLANT-1',1))
PY
[ "$(sha "$LIB")" != "$LIB_SHA" ] && ok "P1 negative control: the plant changed $LIB" \
                                  || bad "P1 negative control: nothing changed"
OUT="$(MASSU_PUSH_REFS="$REFLINE" bash "$GATE" 2>&1)"
if grep -q 'refs:update' <<< "$OUT"; then
  bad "P1: the gate still reported refs:update — the ref-line branch is NOT load-bearing"
else
  ok "P1: ignoring the ref lines changes the resolved source (no longer refs:update)"
fi
restore

# ── PLANT 2 — restore the old behaviour: invent a range instead of refusing.
#    Declared reason: the self-test's refusal case must go RED naming that case.
python3 - "$LIB" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding="utf-8").read()
old='''  echo "pushed-range: cannot determine what this push delivers." >&2'''
assert s.count(old)==1, f"anchor x{s.count(old)}"
new='''  printf 'guessed\\t%s\\t%s\\n' "$(git rev-parse HEAD~1)" "$head_oid"; return 0  # AV-PLANT-2
  echo "pushed-range: cannot determine what this push delivers." >&2'''
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
PY
[ "$(sha "$LIB")" != "$LIB_SHA" ] && ok "P2 negative control: the plant changed $LIB" \
                                  || bad "P2 negative control: nothing changed"
OUT="$(bash "$TEST" 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'FAIL  the refusal branch:' <<< "$OUT"; then
  ok "P2: re-inventing a range goes RED on the refusal case, by name"
else
  bad "P2: rc=$RC — the refusal is not actually asserted. tail: $(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')"
fi
restore

# ── PLANT 3 — break the library's path in the gate.
#    Declared reason: a gate whose resolver is missing must exit 2, never fall back.
python3 - "$GATE" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding="utf-8").read()
old='if ! . "$REPO_ROOT/scripts/lib/pushed-range.sh"; then'
assert s.count(old)==1, f"anchor x{s.count(old)}"
io.open(p,"w",encoding="utf-8").write(
    s.replace(old,'if ! . "$REPO_ROOT/scripts/lib/pushed-range-AV-PLANT-3.sh" 2>/dev/null; then',1))
PY
[ "$(sha "$GATE")" != "$GATE_SHA" ] && ok "P3 negative control: the plant changed $GATE" \
                                    || bad "P3 negative control: nothing changed"
OUT="$(MASSU_PUSH_REFS="$REFLINE" bash "$GATE" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'cannot source scripts/lib/pushed-range.sh' <<< "$OUT"; then
  ok "P3: a missing resolver exits 2 naming it, rather than guessing"
else
  bad "P3: rc=$RC out='$(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')'"
fi
restore

# ── RESTORE proven byte-identical, and the gate must OPEN again.
trap - EXIT INT TERM
restore
if [ "$(sha "$LIB")" = "$LIB_SHA" ] && [ "$(sha "$GATE")" = "$GATE_SHA" ]; then
  ok "restore byte-identical (lib $LIB_SHA)"
else
  bad "restore DRIFTED"
fi
OUT="$(MASSU_PUSH_REFS="$REFLINE" bash "$GATE" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "gate OPENS again on the clean tree" || bad "still failing after restore: rc=$RC"
OUT="$(bash "$TEST" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "self-test green again on the clean tree" || bad "self-test still red: rc=$RC"
rm -rf "$SCRATCH"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, demand RED for its OWN declared
# reason, restore, prove byte-identical, and prove the gate still OPENS.
#
# SUBJECT: scripts/check-plan-gates.sh — the discovery that replaced its own hand-maintained
# GATES=() roster (G32). A discovery mechanism fails SILENTLY and in the PASSING direction:
# it returns fewer rows and still prints "all N gates PASS", which is what a healthy run
# prints too. That is the only failure mode worth attacking, and a fixture cannot reproduce
# it — the candidate set IS the real tree.
#
# ⚠️ THIS FILE IS THE REASON THE PREDICATE IS HEADER-SCOPED. Its first version carried the
# declaration marker at column 0 inside the heredoc that writes a planted gate. Discovery
# matched THIS FILE, ran it, and it ran discovery: 69 mutually-recursive processes before it
# was killed. Every marker below is therefore deliberately mid-file — and that is now SAFE BY
# CONSTRUCTION rather than by care, because only a file's HEADER BLOCK can declare a gate.
# Check 1 pins that property so it cannot regress. See G25: a test payload must be inert
# under the mechanism it tests.
#
# COST: discovery attacks run against `--list`, which executes nothing and returns instantly.
# Only the two checks that genuinely need execution (a planted gate's RED is reported; a
# clean tree still OPENS) pay the ~44s corpus run. Attacking a predicate must not cost a
# full scan per probe (G31).
set -uo pipefail
# G29: never inherit a caller's git environment. This script is NOT hook-reachable and
# never reads `git diff --cached`, so the full neutralisation is the correct primitive here
# rather than the bind-or-die one (G29 amendment, 2026-08-05).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# The runner refuses to re-enter itself; this harness is not "inside" a run.
unset MASSU_PLAN_GATE_RUNNING

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

GATE="scripts/check-plan-gates.sh"
PLAN="${1:-docs/plans/2026-09-20-stack-conformant-asset-rendering.md}"
VICTIM="scripts/lint-plan-structure.mjs"   # a declared gate; its marker is altered below
PLANTED_GATE="scripts/zz-live-fire-planted-gate.sh"
PLANTED_PY="scripts/zz-live-fire-planted-gate.py"
PLANTED_MID="scripts/zz-live-fire-midfile-marker.sh"

[ -f "$GATE" ]   || { echo "FATAL: $GATE not found" >&2; exit 2; }
[ -f "$PLAN" ]   || { echo "FATAL: plan not found: $PLAN" >&2; exit 2; }
[ -f "$VICTIM" ] || { echo "FATAL: $VICTIM not found" >&2; exit 2; }
for p in "$PLANTED_GATE" "$PLANTED_PY" "$PLANTED_MID"; do
  [ -e "$p" ] && { echo "FATAL: $p already exists — refusing to clobber" >&2; exit 2; }
done

# The marker token is assembled at RUNTIME so that no line of this file, anywhere, is a
# literal declaration. Belt and braces with the header-block predicate: the predicate is the
# control, this is the second lock on the thing that already cost 69 processes.
M='massu-plan'"-gate"

# RESTORE FROM THE BYTES WE SAW, NOT FROM GIT (CR-70 — never discard uncommitted work).
BEFORE_SHA="$(shasum -a 256 "$VICTIM" | cut -d' ' -f1)"
BACKUP="$(mktemp)" || exit 2
cp "$VICTIM" "$BACKUP" || { echo "FATAL: could not back up $VICTIM" >&2; exit 2; }
cleanup() { cp "$BACKUP" "$VICTIM" 2>/dev/null; rm -f "$BACKUP" "$PLANTED_GATE" "$PLANTED_PY" "$PLANTED_MID"; }
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()   { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/        /' | tail -12; FAIL=$((FAIL+1)); }
list() { OUT="$(bash "$GATE" --list 2>&1)"; RC=$?; }
full() { OUT="$(bash "$GATE" "$PLAN" 2>&1)"; RC=$?; }
denom(){ printf '%s' "$OUT" | sed -n 's/^GATES REGISTERED (denominator): //p'; }

echo "=== 0. BASELINE (--list) — discovery must find the real gates ==="
list
BASE_N="$(denom)"
if [ "$RC" -eq 0 ] && [ -n "$BASE_N" ] && [ "$BASE_N" -gt 0 ] 2>/dev/null; then
  ok "--list returns rc=0 with denominator $BASE_N"
else
  bad "--list did not produce a usable denominator (rc=$RC)" "$OUT"; exit 1
fi

echo "=== 1. REGRESSION: a marker OUTSIDE the header block must NOT declare a gate ==="
# THE 2026-09-20 RECURSION, pinned. A harness, fixture or heredoc that merely CONTAINS the
# marker text is not a gate. If this check goes red, the predicate has reverted to a
# whole-file grep and the runner can be made to invoke its own attacker without bound.
{ printf '#!/usr/bin/env bash\n'
  printf '# a genuine header comment that declares nothing\n'
  printf 'set -euo pipefail\n'
  printf 'cat <<PGEOF\n'
  printf '# %s: corpus | midfile marker that must be ignored\n' "$M"
  printf 'PGEOF\n'; } > "$PLANTED_MID"
grep -q "^# ${M}:" "$PLANTED_MID" || { echo "  PLANT FAILED: mid-file marker not written" >&2; exit 1; }
list
if [ "$(denom)" = "$BASE_N" ] && ! printf '%s' "$OUT" | grep -qF 'midfile marker'; then
  ok "mid-file marker ignored; denominator unchanged at $BASE_N (no self-invocation path)"
else
  bad "a mid-file marker was treated as a declaration — the recursion is back" "$OUT"
fi
rm -f "$PLANTED_MID"

echo "=== 2. CYCLE BREAKER: re-entry from inside a gate run must be refused ==="
OUT="$(MASSU_PLAN_GATE_RUNNING=1 bash "$GATE" --list 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -qF 're-entered from inside a gate run'; then
  ok "re-entry -> exit 2, named"
else
  bad "the cycle breaker did not fire (rc=$RC)" "$OUT"
fi

echo "=== 3. PLANT: a gate stops declaring itself (the SILENT under-count) ==="
perl -0pi -e "s{^// ${M}:.*\n}{}m" "$VICTIM"
grep -q "^// ${M}:" "$VICTIM" && { echo "  PLANT FAILED: marker still present — refusing to claim a proof" >&2; exit 1; }
list
if [ "$(denom)" = "$((BASE_N - 1))" ]; then
  ok "the loss is VISIBLE in the denominator ($BASE_N -> $(denom)), not hidden behind a green summary"
else
  bad "denominator did not move as expected: $BASE_N -> $(denom)" "$OUT"
fi
cp "$BACKUP" "$VICTIM"

echo "=== 4. PLANT: an unrecognised SCOPE must be an ERROR, never a skipped row (G3) ==="
perl -0pi -e "s{^// ${M}: plan \|}{// ${M}: korpus |}m" "$VICTIM"
grep -q 'korpus' "$VICTIM" || { echo "  PLANT FAILED: scope not altered" >&2; exit 1; }
list
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -qF "unrecognised scope 'korpus'"; then
  ok "unrecognised scope -> exit 2, naming the offender"
else bad "closed vocabulary did not fire (rc=$RC)" "$OUT"; fi
cp "$BACKUP" "$VICTIM"

echo "=== 5. PLANT: a declaration with NO LABEL must be an ERROR ==="
perl -0pi -e "s{^// ${M}: plan \|.*\$}{// ${M}: plan |}m" "$VICTIM"
list
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -qF 'declares no label'; then
  ok "empty label -> exit 2"
else bad "empty label was accepted (rc=$RC)" "$OUT"; fi
cp "$BACKUP" "$VICTIM"

echo "=== 6. PLANT: an extension with no known runner must be an ERROR (closed vocabulary) ==="
{ printf '#!/usr/bin/env python3\n'; printf '# %s: corpus | unrunnable extension\n' "$M"; } > "$PLANTED_PY"
list
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -qF 'no runner for'; then
  ok "unknown extension -> exit 2"
else bad "unknown extension was accepted (rc=$RC)" "$OUT"; fi
rm -f "$PLANTED_PY"

echo "=== 7. EXECUTION: a NEW self-declaring gate is run, counted, and its RED reported ==="
# The G32 property, end to end: no roster was edited. This is one of the two checks that
# genuinely needs execution, so it pays the full corpus run.
{ printf '#!/usr/bin/env bash\n'
  printf '# %s: corpus | live-fire planted gate\n' "$M"
  printf '# Planted by scripts/ops/live-fire-plan-gate-discovery.sh. If this file survives a\n'
  printf '# run, that harness crashed — delete it. It exits 1 on purpose and touches nothing.\n'
  printf 'echo "planted gate: deliberately failing"\n'
  printf 'exit 1\n'; } > "$PLANTED_GATE"
full
if [ "$RC" -eq 1 ] \
   && printf '%s' "$OUT" | grep -qF 'live-fire planted gate' \
   && [ "$(denom)" = "$((BASE_N + 1))" ]; then
  ok "discovered without any roster edit, counted in the denominator, and its RED is reported"
else
  bad "a self-declaring new gate was not picked up or its RED was swallowed (rc=$RC)" "$OUT"
fi
rm -f "$PLANTED_GATE"

echo "=== 8. RESTORE — byte-identical, and the gate OPENS again (a brick gets disabled) ==="
AFTER_SHA="$(shasum -a 256 "$VICTIM" | cut -d' ' -f1)"
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then ok "$VICTIM restored byte-identical ($AFTER_SHA)"
else bad "RESTORE FAILED: $BEFORE_SHA -> $AFTER_SHA"; fi
for p in "$PLANTED_GATE" "$PLANTED_PY" "$PLANTED_MID"; do
  [ -e "$p" ] && bad "planted file still on disk: $p"
done
full
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qF 'RESULT: all'; then
  ok "post-restore: every gate executes and OPENS"
else bad "post-restore run is not green (rc=$RC)" "$OUT"; fi
if [ "$(denom)" = "$BASE_N" ]; then ok "denominator back to $BASE_N"
else bad "denominator did not return to $BASE_N"; fi

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

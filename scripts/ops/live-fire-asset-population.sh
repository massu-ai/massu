#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, run the REAL gate, demand RED for its
# own declared reason, restore, prove byte-identical, and prove the gate still OPENS.
#
# SUBJECT: the asset POPULATION — `install-commands.ts`'s `entry === 'README.md'` skip and
# the matching `! -name README.md` in `scripts/measure-asset-conformance.sh`.
#
# WHY THIS EXISTS. `packages/core/commands/README.md` is corpus front matter — it documents
# what the directory ships — but it was in the RENDERED asset population. Because it
# documents the templating syntax it carries a literal `{{variable.path}}` at line 115, the
# renderer tried to resolve it, threw `MissingVariableError`, and `install-commands.ts`
# caught it into `stats.skipped++` plus one stderr line and exited 0.
#
# So it was SILENTLY DROPPED on every stack since `{{...}}` rendering shipped in 1.3.0, and
# nothing reported it. An asset absent while the install reports success is the exact
# failure this plan exists to end — and it was sitting inside the asset corpus itself.
#
# Its line 119 documents the `\{{` escape that its own examples on 115/118 do not use: the
# documentation of the escape hatch is what the missing escape hatch broke.
#
# ⛔ NO `rm -rf` AND NO INTERPOLATED DELETE PATH (G17). Nothing here deletes.
set -uo pipefail
# G29: never inherit a caller's git environment. Not hook-reachable; never reads the index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

INSTALLER="packages/core/src/commands/install-commands.ts"
MEASURE="scripts/measure-asset-conformance.sh"
TEST_REL="src/__tests__/stack-asset-conformance.test.ts"
TEST_NAME="installs with skipped === 0"

for f in "$INSTALLER" "$MEASURE" "packages/core/$TEST_REL"; do
  [ -f "$f" ] || { echo "FATAL: missing $f" >&2; exit 2; }
done

# RESTORE FROM THE BYTES WE SAW, NOT FROM GIT (CR-70 — never discard uncommitted work).
I_SHA="$(shasum -a 256 "$INSTALLER" | cut -d' ' -f1)"
M_SHA="$(shasum -a 256 "$MEASURE" | cut -d' ' -f1)"
I_BAK="$(mktemp)"; M_BAK="$(mktemp)"
cp "$INSTALLER" "$I_BAK" || exit 2
cp "$MEASURE" "$M_BAK" || exit 2
cleanup() { cp "$I_BAK" "$INSTALLER" 2>/dev/null; cp "$M_BAK" "$MEASURE" 2>/dev/null; rm -f "$I_BAK" "$M_BAK"; }
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -10; FAIL=$((FAIL+1)); }

# Run ONLY the per-stack skipped assertion, so a RED here can only mean the population
# changed — never the unrelated token violations this gate also carries.
run_skip_gate() { OUT="$(cd packages/core && npx vitest run "$TEST_REL" -t "$TEST_NAME" 2>&1)"; RC=$?; }
run_measure()   { MOUT="$(bash "$MEASURE" --json 2>&1)"; MRC=$?; }

echo "=== 0. BASELINE — the population is clean on all 13 stacks (a brick gets disabled) ==="
run_skip_gate
if [ "$RC" -eq 0 ]; then ok "skipped === 0 on every shipped stack"; else bad "gate is RED before any plant" "$OUT"; exit 1; fi
run_measure
BASE_ASSETS="$(printf '%s' "$MOUT" | sed -n 's/.*"assets": \([0-9]*\).*/\1/p')"
if [ "$MRC" -eq 0 ] && [ -n "$BASE_ASSETS" ]; then ok "measurement OPENS, assets=$BASE_ASSETS"; else bad "measurement did not open" "$MOUT"; exit 1; fi

echo "=== 1. PLANT: put the corpus README back into the RENDERED population ==="
# The exact defect: a file documenting `{{...}}` re-enters the render path.
perl -0pi -e "s{^\\s*if \\(entry === 'README\\.md'\\) continue;\\n}{}m" "$INSTALLER"
if grep -q "entry === 'README.md'" "$INSTALLER"; then
  echo "  PLANT FAILED: the skip is still present — refusing to claim a proof" >&2; exit 1
fi
run_skip_gate
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF 'silently dropped'; then
  ok "README back in the population -> RED, naming the silent drop"
else
  bad "the silent drop was NOT caught (rc=$RC)" "$OUT"
fi
cp "$I_BAK" "$INSTALLER"

echo "=== 2. PLANT: the MEASUREMENT's population drifts from the installer's ==="
# A denominator that counts a file the product never renders is measuring a corpus nobody
# ships. The two populations must move together (CR-74).
perl -0pi -e "s{ ! -name 'README\\.md'}{}" "$MEASURE"
if grep -q "! -name 'README.md'" "$MEASURE"; then
  echo "  PLANT FAILED: the measure filter is still present" >&2; exit 1
fi
run_measure
NOW_ASSETS="$(printf '%s' "$MOUT" | sed -n 's/.*"assets": \([0-9]*\).*/\1/p')"
if [ "$NOW_ASSETS" = "$((BASE_ASSETS + 1))" ]; then
  ok "the drift is VISIBLE in the denominator ($BASE_ASSETS -> $NOW_ASSETS), not hidden"
else
  bad "denominator did not move as expected: $BASE_ASSETS -> ${NOW_ASSETS:-?}" "$MOUT"
fi
cp "$M_BAK" "$MEASURE"

echo "=== 3. RESTORE — byte-identical, and both instruments OPEN again ==="
I_SHA2="$(shasum -a 256 "$INSTALLER" | cut -d' ' -f1)"
M_SHA2="$(shasum -a 256 "$MEASURE" | cut -d' ' -f1)"
[ "$I_SHA" = "$I_SHA2" ] && ok "installer restored byte-identical" || bad "installer NOT restored ($I_SHA -> $I_SHA2)"
[ "$M_SHA" = "$M_SHA2" ] && ok "measure script restored byte-identical" || bad "measure script NOT restored ($M_SHA -> $M_SHA2)"
run_skip_gate
[ "$RC" -eq 0 ] && ok "post-restore: the population gate OPENS" || bad "post-restore gate is RED" "$OUT"
run_measure
NOW_ASSETS="$(printf '%s' "$MOUT" | sed -n 's/.*"assets": \([0-9]*\).*/\1/p')"
[ "$NOW_ASSETS" = "$BASE_ASSETS" ] && ok "denominator back to $BASE_ASSETS" || bad "denominator did not return to $BASE_ASSETS"

echo "----"
echo "live-fire: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

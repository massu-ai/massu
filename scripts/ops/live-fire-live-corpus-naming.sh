#!/usr/bin/env bash
#
# Attack the repaired live-corpus check (CR-72).
#
# The change's whole claim is that a skipped file is NAMED rather than reduced to a count.
# So plant a real skip in the REAL indexer, demand the test go RED, and demand the message
# contain the planted path. A restore is proven byte-identical by sha256.
#
set -uo pipefail

# Derive the repo from THIS script's own location — never from $HOME. A path built under
# the real home has no seam a test can redirect, which is how d76ab2c8 wrote six fixture
# directories into the live memory store. The repo's homedir-injectability guard caught
# exactly that in the first draft of this file.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE="$REPO/packages/core"
IDX="$CORE/src/knowledge-indexer.ts"
SCRATCH="${ATTACK_SCRATCH:-${TMPDIR:-/tmp}}/attack-d8-$$"
mkdir -p "$SCRATCH"
BACKUP="$SCRATCH/knowledge-indexer.ts.orig"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }

cp "$IDX" "$BACKUP"
ORIG_SHA="$(shasum -a 256 "$IDX" | awk '{print $1}')"
restore() { [ -f "$BACKUP" ] && cp "$BACKUP" "$IDX"; }
trap restore EXIT

# The victim: a real, stable file in the corpus that discovery finds.
VICTIM="$(cd "$REPO" && find docs/incidents -name '*.md' | LC_ALL=C sort | head -1)"
VICTIM_BASE="$(basename "$VICTIM")"
echo "subject : $IDX"
echo "victim  : $VICTIM_BASE"
echo

# ---- PLANT: drop exactly one discoverable file, the way a real regression would.
python3 - "$IDX" "$VICTIM_BASE" <<'PY'
import sys, io
p, victim = sys.argv[1], sys.argv[2]
s = io.open(p, encoding="utf-8").read()
old = "    for (const filePath of files) {\n      if (!existsSync(filePath)) continue;\n"
assert s.count(old) == 1, f"anchor found {s.count(old)} times"
new = ("    for (const filePath of files) {\n"
       "      if (!existsSync(filePath)) continue;\n"
       f"      if (filePath.endsWith({victim!r})) continue; // ATTACK-PLANT\n")
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("planted")
PY

PLANTED_SHA="$(shasum -a 256 "$IDX" | awk '{print $1}')"
if [ "$PLANTED_SHA" != "$ORIG_SHA" ]; then
  ok "negative control: the plant changed the indexer"
else
  bad "negative control: the plant changed NOTHING — any RED below is meaningless"
fi

# ---- The test must go RED, and must NAME the file.
cd "$CORE" || exit 2
OUT="$(npm test -- knowledge-live-corpus 2>&1)"
RC=$?

if [ "$RC" -ne 0 ]; then ok "planted run FAILS (exit $RC)"; else bad "planted run PASSED — the check is decoration"; fi
if printf '%s' "$OUT" | grep -q 'the indexer skipped'; then
  ok "RED names the property: 'the indexer skipped N discoverable file(s)'"
else
  bad "RED did not name the property; tail: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi
if printf '%s' "$OUT" | grep -q "$VICTIM_BASE"; then
  ok "RED names the FILE itself ($VICTIM_BASE) — the point of the change"
else
  bad "RED did not name the planted file — it is still just a count"
fi
echo

# ---- RESTORE and prove it.
restore
trap - EXIT
NOW_SHA="$(shasum -a 256 "$IDX" | awk '{print $1}')"
if [ "$NOW_SHA" = "$ORIG_SHA" ]; then
  ok "restore byte-identical ($ORIG_SHA)"
else
  bad "restore DRIFTED: $ORIG_SHA -> $NOW_SHA"
fi

npm test -- knowledge-live-corpus >/dev/null 2>&1
RC2=$?
if [ "$RC2" -eq 0 ]; then ok "gate OPENS again on the clean tree (a brick gets disabled)"; else bad "still failing after restore: exit $RC2"; fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]

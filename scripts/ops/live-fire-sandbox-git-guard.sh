#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, demand RED, restore, prove identical.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2
TARGET="scripts/tests/test_sync_public_target_guard.sh"
BEFORE_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"

# RESTORE FROM THE BYTES WE SAW, NOT FROM GIT (CR-70 — never discard uncommitted work).
# This restored with `git checkout -- "$TARGET"` until 2026-08-05, which reverts to the
# INDEX — so running it with an uncommitted edit in $TARGET silently DESTROYED that edit
# and then reported "RESTORE FAILED", because the sha it was comparing against was the
# edited one. Measured: it ate a comment correction mid-session. A live-fire harness that
# damages the tree it is proving is worse than no harness. Save the bytes, restore the
# bytes: correct whether the tree is clean, dirty, or mid-rebase.
BACKUP="$(mktemp)"
cp "$TARGET" "$BACKUP" || { echo "FATAL: could not back up $TARGET" >&2; exit 2; }
restore_target() { cp "$BACKUP" "$TARGET"; }
# Restore on ANY exit path — an interrupt or an early `exit 1` above used to leave the
# plant in the working tree.
trap 'restore_target; rm -f "$BACKUP"' EXIT INT TERM

run_guard() {  # -> 0 green, 1 red
  ( cd packages/core && npx vitest run sandbox-git-env-neutralisation >/tmp/lf.log 2>&1 )
  return $?
}

echo "=== 1. baseline: the gate must OPEN on a genuine pass (a brick gets disabled) ==="
if run_guard; then echo "  GREEN (correct)"; else echo "  FAIL: gate is RED before any plant"; exit 1; fi

echo "=== 2. PLANT: strip the neutralisation from $TARGET ==="
python3 - "$TARGET" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s2 = re.sub(r"unset GIT_DIR GIT_WORK_TREE.*?GIT_COMMON_DIR GIT_PREFIX\n", "", s, flags=re.S)
if s2 == s:
    sys.exit("PLANT FAILED: neutralisation block not found - refusing to claim a proof")
open(p, 'w').write(s2)
print("  planted (neutralisation removed)")
PY
[ $? -eq 0 ] || exit 1

echo "=== 3. the gate MUST go RED ==="
if run_guard; then
  VERDICT="DEAD"
  echo "  GREEN on a planted defect -> THE GUARD IS DECORATION"
else
  VERDICT="RED"
  echo "  RED (correct)"
  grep -oE '"scripts/tests/test_sync_public_target_guard.sh"' /tmp/lf.log | head -1 | sed 's/^/  named the file: /'
fi

echo "=== 4. RESTORE and prove byte-identical ==="
restore_target
AFTER_SHA="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
echo "  before: $BEFORE_SHA"
echo "  after : $AFTER_SHA"
[ "$BEFORE_SHA" = "$AFTER_SHA" ] && echo "  RESTORED byte-identical" || { echo "  RESTORE FAILED"; exit 1; }

echo "=== 5. gate green again ==="
run_guard && echo "  GREEN (correct)" || { echo "  still RED after restore"; exit 1; }

echo
[ "$VERDICT" = "RED" ] && { echo "LIVE-FIRE PASS: the guard detects a real planted defect and opens on a genuine pass."; exit 0; }
echo "LIVE-FIRE FAIL: the guard did not go red."; exit 1

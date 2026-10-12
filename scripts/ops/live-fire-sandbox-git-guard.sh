#!/usr/bin/env bash
# CR-72 live-fire: plant the defect in the REAL tree, demand RED FOR ITS OWN REASON, restore,
# prove byte-identical, prove GREEN again. One attack per detection family of
# packages/core/src/__tests__/sandbox-git-env-neutralisation-drift-guard.test.ts:
#
#   A1  GIT_DIR half      — strip the `unset GIT_DIR …` block from a shell harness
#   A2  template half, TS — a real fixture's init loses gitSafeEnvForNewRepo() (plain gitSafeEnv())
#   A3  template half, sh — a real harness loses its `export GIT_TEMPLATE_DIR=""`
#
# G25: every plant is INERT. The vitest recipe never executes a planted file — the guard only
# READS it — and no payload carries a destructive token or a shell metacharacter. A2 turns a
# fixture's `git init` into a plain one; A1/A3 replace a line with `:` (a shell no-op).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 2

LOG="$(mktemp)"
BACKUP="$(mktemp)"
CURRENT_TARGET=""
# RESTORE FROM THE BYTES WE SAW, NOT FROM GIT (CR-70 — never discard uncommitted work).
# This restored with `git checkout -- "$TARGET"` until 2026-08-05, which reverts to the
# INDEX — so running it with an uncommitted edit in the target silently DESTROYED that edit.
# Save the bytes, restore the bytes: correct whether the tree is clean, dirty, or mid-rebase.
restore_target() {
  if [ -n "$CURRENT_TARGET" ]; then cp "$BACKUP" "$CURRENT_TARGET"; fi
}
cleanup() {
  restore_target
  rm -f -- "$BACKUP" "$LOG"
}
# Restore on ANY exit path — an interrupt or an early exit must never leave a plant behind.
trap cleanup EXIT INT TERM

run_guard() {  # -> 0 green, non-zero red
  ( cd packages/core && npx vitest run sandbox-git-env-neutralisation >"$LOG" 2>&1 )
}

PASSED=0
FAILED=0

# attack <id> <target> <literal-to-replace> <replacement> <must-fail-test> <must-name> [<must-pass-test>]
attack() {
  local id="$1" target="$2" old="$3" new="$4" red_test="$5" named="$6" green_test="${7:-}"
  echo "=== $id: plant into $target ==="
  CURRENT_TARGET="$target"
  local before after
  before="$(shasum -a 256 "$target" | cut -d' ' -f1)"
  cp "$target" "$BACKUP" || { echo "  FATAL: could not back up $target" >&2; exit 2; }

  if ! OLD="$old" NEW="$new" python3 - "$target" <<'PY'
import os, sys
p = sys.argv[1]
s = open(p).read()
old, new = os.environ["OLD"], os.environ["NEW"]
n = s.count(old)
if n != 1:
    sys.exit(f"  PLANT FAILED: anchor found {n} times (need exactly 1) - refusing to claim a proof")
open(p, "w").write(s.replace(old, new))
print("  planted")
PY
  then
    FAILED=$((FAILED + 1))
    restore_target
    CURRENT_TARGET=""
    return
  fi

  local verdict="DEAD"
  if run_guard; then
    echo "  GREEN on a planted defect -> THE GUARD IS DECORATION"
  elif ! grep -qF "× $red_test" "$LOG"; then
    verdict="WRONG-REASON"
    echo "  RED, but NOT from '$red_test' — a red for another reason proves nothing"
  elif ! grep -qF "$named" "$LOG"; then
    verdict="WRONG-REASON"
    echo "  RED from the right test, but it did not name '$named'"
  elif [ -n "$green_test" ] && ! grep -qF "✓ $green_test" "$LOG"; then
    verdict="WRONG-REASON"
    echo "  the sibling check '$green_test' also went red — the reason is not isolated"
  else
    verdict="RED"
    echo "  RED for its own reason: '$red_test', naming $named"
    grep -m1 -F '[git-template] scanned' "$LOG" | sed 's/^/  /'
  fi

  restore_target
  CURRENT_TARGET=""
  after="$(shasum -a 256 "$target" | cut -d' ' -f1)"
  if [ "$before" = "$after" ]; then
    echo "  restored byte-identical ($after)"
  else
    echo "  RESTORE FAILED: before $before after $after"
    exit 1
  fi
  if [ "$verdict" = "RED" ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi
}

echo "=== baseline: the gate must OPEN on a genuine pass (a brick gets disabled) ==="
if run_guard; then echo "  GREEN (correct)"; else echo "  FAIL: gate is RED before any plant"; cat "$LOG"; exit 1; fi
grep -m1 -F '[git-template] scanned' "$LOG" | sed 's/^/  /'

GITDIR_TEST='every repo-creating file neutralises the caller git environment'
TEMPLATE_TEST='every repo-creation site strips the machine template or declares why it must not'

attack A1 scripts/tests/test_sync_public_target_guard.sh \
  "$(printf 'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \\\n')" \
  "$(printf ': AV-PLANT-G29 neutralisation-defeated \\\n')" \
  "$GITDIR_TEST" '"scripts/tests/test_sync_public_target_guard.sh"'

attack A2 packages/core/src/__tests__/loop-completion-gate.test.ts \
  "spawnSync('git', ['init', '-q'], { cwd: sandbox, env: gitSafeEnvForNewRepo() });" \
  "spawnSync('git', ['init', '-q'], { cwd: sandbox, env: gitSafeEnv() });" \
  "$TEMPLATE_TEST" 'packages/core/src/__tests__/loop-completion-gate.test.ts:81' "$GITDIR_TEST"

attack A3 scripts/tests/test_sync_public_target_guard.sh \
  "$(printf 'export GIT_TEMPLATE_DIR=""\n')" \
  "$(printf ': AV-PLANT-template-armed\n')" \
  "$TEMPLATE_TEST" 'scripts/tests/test_sync_public_target_guard.sh:59' "$GITDIR_TEST"

echo "=== gate green again after every restore ==="
if run_guard; then echo "  GREEN (correct)"; else echo "  still RED after restore"; exit 1; fi

echo
echo "LIVE-FIRE: $PASSED passed, $FAILED failed (of 3 attacks)"
if [ "$FAILED" -eq 0 ] && [ "$PASSED" -eq 3 ]; then echo "LIVE-FIRE PASS"; exit 0; fi
echo "LIVE-FIRE FAIL"
exit 1

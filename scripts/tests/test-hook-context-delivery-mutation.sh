#!/bin/bash
# ============================================================
# MUTATION TEST — the hook context-delivery guards (P6-004 / P6-005)
# ============================================================
# CR-72: a gate you have not attacked is decoration. Plants each defect these
# guards exist to catch IN THE REAL TREE, runs the REAL vitest, demands RED for
# its own declared reason, restores from the bytes it saw, and proves the tree
# byte-identical afterwards.
#
# The defects planted are the exact ones that shipped:
#   1. the emit helper reverting to the undeliverable single-field shape
#   2. a hook declaring a VALID event it is not registered on — a payload
#      addressed to the wrong event, which looks correct in every review
#   3. a hook declaring an event outside the closed vocabulary
#
# Restore is from a byte BACKUP under a trap, never `git checkout --` — that
# reverts to the INDEX and would silently discard uncommitted work in the same
# file (learned the hard way: it ate a live edit on 2026-08-08).
#
# Cleanup is a FUNCTION, not a compound trap string. G25/CR-88 blocks a shell
# metacharacter sitting beside a destructive token inside one literal, because
# under a plant that enables a shell such a string EXECUTES — that shape wiped a
# home directory on this machine. Restructuring to satisfy the guard for the right
# reason beats reaching for its exemption.
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE="$ROOT/packages/core"
HELPER="$CORE/src/hooks/lib/write-hook-message.ts"
RECALL="$CORE/src/hooks/memory-recall.ts"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "yes" ]; then ok "$1"; else bad "$1"; fi; }

for f in "$HELPER" "$RECALL"; do
  [ -f "$f" ] || { printf 'FATAL: missing %s\n' "$f" >&2; exit 2; }
done

BK_HELPER="$(mktemp)"
BK_RECALL="$(mktemp)"
: "${BK_HELPER:?mktemp produced an empty path}"
: "${BK_RECALL:?mktemp produced an empty path}"
cp "$HELPER" "$BK_HELPER" || { echo "FATAL: backup failed" >&2; exit 2; }
cp "$RECALL" "$BK_RECALL" || { echo "FATAL: backup failed" >&2; exit 2; }
SHA_HELPER="$(shasum -a 256 "$HELPER" | cut -d' ' -f1)"
SHA_RECALL="$(shasum -a 256 "$RECALL" | cut -d' ' -f1)"

restore_sources() {
  cp "$BK_HELPER" "$HELPER"
  cp "$BK_RECALL" "$RECALL"
}
cleanup() {
  restore_sources
  rm -f "$BK_HELPER"
  rm -f "$BK_RECALL"
}
# ONE trap, set once — bash REPLACES `trap … EXIT`, so a second would kill this.
trap cleanup EXIT INT TERM

run_guards() { # -> exit status of the REAL vitest run
  ( cd "$CORE" && npx vitest run hooks-stdout-convention hook-context-delivery-drift-guard \
      > /tmp/hcd-mutation.log 2>&1 )
  return $?
}

printf '\n=== MUTATION TEST: hook context delivery ===\n\n'

# ---------- 0. The gate must OPEN on a genuine pass ----------------------- #
printf -- '--- 0. baseline: the guards must PASS on the real tree ---\n'
run_guards; BASE=$?
check "baseline is GREEN (a permanently-red gate gets deleted)" \
      "$([ "$BASE" -eq 0 ] && echo yes || echo no)"

# ---------- 1. Revert the helper to the undeliverable shape --------------- #
printf -- '\n--- 1. plant: helper emits the old single-field shape again ---\n'
python3 - "$HELPER" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
t = t.replace(
  "JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) + '\\n',",
  "JSON.stringify({ " + "message" + ": additionalContext }) + '\\n',")
open(p, 'w').write(t)
PY
if grep -q 'JSON.stringify({ message:' "$HELPER"; then
  ok "plant 1 applied (positive control: the mutation is really in the file)"
  run_guards; R1=$?
  check "guards go RED on the old shape" "$([ "$R1" -ne 0 ] && echo yes || echo no)"
  check "…and RED for its OWN reason (names additionalContext)" \
        "$(grep -qi 'additionalContext' /tmp/hcd-mutation.log && echo yes || echo no)"
else
  bad "plant 1 did NOT apply — the assertion below would be vacuous"
fi
restore_sources

# ---------- 2. Valid event, wrong registration ---------------------------- #
printf -- '\n--- 2. plant: memory-recall declares PostToolUse (valid, but not where it is registered) ---\n'
python3 - "$RECALL" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
t = t.replace("const HOOK_EVENT: HookEvent = 'UserPromptSubmit';",
              "const HOOK_EVENT: HookEvent = 'PostToolUse';")
open(p, 'w').write(t)
PY
if grep -q "HOOK_EVENT: HookEvent = 'PostToolUse'" "$RECALL"; then
  ok "plant 2 applied (positive control)"
  run_guards; R2=$?
  check "guards go RED on a mis-declared event" "$([ "$R2" -ne 0 ] && echo yes || echo no)"
  check "…and name the registration mismatch" \
        "$(grep -qiE 'registers it on|wrong event' /tmp/hcd-mutation.log && echo yes || echo no)"
else
  bad "plant 2 did NOT apply"
fi
restore_sources

# ---------- 3. Event outside the closed vocabulary ------------------------ #
printf -- '\n--- 3. plant: an event outside the closed vocabulary ---\n'
python3 - "$RECALL" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
t = t.replace("const HOOK_EVENT: HookEvent = 'UserPromptSubmit';",
              "const HOOK_EVENT: HookEvent = 'TotallyMadeUpEvent' as HookEvent;")
open(p, 'w').write(t)
PY
if grep -q 'TotallyMadeUpEvent' "$RECALL"; then
  ok "plant 3 applied (positive control)"
  run_guards; R3=$?
  check "guards go RED on an unknown event" "$([ "$R3" -ne 0 ] && echo yes || echo no)"
else
  bad "plant 3 did NOT apply"
fi
restore_sources

# ---------- 4. Restoration is byte-exact ---------------------------------- #
printf -- '\n--- 4. the tree is unchanged ---\n'
check "write-hook-message.ts sha256 restored" \
      "$([ "$(shasum -a 256 "$HELPER" | cut -d' ' -f1)" = "$SHA_HELPER" ] && echo yes || echo no)"
check "memory-recall.ts sha256 restored" \
      "$([ "$(shasum -a 256 "$RECALL" | cut -d' ' -f1)" = "$SHA_RECALL" ] && echo yes || echo no)"
run_guards; FINAL=$?
check "guards GREEN again after restore" "$([ "$FINAL" -eq 0 ] && echo yes || echo no)"

printf '\n=== RESULT: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

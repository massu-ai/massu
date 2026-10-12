#!/usr/bin/env bash
# CR-72 live-fire for packages/core/src/__tests__/vitest-run-roots-armed.test.ts — the D-3 gate
# asserting every vitest RUN ROOT arms the hang detector.
#
# Plants each defect the gate exists to catch INTO THE REAL TREE, demands the gate go RED *for
# its own declared reason*, restores, and proves every restore byte-identical by sha256. Then
# proves the gate still OPENS on the genuine tree — a brick gets disabled.
#
# ⛔ A REGRESSION TEST CANNOT FIND A FALSE NEGATIVE. The gate passing 3/3 says nothing about
# whether those 3 assertions CAN fail. This script is what makes them evidence.
#
# ⛔ ONE PLANT HERE IS A NEGATIVE CONTROL — IT MUST LEAVE THE GATE GREEN. The gate's first real
# run was RED because `defineProject({...})` appears in a COMMENT in the root config, so the
# shape predicate read prose as code. The fix was a comment stripper; P2 plants that same prose
# shape deliberately and demands the gate STAY GREEN. Without it, "the stripper works" and "the
# stripper is gone and nothing noticed" look identical.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

GATE_REL='src/__tests__/vitest-run-roots-armed.test.ts'
CORE="$ROOT/packages/core"
ROOT_CFG="$ROOT/vitest.config.ts"
CORE_CFG="$ROOT/packages/core/vitest.config.ts"
FACTORY="$ROOT/scripts/lib/vitest-hang-armed.mjs"
# ⛔ P3 MUST NOT BE PLANTED IN A CONFIG THE GATE'S OWN RUN LOADS. First attempt planted
# "no default export" into packages/core/vitest.config.ts — the very config vitest loads to
# run this gate — so vitest never STARTED ("config must export or return an object") and the
# gate went red without ever executing. expect_red_because refused to score it, which is the
# whole reason a plant is adjudicated on its REASON and not on an exit code. An adapter
# config is a subject the `--root packages/core` run does not load.
ADAPTER_CFG="$ROOT/packages/adapter-rails/vitest.config.ts"

for f in "$CORE/$GATE_REL" "$ROOT_CFG" "$CORE_CFG" "$FACTORY" "$ADAPTER_CFG"; do
  [ -f "$f" ] || { printf 'live-fire: not found: %s\n' "$f" >&2; exit 2; }
done

# Snapshot every file any plant touches, and key the restore proof on the sha256 of each.
SUBJECTS="$ROOT_CFG $CORE_CFG $FACTORY $ADAPTER_CFG"
BACKUP_DIR="$(mktemp -d)"
declare -a SHA_BEFORE_LIST=()
i=0
for f in $SUBJECTS; do
  cp "$f" "$BACKUP_DIR/$i.bak"
  SHA_BEFORE_LIST[$i]="$(shasum -a 256 "$f" | cut -c1-16)"
  i=$((i + 1))
done

restore_all() {
  local n=0
  for g in $SUBJECTS; do
    cp "$BACKUP_DIR/$n.bak" "$g"
    n=$((n + 1))
  done
}
_cleanup() {
  restore_all
  rm -f "$BACKUP_DIR"/*.bak
  rmdir "$BACKUP_DIR" 2>/dev/null || true
}
trap _cleanup EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  BAD  %s\n' "$1"; }

# Run the gate with BOUNDED output and capture its exit status on its own line — never through
# a pipe, which would report the pipe's status instead (CR-69).
GATE_LOG="$BACKUP_DIR/gate.log"
run_gate() {
  ( cd "$CORE" && npx vitest run "$GATE_REL" ) > "$GATE_LOG" 2>&1
  printf '%s' "$?"
}

# A plant is adjudicated on TWO facts: the gate went red, AND it said why. An exit code alone
# cannot distinguish "the guard fired" from "the suite failed to start" — measured this session,
# where a startup error was scored as 11 successful attacks.
expect_red_because() {
  local label="$1" reason="$2" rc
  rc="$(run_gate)"
  if [ "$rc" = "0" ]; then
    bad "$label — gate stayed GREEN on a planted defect (exit 0); it is not checking this"
    return
  fi
  if /usr/bin/grep -qF "$reason" "$GATE_LOG"; then
    ok "$label — RED (exit $rc) for its own declared reason"
  else
    bad "$label — RED (exit $rc) but NOT for its declared reason; expected to see: $reason"
    /usr/bin/grep -iE 'Error|FAIL' "$GATE_LOG" | head -3 | sed 's/^/         /'
  fi
}

# ⛔ A THIRD OUTCOME, BECAUSE TWO WERE NOT ENOUGH. Some defects in the factory cannot be
# adjudicated by the gate at all: every run root's config imports the factory, so breaking it
# kills the CONFIG LOAD and the gate never executes. Measured 2026-09-24 — and the first draft of
# P4/P5 scored those as successful attacks, because the declared reason string happened to appear
# in the startup error. That is the same defect as scoring a startup error as a red gate.
#
# So the honest assertion is the real consequence: the run dies at config load, before collection.
# Proving THAT is what makes "this property is self-enforcing" evidence rather than a claim.
expect_dies_at_config_load() {
  local label="$1" rc
  rc="$(run_gate)"
  if [ "$rc" = "0" ]; then
    bad "$label — the run SURVIVED (exit 0); the property is not self-enforcing after all"
    return
  fi
  if ! /usr/bin/grep -qE 'failed to load config|Startup Error' "$GATE_LOG"; then
    bad "$label — exit $rc but NOT a config-load failure; this plant is doing something else"
    /usr/bin/grep -iE 'Error|FAIL' "$GATE_LOG" | head -3 | sed 's/^/         /'
    return
  fi
  # ...and it must have died BEFORE any test ran, or the claim "the gate cannot observe this"
  # is false. A collected-and-failed test would mean the gate DID speak.
  if /usr/bin/grep -qE '^ +Tests +[0-9]+ (passed|failed)' "$GATE_LOG"; then
    bad "$label — config load failed YET tests were collected; the gate could have caught this"
    return
  fi
  ok "$label — the run dies at CONFIG LOAD before collection (self-enforcing, exit $rc)"
}

expect_green() {
  local label="$1" rc
  rc="$(run_gate)"
  if [ "$rc" = "0" ]; then
    ok "$label — GREEN, as required"
  else
    bad "$label — expected GREEN, got exit $rc"
    /usr/bin/grep -iE 'Error|FAIL' "$GATE_LOG" | head -3 | sed 's/^/         /'
  fi
}

printf '\n=== live-fire: D-3 run-root arming gate ===\n\n'

# ── P0: the gate OPENS on the genuine tree. Taken FIRST, so a gate that is simply broken
#         cannot be mistaken for a gate that caught every plant.
expect_green 'P0 baseline: the genuine tree PASSES (a brick gets disabled)'

# ── P1: UNARM A RUN ROOT. The central property.
python3 - "$ROOT_CFG" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = 'export default withHangDetection(defineConfig({'
assert s.count(old) == 1, 'P1 anchor missing — plant would be inert'
s = s.replace(old, 'export default defineConfig({', 1)
# drop the now-unbalanced trailing paren the wrapper added
assert s.endswith('}));\n'), repr(s[-8:])
s = s[: -len('}));\n')] + '});\n'
io.open(p, 'w', encoding='utf-8').write(s)
PY
expect_red_because 'P1 a run root does not arm the hang detector' \
  'do not arm the hang detector'
restore_all

# ── P2: NEGATIVE CONTROL — prose must not be read as code. The real first-run defect.
python3 - "$CORE_CFG" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
anchor = "import { defineConfig } from 'vitest/config';\n"
assert s.count(anchor) == 1, 'P2 anchor missing — plant would be inert'
# A COMMENT mentioning defineProject, exactly the shape that misclassified the root config.
s = s.replace(anchor, anchor + "// Each project entry may instead be an inline defineProject({...}) call.\n", 1)
io.open(p, 'w', encoding='utf-8').write(s)
PY
expect_green 'P2 negative control: a commented defineProject( does NOT reclassify a run root'
restore_all

# ── P3: an unclassifiable config must FAIL CLOSED, never be skipped.
python3 - "$ADAPTER_CFG" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = 'export default defineProject({'
assert s.count(old) == 1, 'P3 anchor missing — plant would be inert'
# A shape the guard does not model: no `export default <fn>(`.
s = s.replace(old, 'const cfg = defineProject({', 1)
io.open(p, 'w', encoding='utf-8').write(s)
PY
expect_red_because 'P3 a config with no recognisable default export fails CLOSED' \
  'has no recognisable'
restore_all

# ── P4: the factory losing its export is SELF-ENFORCING, and this PROVES it rather than
#        asserting it. Every run root imports the factory, so the config load dies.
python3 - "$FACTORY" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = 'export function withHangDetection('
assert s.count(old) == 1, 'P4 anchor missing — plant would be inert'
s = s.replace(old, 'function withHangDetection(', 1)
io.open(p, 'w', encoding='utf-8').write(s)
PY
expect_dies_at_config_load 'P4 the factory no longer exports withHangDetection'
restore_all

# ── P5: the factory importing the reporter at top level would kill every run at config load,
#        because the reporter throws when the base is unset. The gate must refuse it.
python3 - "$FACTORY" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
anchor = "import { join, resolve } from 'node:path';\n"
assert s.count(anchor) == 1, 'P5 anchor missing — plant would be inert'
s = s.replace(anchor, anchor + "import './vitest-heartbeat-reporter.mjs';\n", 1)
io.open(p, 'w', encoding='utf-8').write(s)
PY
expect_dies_at_config_load 'P5 the factory imports the reporter instead of declaring it by path'
restore_all

# ── the restore must be byte-identical, proven per file, never assumed from the trap.
printf '\n--- restore proof (sha256, first 16) ---\n'
n=0
for f in $SUBJECTS; do
  after="$(shasum -a 256 "$f" | cut -c1-16)"
  if [ "$after" = "${SHA_BEFORE_LIST[$n]}" ]; then
    # Repo-relative, never a basename: root and packages/core both end in vitest.config.ts,
    # and a report that cannot tell two subjects apart is its own defect.
    ok "restore byte-identical: ${f#"$ROOT"/}  ${SHA_BEFORE_LIST[$n]}"
  else
    bad "restore CHANGED $f: ${SHA_BEFORE_LIST[$n]} -> $after"
  fi
  n=$((n + 1))
done

# ── and the gate must still OPEN after all that plant/restore traffic.
expect_green 'P6 the gate still PASSES on the restored tree'

printf '\n=== %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
[ "$PASS" -gt 0 ] || { printf 'live-fire: ZERO assertions ran — proves nothing (M1)\n' >&2; exit 2; }
exit 0

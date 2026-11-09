#!/usr/bin/env bash
# CR-72 live-fire for homedir-injectability-drift-guard.test.ts.
#
# A gate you have not attacked is decoration. This plants, IN THE REAL TREE, each defect the
# guard exists to catch and demands it go RED for ITS OWN DECLARED REASON — then restores and
# proves the restore byte-identical by sha256.
#
# It also proves the guard OPENS on a genuine pass (anti-brick, CR-72): a gate that is always
# red gets disabled, and then nothing is enforced.
#
# PAYLOAD SAFETY (G25/CR-88): every plant here is an ordinary `homedir()` expression or a
# signature edit. No destructive token, no shell metacharacter, nothing that becomes a live
# command if the property under test were switched off. The cleanup body lives in a NAMED
# FUNCTION rather than an inline `trap '...'` string — an inline trap chaining a restore into
# a recursive delete is itself the G25 shape, and this repo already re-ruled its two other
# harnesses for exactly that reason on 2026-07-30.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

INIT="packages/core/src/commands/init.ts"
VICTIM="packages/core/src/memory-renderer.ts"   # deliberately NOT on KNOWN_INLINE
SH_VICTIM="scripts/massu-reality-gate.sh"       # tracked *.sh, deliberately NOT on KNOWN_INLINE_SH
MEMCHECK="scripts/hooks/memory-integrity-check.sh"  # the d76ab2c8 originating script
GUARD="homedir-injectability-drift-guard"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
fail() { printf "${RED}FAIL${NC}: %s\n" "$1" >&2; exit 1; }
ok()   { printf "${GREEN}OK${NC}  : %s\n" "$1"; }
sha()  { shasum -a 256 "$1" | cut -d' ' -f1; }

LOG="$(mktemp)"
BACKUP_DIR="$(mktemp -d)"
INIT_SHA_BEFORE="$(sha "$INIT")"
VICTIM_SHA_BEFORE="$(sha "$VICTIM")"
SH_VICTIM_SHA_BEFORE="$(sha "$SH_VICTIM")"
MEMCHECK_SHA_BEFORE="$(sha "$MEMCHECK")"
cp "$INIT" "$BACKUP_DIR/init.ts"
cp "$VICTIM" "$BACKUP_DIR/victim.ts"
cp "$SH_VICTIM" "$BACKUP_DIR/sh_victim.sh"
cp "$MEMCHECK" "$BACKUP_DIR/memcheck.sh"

# Restores EVERY target, not just the one most recently planted — a restore narrower than
# the plant set leaves a live mutation behind on any early `fail` (the trap calls this too).
restore() {
  cp "$BACKUP_DIR/init.ts" "$INIT"
  cp "$BACKUP_DIR/victim.ts" "$VICTIM"
  cp "$BACKUP_DIR/sh_victim.sh" "$SH_VICTIM"
  cp "$BACKUP_DIR/memcheck.sh" "$MEMCHECK"
}

# `${VAR:?}` not `$VAR` — `set -u` does NOT fire on a variable that is SET BUT EMPTY, and an
# empty component would widen these deletes to their parent (G17/CR-77).
cleanup() {
  restore
  rm -rf "${BACKUP_DIR:?cleanup: BACKUP_DIR empty}"
  rm -f "${LOG:?cleanup: LOG empty}"
}
trap cleanup EXIT INT TERM

run_guard() {
  npm test --workspace=packages/core -- "$GUARD" >"$LOG" 2>&1 && echo 0 || echo 1
}

# ── 0. CONTROL — the guard must be GREEN on the pristine tree ────────────────────────────
[ "$(run_guard)" = "0" ] || { cat "$LOG" >&2; fail "CONTROL: guard is ALREADY RED on a pristine tree — a defeat test against an already-failing gate proves nothing"; }
ok "CONTROL: guard is green on the pristine tree (it is not a brick)"

# ── 1. PLANT: strip the injectable seam off massuShimPath ────────────────────────────────
# Verbatim the 2026-08-11 defect: the shim path resolving the real home with no seam.
python3 - "$INIT" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
old = "export function massuShimPath(home: string = homedir()): string {\n  return resolve(home, '.massu', 'bin', 'massu-hook');"
new = "export function massuShimPath(): string {\n  return resolve(homedir(), '.massu', 'bin', 'massu-hook');"
assert old in s, "PLANT TARGET NOT FOUND — massuShimPath changed shape; this harness is stale"
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
grep -q "export function massuShimPath(): string" "$INIT" || fail "ORACLE: the seam-removal plant did not land"
ok "ORACLE: massuShimPath() seam removed in the real tree"

[ "$(run_guard)" = "1" ] || { cat "$LOG" >&2; fail "DEFEAT-1: guard stayed GREEN with massuShimPath's seam removed — IT IS DECORATION"; }
grep -q "takes no injectable home" "$LOG" || fail "DEFEAT-1: guard went red for the WRONG reason (its own message is absent)"
ok "DEFEAT-1: went RED naming the missing seam. This is a gate."

restore
[ "$(sha "$INIT")" = "$INIT_SHA_BEFORE" ] || fail "restore of $INIT is not byte-identical"

# ── 2. PLANT: a NEW inline homedir() in a file that is not allowlisted ───────────────────
python3 - "$VICTIM" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
assert "avPlantInlineHome" not in s, "victim already planted"
s += "\n// AV-PLANT: a new inline homedir() with no seam.\n" \
     "export function avPlantInlineHome(): string {\n" \
     "  return resolve(homedir(), '.massu', 'av-plant');\n}\n"
open(p, "w", encoding="utf-8").write(s)
PY
grep -q "avPlantInlineHome" "$VICTIM" || fail "ORACLE: the new-inline plant did not land"
ok "ORACLE: a new inline homedir() exists in $VICTIM"

[ "$(run_guard)" = "1" ] || { cat "$LOG" >&2; fail "DEFEAT-2: guard stayed GREEN with a NEW inline homedir() — IT IS DECORATION"; }
grep -q "no injectable seam" "$LOG" || fail "DEFEAT-2: guard went red for the WRONG reason"
ok "DEFEAT-2: went RED on a new un-allowlisted inline homedir(). This is a gate."

restore
[ "$(sha "$VICTIM")" = "$VICTIM_SHA_BEFORE" ] || fail "restore of $VICTIM is not byte-identical"

# ── 3. PLANT: an unseamed $HOME path build in a tracked *.sh ─────────────────────────────
# The SHELL branch. `d76ab2c8` — the incident this guard's own header cites as instance #1 —
# was a shell script, and until 2026-08-13 the sweep was TypeScript-only, so it could never
# have caught its own founding defect. A branch with no fixture is decoration (G18/CR-83),
# so each of the two shell detection paths gets its own plant.
python3 - "$SH_VICTIM" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
assert "AV_PLANT_HOME" not in s, "victim already planted"
# An ordinary path assignment — no destructive token, no metacharacter (G25/CR-88). If the
# guard under test were switched off entirely, this line still does nothing but set a var.
s += '\nAV_PLANT_HOME="$HOME/.massu/av-plant"\n'
open(p, "w").write(s)
PY
grep -q "AV_PLANT_HOME" "$SH_VICTIM" || fail "ORACLE: the unseamed-\$HOME plant did not land"

[ "$(run_guard)" = "1" ] || { cat "$LOG" >&2; fail "DEFEAT-3: guard stayed GREEN on an unseamed \$HOME in a tracked *.sh — the shell branch is DEAD"; }
grep -q "no override seam" "$LOG" || fail "DEFEAT-3: guard went red for the WRONG reason"
ok "DEFEAT-3: went RED on an unseamed \$HOME path build in shell. This is a gate."

restore
[ "$(sha "$SH_VICTIM")" = "$SH_VICTIM_SHA_BEFORE" ] || fail "restore of $SH_VICTIM is not byte-identical"

# ── 4. PLANT: strip the seam off the ORIGINATING script (the d76ab2c8 regression site) ───
# A file-level verdict is a CORRELATE; memory-integrity-check.sh is absent from the shell
# allowlist BECAUSE it was fixed, so a silent revert of its seam must fail on its own named
# assertion rather than merely adding it to the offender set.
python3 - "$MEMCHECK" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = 'MEMORY_STORE_ROOT="${MASSU_MEMORY_STORE_ROOT:-$HOME/.claude/projects}"'
new = 'MEMORY_STORE_ROOT="$HOME/.claude/projects"'
assert old in s, "PLANT TARGET NOT FOUND — the seam changed shape; this harness is stale"
open(p, "w").write(s.replace(old, new, 1))
PY
grep -q 'MEMORY_STORE_ROOT="\$HOME/.claude/projects"' "$MEMCHECK" || fail "ORACLE: the seam-revert plant did not land"

[ "$(run_guard)" = "1" ] || { cat "$LOG" >&2; fail "DEFEAT-4: guard stayed GREEN after reverting the d76ab2c8 seam — the regression assertion is DEAD"; }
grep -q "exact d76ab2c8 defect" "$LOG" || fail "DEFEAT-4: guard went red for the WRONG reason"
ok "DEFEAT-4: went RED on a revert of the originating seam. This is a gate."

restore
[ "$(sha "$MEMCHECK")" = "$MEMCHECK_SHA_BEFORE" ] || fail "restore of $MEMCHECK is not byte-identical"

# ── 5. ANTI-BRICK — green again after restore ───────────────────────────────────────────
[ "$(run_guard)" = "0" ] || { cat "$LOG" >&2; fail "guard is RED on the restored tree — it does not OPEN on a genuine pass"; }
ok "ANTI-BRICK: green again on the restored tree"

# ── 6. TREE UNCHANGED ───────────────────────────────────────────────────────────────────
[ "$(sha "$INIT")" = "$INIT_SHA_BEFORE" ] || fail "$INIT differs from its pre-run sha256"
[ "$(sha "$VICTIM")" = "$VICTIM_SHA_BEFORE" ] || fail "$VICTIM differs from its pre-run sha256"
[ "$(sha "$SH_VICTIM")" = "$SH_VICTIM_SHA_BEFORE" ] || fail "$SH_VICTIM differs from its pre-run sha256"
[ "$(sha "$MEMCHECK")" = "$MEMCHECK_SHA_BEFORE" ] || fail "$MEMCHECK differs from its pre-run sha256"
ok "TREE: all four plant targets restored byte-identical (sha256)"

printf "\n${GREEN}PASS${NC}: 4 planted defects, 4 REDs for their own declared reasons, tree byte-identical.\n"

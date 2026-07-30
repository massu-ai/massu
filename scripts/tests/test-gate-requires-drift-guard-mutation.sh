#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# CR-72 mutation proof for the X-1 precondition-declaration drift guard.
#
# "A gate you have not attacked is decoration. Plant the defect IN THE REAL TREE, run the
#  REAL gate, demand RED, restore, assert the tree is unchanged. A fixture-only mutation
#  test is a regression test in disguise, and a regression test cannot find a false negative."
#
# ONE FIXTURE PER DETECTION PATH, and every one must FIRE. The guard has eight independent
# assertions; a mutation suite covering two of them would leave six unproven while reporting
# a clean sweep (G18 — a gate's candidate set IS the gate, aimed at the mutation suite).
#
# It also proves the guard OPENS on a genuine pass (CR-72's second half): a gate that is red
# no matter what gets disabled, and a brick enforces nothing.
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'

GUARD='gate-precondition-declaration-drift-guard'
SOT="scripts/lib/gate-requires.json"
REGISTRY="scripts/lib/gate-registry.json"
RUNNER="scripts/massu-gate-anti-vacuity.sh"

PASS=0; FAIL=0
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gate-requires-mutation.XXXXXX")" || exit 2

# ── restore is ASSERTED, not best-effort. A mutation suite that leaves the tree dirty is a
#    worse defect than the one it hunts. ───────────────────────────────────────────────────
restore() {
  local f
  for f in "$SOT" "$REGISTRY" "$RUNNER"; do
    if [ -f "$BACKUP_DIR/$(basename "$f")" ]; then
      cp "$BACKUP_DIR/$(basename "$f")" "$f" || {
        echo "${RED}FATAL${NC}: could not restore $f — TREE IS DIRTY." >&2; return 1; }
    fi
  done
  return 0
}
# shellcheck disable=SC2329  # invoked indirectly via the EXIT/INT/TERM trap below
cleanup() {
  local rc=$?
  restore || rc=1
  # Assert the tree really is back, rather than inferring it from cp's exit 0 (CR-69).
  if ! git diff --quiet -- "$SOT" "$REGISTRY" "$RUNNER"; then
    echo "${RED}FATAL${NC}: tree still modified after restore:" >&2
    git diff --stat -- "$SOT" "$REGISTRY" "$RUNNER" >&2
    rc=1
  fi
  rm -rf "$BACKUP_DIR"
  exit "$rc"
}
trap cleanup EXIT INT TERM

for f in "$SOT" "$REGISTRY" "$RUNNER"; do
  [ -f "$f" ] || { echo "${RED}FATAL${NC}: missing $f" >&2; exit 2; }
  cp "$f" "$BACKUP_DIR/$(basename "$f")" || exit 2
done

# The tree must be CLEAN in these files before we start, or "red because of my plant" and
# "red because it already was" are the same value — and that value is the passing one.
if ! git diff --quiet -- "$SOT" "$REGISTRY" "$RUNNER"; then
  echo "${RED}FATAL${NC}: $SOT / $REGISTRY / $RUNNER are already modified. Refusing to run:" >&2
  echo "       a mutation proof needs a clean CONTROL or its verdicts are meaningless." >&2
  exit 2
fi

run_guard() { npx vitest run "$GUARD" >"$BACKUP_DIR/out.txt" 2>&1; echo $?; }

# ── CONTROL: the guard must be GREEN before any plant (CR-72 — prove it OPENS) ───────────
echo "── CONTROL: the guard must pass on the clean tree ──"
rc="$(run_guard)"
if [ "$rc" -eq 0 ]; then
  echo "  ${GREEN}OK${NC}   CONTROL green (exit 0) — the guard opens on a genuine pass."
  PASS=$((PASS + 1))
else
  echo "  ${RED}FAIL${NC} CONTROL is ALREADY RED (exit $rc). Every 'went red' below would be" >&2
  echo "       meaningless — a brick cannot be shown to detect anything." >&2
  tail -25 "$BACKUP_DIR/out.txt" >&2
  exit 1
fi

# ── each plant: mutate -> demand RED -> restore -> demand GREEN again ────────────────────
plant_and_demand_red() { # $1 = label, $2 = python mutation program
  local label="$1" prog="$2"
  printf '  %-52s ' "$label"
  if ! python3 -c "$prog"; then
    echo "${RED}PLANT FAILED${NC} — the mutation did not apply, so this path is UNPROVEN."
    FAIL=$((FAIL + 1)); restore >/dev/null; return
  fi
  # ORACLE: the plant must have actually changed the tree. An inert mutation and a working
  # guard both leave the suite green, and they must not be confused (CR-65).
  if git diff --quiet -- "$SOT" "$REGISTRY" "$RUNNER"; then
    echo "${RED}INERT${NC} — the mutation changed nothing; 'stayed green' proves nothing."
    FAIL=$((FAIL + 1)); restore >/dev/null; return
  fi
  local rc; rc="$(run_guard)"
  if [ "$rc" -ne 0 ]; then
    echo "${GREEN}RED${NC} (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "${RED}STAYED GREEN — DECORATION${NC}"
    FAIL=$((FAIL + 1))
  fi
  restore >/dev/null || exit 1
}

echo
echo "── PLANTS: one per detection path, each must go RED ──"

# 3a — an unknown requires value must be a HARD error, never an ignored one (G3)
plant_and_demand_red "3a unknown requires value" "
import json
d=json.load(open('$SOT'))
gid=json.load(open('$REGISTRY'))['gates'][0]['id']
d['requires'][gid]=['av-plant-not-in-vocabulary']
d['provenance']['probed']=True
d['provenance']['probed_at_head']='0'*40
d['provenance']['registry_gates_at_probe']=len(json.load(open('$REGISTRY'))['gates'])
json.dump(d,open('$SOT','w'),indent=2)
"

# 3a — a vocabulary entry with no remedy is unactionable: the remedy string is the point
plant_and_demand_red "3a vocabulary entry with empty remedy" "
import json
d=json.load(open('$SOT'))
d['vocabulary']['av-plant-malformed']={'probe':'true','remedy':''}
json.dump(d,open('$SOT','w'),indent=2)
"

plant_and_demand_red "3a vocabulary entry with empty probe" "
import json
d=json.load(open('$SOT'))
d['vocabulary']['av-plant-noprobe']={'probe':'','remedy':'do a thing'}
json.dump(d,open('$SOT','w'),indent=2)
"

# 3b — an annotation naming a gate the registry lost is drift, not a skip
plant_and_demand_red "3b annotation on a gate id not in the registry" "
import json
d=json.load(open('$SOT'))
d['requires']['vitest-guard::packages/core/src/__tests__/av-plant-nonexistent.test.ts']=['hooks-built']
d['provenance']['probed']=True
d['provenance']['probed_at_head']='0'*40
d['provenance']['registry_gates_at_probe']=len(json.load(open('$REGISTRY'))['gates'])
json.dump(d,open('$SOT','w'),indent=2)
"

# 3b — an empty requires[] is an annotation that asserts nothing
plant_and_demand_red "3b empty requires list on a real gate" "
import json
d=json.load(open('$SOT'))
gid=json.load(open('$REGISTRY'))['gates'][0]['id']
d['requires'][gid]=[]
d['provenance']['probed']=True
d['provenance']['probed_at_head']='0'*40
d['provenance']['registry_gates_at_probe']=len(json.load(open('$REGISTRY'))['gates'])
json.dump(d,open('$SOT','w'),indent=2)
"

# 3c — hand-typed annotations with no probe behind them
plant_and_demand_red "3c annotation present but probed=false" "
import json
d=json.load(open('$SOT'))
gid=json.load(open('$REGISTRY'))['gates'][0]['id']
d['requires'][gid]=['hooks-built']
d['provenance']['probed']=False
json.dump(d,open('$SOT','w'),indent=2)
"

# 3c — registry grew since the probe: those gates are UNADJUDICATED, not requirement-free
#
# ⚠ THIS PLANT WENT VACUOUS WHEN THE GUARD IT TESTS WAS IMPROVED (CI run 30493858521, and it
# reproduced identically on macOS — unlike the other two failures in that run, this one was
# never platform-specific). Commit 6f9dbeb8 moved invariant 3c from a COUNT to a SET: it now
# reads `provenance.adjudicated_gate_ids` so it can NAME the unadjudicated gates instead of
# only counting them. This plant kept lowering `registry_gates_at_probe`, a field 3c no longer
# treats as authority — so the guard stayed GREEN and was reported as DECORATION.
#
# It also slipped past the INERT control above, which asks "did the mutation change the file?"
# It did change the file. It changed a field nothing reads. Mutating a byte is not mutating a
# PREDICATE, and only the second one makes a plant real (CR-74 — a guard's fix obligates its
# mutation test; the fix landed at the guard and not at this site).
#
# Now expressed against the SET, which is what 3c actually judges. `registry_gates_at_probe`
# is lowered to MATCH so the sibling coherence check (set may not be smaller than the count)
# stays green and this RED is attributable to the naming check alone.
plant_and_demand_red "3c registry grew since the last probe" "
import json
d=json.load(open('$SOT'))
reg=[g['id'] for g in json.load(open('$REGISTRY'))['gates']]
if len(reg) < 4: raise SystemExit('PLANT-VACUOUS: need >3 registry gates to drop 3')
d['provenance']['probed']=True
d['provenance']['probed_at_head']='0'*40
d['provenance']['adjudicated_gate_ids']=reg[:-3]
d['provenance']['registry_gates_at_probe']=len(reg)-3
d['provenance']['gates_probed']=len(reg)-3
json.dump(d,open('$SOT','w'),indent=2)
"

# 3d — the exact provenance a CRASHED probe wrote on 2026-07-28. It claims a full probe
# (probed=true, 409 gates) while having adjudicated ZERO requirements, and every pre-3d
# assertion passed over it — 10 of 10 green on a fabrication. Reproduced verbatim here so a
# regression cannot re-open the hole: no requirements_selected / requirements_adjudicated.
plant_and_demand_red "3d probed=true with NO adjudication denominator (the crashed-probe write)" "
import json
d=json.load(open('$SOT'))
d['provenance']['probed']=True
d['provenance']['probed_at_head']='5'*40
d['provenance']['registry_gates_at_probe']=len(json.load(open('$REGISTRY'))['gates'])
d['provenance']['gates_probed']=len(json.load(open('$REGISTRY'))['gates'])
d['provenance'].pop('requirements_selected',None)
d['provenance'].pop('requirements_adjudicated',None)
json.dump(d,open('$SOT','w'),indent=2)
"

# 3d — a run that started but stopped partway. The counters are PRESENT, so the shape looks
# healthy; only the comparison between them exposes it. This is the partial-run twin of the
# plant above, and the one a naive 'is the field there?' check would miss.
plant_and_demand_red "3d adjudicated FEWER requirements than it selected (partial run)" "
import json
d=json.load(open('$SOT'))
n=len(d['vocabulary'])
d['provenance']['probed']=True
d['provenance']['probed_at_head']='5'*40
d['provenance']['registry_gates_at_probe']=len(json.load(open('$REGISTRY'))['gates'])
d['provenance']['gates_probed']=268
d['provenance']['requirements_selected']=n
d['provenance']['requirements_adjudicated']=n-1
json.dump(d,open('$SOT','w'),indent=2)
"

# 3d — a baseline sweep that returned no verdicts cannot support ANY differential claim,
# even when the requirement counters reconcile perfectly.
plant_and_demand_red "3d complete adjudication over a ZERO-verdict baseline" "
import json
d=json.load(open('$SOT'))
n=len(d['vocabulary'])
d['provenance']['probed']=True
d['provenance']['probed_at_head']='5'*40
d['provenance']['registry_gates_at_probe']=len(json.load(open('$REGISTRY'))['gates'])
d['provenance']['gates_probed']=0
d['provenance']['requirements_selected']=n
d['provenance']['requirements_adjudicated']=n
json.dump(d,open('$SOT','w'),indent=2)
"

# anti-laundering — the PRECONDITION MISSING verdict must exist in the runner
plant_and_demand_red "anti-laundering PRECONDITION MISSING removed" "
s=open('$RUNNER').read()
s=s.replace('PRECONDITION MISSING','AV-PLANT VERDICT REMOVED')
open('$RUNNER','w').write(s)
"

# anti-laundering — an unmet precondition must NOT be absorbed into a tally
plant_and_demand_red "anti-laundering __UNMET__ increments a tally" "
s=open('$RUNNER').read()
old='''      echo \"\${RED}FATAL\${NC}: this sweep cannot judge those gates. They are NOT decoration and are\" >&2'''
new='''      FAILURES=\$((FAILURES + 1))
      echo \"\${RED}FATAL\${NC}: this sweep cannot judge those gates. They are NOT decoration and are\" >&2'''
assert old in s, 'anchor not found — the mutation could not be applied'
open('$RUNNER','w').write(s.replace(old,new,1))
"

echo
echo "═════════════════════════════════════════════════════════════"
echo "  paths proven RED : $PASS"
echo "  paths UNPROVEN   : $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "${RED}FAIL${NC}: $FAIL detection path(s) did not fire. A rule whose paths are untested is"
  echo "      decoration in exactly the proportion that is untested."
  exit 1
fi
echo "${GREEN}PASS${NC}: every detection path went RED on its planted defect, and the guard opens clean."
exit 0

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# test-probe-gate-requires-mutation.sh — CR-72 mutation proof for the ADJUDICATOR.
# plan-2026-07-26-anti-vacuity-9-unproven-gates §4 X-1.
#
# WHY THIS EXISTS. scripts/ops/probe-gate-requires.sh writes the `requires[]` source of
# truth that the whole X-1 contract rests on, and it shipped with ZERO tests — because the
# only way to reach its withdrawal loop was a multi-hour real sweep. On 2026-07-28 its first
# --write run hit `mapfile` (a bash-4 builtin absent from macOS /bin/bash 3.2), `set -u`
# aborted THE LOOP rather than the script, all six withdrawal sweeps were skipped, and the
# probe wrote `probed: true, gates_probed: 409` and exited 0. Nothing went red: the
# drift-guard passed 10/10 over the fabrication, because a provenance block claiming a probe
# had happened was the one thing no check verified.
#
# So this plants THE REAL DEFECT — the historical `mapfile` line, restored by sed into a copy
# of the live script — and demands the repaired denominator gate REFUSE to write and exit 2.
#
# NEGATIVE CONTROL (the half most mutation tests omit): the same copy WITHOUT the mutation
# must exit 0 and write. Without it, "the guard refused" and "the harness never ran the
# script at all" look identical — G7 aimed at the test itself.
#
# Usage: bash scripts/tests/test-probe-gate-requires-mutation.sh
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'
PROBE="scripts/ops/probe-gate-requires.sh"
[ -r "$PROBE" ] || { echo "FATAL: cannot read $PROBE (M2)." >&2; exit 2; }

# A differential harness that mutates real files must refuse under concurrency, not race.
#
# FOREIGN, not merely present. This asked "is ANY sweep alive?" until 2026-07-29 — and the
# anti-vacuity sweep DISCOVERS every tracked scripts/tests/*.sh and runs it as a child, so
# the check matched the sweep that invoked it and this test FATAL'd on every CI run
# (30428800020: `proven can-fail: 412, failures: 1`). An ancestor is not a competitor.
# See scripts/lib/foreign-sweep-guard.sh.
# shellcheck source=scripts/lib/foreign-sweep-guard.sh
. "$REPO_ROOT/scripts/lib/foreign-sweep-guard.sh"
assert_no_foreign_sweep "this test plants into the repo" || exit 2

PASSED=0; FAILED=0
ok()  { echo "  ${GREEN}PASS${NC}  $1"; PASSED=$((PASSED + 1)); }
bad() { echo "  ${RED}FAIL${NC}  $1"; FAILED=$((FAILED + 1)); }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/probe-mutation.XXXXXX")" || exit 2
# The mutant must live INSIDE the repo: the script derives REPO_ROOT from BASH_SOURCE, so a
# copy anywhere else would resolve a wrong root and fail for a reason unrelated to the plant.
MUTANT="$REPO_ROOT/scripts/ops/.probe-mutant-$$.sh"
FIXDIR="$REPO_ROOT/.probe-fixture-$$"
cleanup() { rm -rf "$SCRATCH" "$MUTANT" "$FIXDIR"; }
trap cleanup EXIT INT TERM

# ── fixtures: two withdrawable requirements, a stub runner, a throwaway ledger ────────────
mkdir -p "$FIXDIR"
echo a > "$FIXDIR/artifact-a"
echo b > "$FIXDIR/artifact-b"

FIX_SOT="$SCRATCH/gate-requires.json"
python3 - "$FIX_SOT" "$FIXDIR" <<'PY'
import json, os, sys
out, fixdir = sys.argv[1], sys.argv[2]
rel = os.path.relpath(fixdir)
json.dump({
    "version": 1, "_doc": "test fixture",
    "vocabulary": {
        "fixture-a": {"probe": f"test -f {rel}/artifact-a", "remedy": "touch it",
                      "withdraw": [f"{rel}/artifact-a"], "why": "fixture"},
        "fixture-b": {"probe": f"test -f {rel}/artifact-b", "remedy": "touch it",
                      "withdraw": [f"{rel}/artifact-b"], "why": "fixture"},
    },
    "requires": {},
    "provenance": {"probed": False, "probed_at_head": None, "probed_at_utc": None,
                   "registry_gates_at_probe": 0, "gates_probed": 0, "probe_version": 1},
}, open(out, "w"), indent=2)
PY

FIX_REG="$SCRATCH/gate-registry.json"
printf '{"gates":[{"id":"stub-gate-1"},{"id":"stub-gate-2"}]}\n' > "$FIX_REG"

STUB="$SCRATCH/stub-runner.sh"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
# Emits the verdict shape sweep_verdicts() parses. Identical output every run, so any
# adjudication difference is attributable to the withdrawal, never to runner noise.
#
# It ALSO announces its preflight scope, exactly as the real runner does, because the probe
# now asserts that line as a POSITIVE CONTROL that its neutralized ledger reached the runner
# (see run_sweep in probe-gate-requires.sh). A stub that omits behaviour the caller depends
# on is a harness more permissive than production — which is how a check that cannot run at
# all still passes (M3). The count is read from the SoT the probe actually handed us, so
# PLANT 3 below can make it non-zero and prove the control fires.
_sot="${MASSU_REQUIRES_SOT:-}"
if [ -n "$_sot" ] && [ -r "$_sot" ]; then
  _n="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("requires",{})))' "$_sot" 2>/dev/null || echo 0)"
else
  _n=0
fi
echo "  preflight       : ${_n} requirement(s) over 2 selected gate(s)"
echo "OK [stub-gate-1]"
echo "OK [stub-gate-2]"
exit 0
EOF
chmod +x "$STUB"

run_probe() {   # $1 = script path; echoes exit code; output to $SCRATCH/out
  MASSU_PROBE_SOT="$FIX_SOT" MASSU_PROBE_REGISTRY="$FIX_REG" MASSU_PROBE_RUNNER="$STUB" \
    /bin/bash "$1" --write > "$SCRATCH/out" 2>&1
  echo $?
}
sot_probed() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["provenance"]["probed"])' "$FIX_SOT"; }
reset_sot()  { python3 - "$FIX_SOT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["requires"] = {}
d["provenance"] = {"probed": False, "probed_at_head": None, "probed_at_utc": None,
                   "registry_gates_at_probe": 0, "gates_probed": 0, "probe_version": 1}
json.dump(d, open(p, "w"), indent=2)
PY
}

echo "══ probe-gate-requires mutation proof ══"
echo "  bash            : ${BASH_VERSION}"
echo "  fixtures        : 2 requirements / 2 stub gates"
echo

# ── NEGATIVE CONTROL: unmutated copy must SUCCEED and WRITE ──────────────────────────────
# Runs first: if the harness cannot make a clean run pass, every later RED is meaningless.
echo "── CONTROL (unmutated) — must adjudicate 2 of 2, write, exit 0 ──"
cp "$PROBE" "$MUTANT"
reset_sot
rc="$(run_probe "$MUTANT")"
if [ "$rc" -eq 0 ]; then ok "clean run exits 0"; else
  bad "clean run exited $rc (expected 0)"; sed -n '1,40p' "$SCRATCH/out"; fi
if grep -q 'requirements adjudicated : 2 of 2' "$SCRATCH/out"; then
  ok "reports its denominator: $(grep -o 'requirements adjudicated : .*' "$SCRATCH/out")"
else bad "no 'requirements adjudicated : 2 of 2' line — the denominator is not reported (M1)"; fi
if [ "$(sot_probed)" = "True" ]; then ok "clean run WROTE the ledger (probed=true)"; else
  bad "clean run did not write the ledger — the harness cannot prove a refusal"; fi
echo

# ── PLANT 1: the ABORTED ADJUDICATION LOOP — the real 2026-07-28 defect's OBSERVABLE state ─
#
# ⚠ THIS PLANT USED TO BE PLATFORM-DEPENDENT, AND WAS THEREFORE DEAD IN CI (run 30493858521).
# It re-introduced the historical vehicle verbatim — `mapfile -t paths < <(…)`, a bash-4
# builtin — which is only a defect where `mapfile` does not exist. macOS /bin/bash is 3.2.57
# so it failed there; the CI runner is bash 5.2.21 where `mapfile` works perfectly, so the
# "planted defect" was correct code and the mutant did exactly what CONTROL does:
#
#     FAIL  mutant exited 0 — expected 2
#     FAIL  no 'adjudicated 0 of 2' — the gate did not report what it counted
#     FAIL  MUTANT WROTE THE LEDGER — the refusal did not hold
#
# All three read as guard defects. The guard was fine; the PLANT could not fire. The test even
# printed `bash : 5.2.21(1)-release` and never asserted anything about it (G9 — the two
# execution paths differ, and only one of them was ever proven).
#
# THE FIX IS TO PLANT THE PROPERTY, NOT THE VEHICLE. What the 2026-07-28 crash actually did
# was reach the WRITE phase having adjudicated ZERO requirements: `mapfile: command not found`
# left `paths` unbound, `set -u` terminated the enclosing LOOP (not the script), all six
# withdrawal sweeps were skipped, and the probe wrote `probed: true, gates_probed: 409` and
# exited 0. `continue` reproduces that observable state exactly — zero adjudications arriving
# at the write phase — and does so identically under bash 3.2 and bash 5.x.
echo "── PLANT 1 (adjudication loop skipped — the real 2026-07-28 defect) — must REFUSE, exit 2 ──"
cp "$PROBE" "$MUTANT"
python3 - "$MUTANT" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
# Anchored on the withdrawal loop specifically: `for name in $VOCAB_NAMES` appears three
# times in this script and the other two are unrelated passes.
anchor = 'for name in $VOCAB_NAMES; do\n  echo "── withdrawing: $name ──"\n'
if anchor not in src:
    sys.exit("PLANT-ANCHOR-MISSING: the withdrawal loop header has changed shape")
src = src.replace(anchor, anchor + '  continue  # AV-PLANT: adjudicate nothing\n', 1)
open(p, "w").write(src)
PY
if [ $? -ne 0 ]; then bad "plant program FAILED — the anchor has drifted"; fi
# Prove the plant is REAL before trusting the RED it produces. Text presence alone is the G2
# defect (a comment satisfies a grep), so the behavioural assertions below carry the proof:
# CONTROL reports `adjudicated : 2 of 2` and the mutant must report 0 of 2. A plant that
# cannot change that number is vacuous however present its text is.
if grep -q 'AV-PLANT: adjudicate nothing' "$MUTANT"; then ok "plant applied (loop body skips)"; else
  bad "plant NOT applied — a RED below would be unattributable"; fi
reset_sot
rc="$(run_probe "$MUTANT")"
if [ "$rc" -eq 2 ]; then ok "mutant exits 2 (was: exit 0 with a fabricated ledger)"; else
  bad "mutant exited $rc — expected 2"; fi
if grep -q 'adjudicated 0 of 2' "$SCRATCH/out"; then
  ok "names the shortfall: $(grep -o 'adjudicated 0 of 2.*' "$SCRATCH/out" | head -1)"
else bad "no 'adjudicated 0 of 2' — the gate did not report what it counted"; fi
if [ "$(sot_probed)" = "False" ]; then ok "ledger NOT written (probed still false)"; else
  bad "MUTANT WROTE THE LEDGER — the refusal did not hold"; fi
echo

# ── PLANT 2: a crashed withdraw-path extractor must not read as 'no paths' ───────────────
echo "── PLANT 2 (extractor crashes) — must exit 2, not record UNPROBEABLE ──"
cp "$PROBE" "$MUTANT"
python3 - "$MUTANT" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
start = src.index('  paths_raw="$(python3 -c')
end = src.index('")" || {', start)
src = src[:start] + '  paths_raw="$(python3 -c \'import sys; sys.exit(3)\'' + src[end:]
open(p, "w").write(src)
PY
if grep -q 'sys.exit(3)' "$MUTANT"; then ok "plant applied (extractor forced to exit 3)"; else
  bad "plant NOT applied — RED below unattributable"; fi
reset_sot
rc="$(run_probe "$MUTANT")"
if [ "$rc" -eq 2 ]; then ok "mutant exits 2 on a dead extractor"; else
  bad "mutant exited $rc — expected 2"; fi
if grep -q 'UNPROBEABLE' "$SCRATCH/out"; then
  bad "recorded UNPROBEABLE — an extractor failure was laundered into a finding"
else ok "did NOT record UNPROBEABLE (the failure stayed a failure)"; fi
if [ "$(sot_probed)" = "False" ]; then ok "ledger NOT written"; else
  bad "MUTANT WROTE THE LEDGER on a dead extractor"; fi
echo

# ── PLANT 3: the neutralization must actually reach the runner ───────────────────────────
# The probe measures which gates require which artifacts by WITHDRAWING one. The runner's
# preflight reads the ledger the probe WRITES and FATALs when a declared-required artifact is
# absent — precisely the state each withdrawal creates. So sweeps must run against a
# neutralized ledger, and a neutralization that silently fails to apply looks exactly like a
# healthy run until the first withdrawal aborts with zero verdicts.
#
# Measured 2026-07-28: that is not hypothetical. The probe succeeded once against an empty
# ledger (dc29151b), and the first re-run after its own output landed died on withdrawal 1.
# This plant hands the runner the UN-neutralized SoT; the probe must refuse.
echo "── PLANT 3 (neutralization defeated) — must REFUSE before withdrawing anything ──"
cp "$PROBE" "$MUTANT"
python3 - "$MUTANT" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
old = 'export MASSU_REQUIRES_SOT="$NEUTRAL_SOT"'
assert src.count(old) == 1, f"expected 1 export site, found {src.count(old)}"
# Point the runner back at the populated ledger — the exact defect, minus the crash.
src = src.replace(old, 'export MASSU_REQUIRES_SOT="$SOT"  # PLANT: neutralization defeated', 1)
old2 = '  MASSU_REQUIRES_SOT="$NEUTRAL_SOT" bash "$RUNNER" "$@" > "$_out" 2>&1'
assert src.count(old2) == 1, f"expected 1 chokepoint, found {src.count(old2)}"
src = src.replace(old2, '  MASSU_REQUIRES_SOT="$SOT" bash "$RUNNER" "$@" > "$_out" 2>&1', 1)
open(p, "w").write(src)
PY
if grep -q 'neutralization defeated' "$MUTANT"; then ok "plant applied (runner handed the populated ledger)"; else
  bad "plant NOT applied — RED below unattributable"; fi
reset_sot
# The fixture SoT must actually DECLARE something, or the plant is vacuous: handing over an
# empty ledger is indistinguishable from a neutralized one.
python3 - "$FIX_SOT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["requires"] = {"stub-gate-1": ["artifact-a"]}
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
if [ "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["requires"]))' "$FIX_SOT")" -gt 0 ]; then
  ok "fixture ledger is non-empty (the plant is not vacuous)"
else bad "fixture ledger empty — PLANT 3 proves nothing"; fi
rc="$(run_probe "$MUTANT")"
if [ "$rc" -eq 2 ]; then ok "mutant exits 2 when the neutralization does not reach the runner"; else
  bad "mutant exited $rc — expected 2"; fi
if grep -q 'did not reach the runner' "$SCRATCH/out"; then
  ok "names the evidence (the preflight positive control fired)"
else bad "refused without naming WHY — an unactionable refusal (M1)"; fi
if [ "$(sot_probed)" = "False" ]; then ok "ledger NOT written"; else
  bad "MUTANT WROTE THE LEDGER despite measuring against its own conclusions"; fi
reset_sot
echo

# ── the tree must be exactly as we found it ──────────────────────────────────────────────
echo "── restoration ──"
for f in artifact-a artifact-b; do
  [ -f "$FIXDIR/$f" ] && ok "fixture $f restored" || bad "fixture $f NOT restored — a withdrawal leaked"
done

echo
echo "══ paths proven RED : $PASSED   paths UNPROVEN : $FAILED ══"
[ "$FAILED" -eq 0 ] || exit 1
exit 0

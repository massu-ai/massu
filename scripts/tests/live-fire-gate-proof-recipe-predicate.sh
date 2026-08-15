#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────
# LIVE-FIRE (CR-72): the anti-vacuity completeness predicate must distinguish the two
# proof recipes it reads. Plants into the REAL scripts/lib/gate-registry.json, runs the
# REAL gate, demands RED FOR ITS OWN DECLARED REASON, restores from a `cp` aside, and
# asserts the registry is byte-identical by sha256.
#
# WHY THIS EXISTS. `has_proof` was `bool(companion_script or proof_script)` — any truthy
# string passed, so `companion` and `self-proving` were indistinguishable to the only
# check that classifies them. That is G28/CR-91: a scope predicate that is a CORRELATE
# ("a script is named") of the property it protects ("the named script is the right KIND
# of artifact for this recipe"). Three branches now express the property; each gets its
# own fixture here, because a rule with three paths and one fixture is two-thirds
# decoration (G18/CR-83).
#
# PAYLOAD SAFETY (G25/CR-88): every plant below is a JSON *string* edit applied by python
# to a copy of a data file. No plant introduces a shell metacharacter, a destructive
# token, or an executable path. If the predicate under test were fully disabled, the
# worst outcome is that this harness reports FAIL — nothing executes.
#
# GIT SAFETY (G29): this harness creates no repository and runs no git write command. It
# restores from a byte copy taken before the first plant, never `git checkout --` (which
# destroyed an uncommitted fix earlier in this repo's history, leaving a clean status).
# ─────────────────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

REGISTRY="scripts/lib/gate-registry.json"
GATE="scripts/massu-gate-anti-vacuity.sh"
[ -f "$REGISTRY" ] || { echo "FATAL: registry not found: $REGISTRY" >&2; exit 2; }
[ -f "$GATE" ]     || { echo "FATAL: gate not found: $GATE" >&2; exit 2; }

ASIDE="$(mktemp -t av-registry-aside.XXXXXX)"
LOG="$(mktemp -t av-live-fire-log.XXXXXX)"
cp "$REGISTRY" "$ASIDE" || { echo "FATAL: could not take the restore aside" >&2; exit 2; }
SHA_BEFORE="$(shasum -a 256 "$REGISTRY" | awk '{print $1}')"

FAILURES=0
restore() { cp "$ASIDE" "$REGISTRY"; }
# A single EXIT trap — bash REPLACES traps, so there is exactly one and it restores.
cleanup() { restore; rm -f "$ASIDE" "$LOG"; }
trap cleanup EXIT

note() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

# ── STEP 0 — NEGATIVE CONTROL: the gate must be GREEN on the pristine registry ───────────
# Without this, "it refused" and "it never ran" are indistinguishable (G7 aimed at the test).
note "── step 0: CONTROL — pristine registry must PASS ─────────────────────────────────"
bash "$GATE" --completeness-only > "$LOG" 2>&1
ctl=$?
if [ "$ctl" -ne 0 ]; then
  fail "CONTROL: the gate is already RED on the pristine registry (exit $ctl) — every plant below would be unattributable."
  sed -n '1,40p' "$LOG" >&2
  exit 1
fi
note "  OK: pristine registry passes (exit 0)."

# ── plant helper ────────────────────────────────────────────────────────────────────────
# Applies one mutation to the REAL registry via python, then asserts the file actually
# changed (the plant's own positive control — an inert plant proves nothing, and would
# otherwise read as a passing gate).
plant() {
  local label="$1" pycode="$2"
  restore
  python3 - "$REGISTRY" <<PY
import json, sys
p = sys.argv[1]
d = json.load(open(p))
gates = d["gates"]
$pycode
json.dump(d, open(p, "w"), indent=2)
PY
  if [ $? -ne 0 ]; then fail "$label: the plant script itself errored"; return 1; fi
  if cmp -s "$REGISTRY" "$ASIDE"; then
    fail "$label: PLANT WAS INERT — registry unchanged, so a RED verdict could not be attributed to it"
    return 1
  fi
  return 0
}

# Demands the gate go RED *and* that its output names the declared reason for THIS branch.
# An assertion satisfied by a different line than the one it names is a known false pass.
expect_red() {
  local label="$1" needle="$2"
  bash "$GATE" --completeness-only > "$LOG" 2>&1
  local ec=$?
  if [ "$ec" -eq 0 ]; then
    fail "$label: gate stayed GREEN on a planted defect — the branch is DEAD"
    return 1
  fi
  if ! grep -qF -- "$needle" "$LOG"; then
    fail "$label: gate went RED (exit $ec) but for the WRONG reason — expected text not found: $needle"
    note "  ---- gate output (tail) ----"; tail -20 "$LOG" >&2
    return 1
  fi
  note "  OK: RED (exit $ec) naming its own reason."
  return 0
}

# ── PLANT 1 — a `companion` row that names ITSELF ───────────────────────────────────────
note "── plant 1: recipe=companion naming itself (the collapse into self-proving) ───────"
if plant "plant-1" '
target = next(g for g in gates if g.get("recipe") == "companion")
target["companion_script"] = target["path"]
target.pop("proof_script", None)
'; then
  expect_red "plant-1" "must name a DISTINCT artifact"
fi

# ── PLANT 2 — a `self-proving` row that names a DIFFERENT script ─────────────────────────
note "── plant 2: recipe=self-proving naming another artifact ──────────────────────────"
if plant "plant-2" '
target = next(g for g in gates if g.get("recipe") == "self-proving")
other  = next(g["path"] for g in gates
              if g.get("recipe") == "self-proving" and g.get("path") != target.get("path"))
target["proof_script"] = other
target.pop("companion_script", None)
'; then
  expect_red "plant-2" "must name ITSELF"
fi

# ── PLANT 3 — a proof script that DOES NOT EXIST ────────────────────────────────────────
note "── plant 3: proof script naming a path that is not on disk ───────────────────────"
if plant "plant-3" '
target = next(g for g in gates if g.get("recipe") == "self-proving")
target["proof_script"] = "scripts/tests/this-proof-does-not-exist.sh"
target.pop("companion_script", None)
'; then
  expect_red "plant-3" "does not exist"
fi

# ── RESTORE + byte-identity assertion ───────────────────────────────────────────────────
note "── restore: the real registry must come back byte-identical ──────────────────────"
restore
SHA_AFTER="$(shasum -a 256 "$REGISTRY" | awk '{print $1}')"
if [ "$SHA_BEFORE" != "$SHA_AFTER" ]; then
  fail "RESTORE LEAKED — registry sha256 changed: $SHA_BEFORE -> $SHA_AFTER"
else
  note "  OK: sha256 identical ($SHA_AFTER)."
fi

# The gate must also OPEN again on the restored tree — a gate that stays red is a brick.
bash "$GATE" --completeness-only > "$LOG" 2>&1
if [ $? -ne 0 ]; then
  fail "the gate is RED after restore — it has become a brick"
else
  note "  OK: gate GREEN again after restore."
fi

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "RESULT: FAIL — $FAILURES check(s) failed. attempted 3 plant(s) + 2 control(s)."
  exit 1
fi
echo "RESULT: PASS — 3 plant(s) each RED for their own declared reason; 2 control(s) green; registry byte-identical."
exit 0

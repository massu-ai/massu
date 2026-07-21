#!/usr/bin/env bash
# scripts/tests/test-anti-vacuity-runner-mutation.sh
#
# P7a (plan-2026-07-15-wave-1-g6-anti-vacuity-registry §4, CR-72 / M4) — mutation-test the
# anti-vacuity RUNNER itself. The runner is the product of Wave 1: it must be attacked hardest.
#
# A gate nobody attacked is a brick, and a brick emits the same silence as a working gate. So
# we PLANT the exact defects the runner exists to catch — IN THE REAL TREE (CR-72; a fixture-only
# mutation test is a regression test in disguise, and a regression test cannot find a false
# negative) — run the REAL runner, and demand the expected outcome each time:
#
#   1. DECORATION      — a blind check (a fixture that cannot fail) → runner reports DECORATION + exits nonzero
#   2. CANARY ABORT    — neuter the known-good Check 3 → runner aborts LOUD (exit 2), not a wall of false positives
#   3. MISSING FIXTURE — delete a registry fixture → --completeness-only FAIL
#   4. HOLLOW FIXTURE  — gut a fixture to empty defects (and, separately, empty oracle) → --completeness-only FAIL
#   5. SYMBOL-GREP BAN — add a comment-satisfiable `grep -q "Sym" file` predicate → ban FAIL
#   6. GREP PORTABILITY— the T-1 (Check 9 ERE) and T-2 (Check 40g pipe) fixes go RED under BOTH
#                        /usr/bin/grep (BSD on macOS / GNU on CI) AND ggrep (GNU) when present (M3)
#   7. GENUINE GREEN   — a real known-good gate DEFEATs and goes RED (the anti-brick proof)
#
# Every plant is restored (content AND mtime — the mutation-mtime memory) in a `trap … EXIT`,
# and `git status --porcelain` for the touched files is asserted EMPTY at the START and the END
# (a SIGKILL will not fire the trap, so a start-of-run assertion is the only way to tell "my
# plant leaked" from "the tree was already dirty").
#
# Canonical runner: bash scripts/massu-gate-anti-vacuity.sh. NODE_PATH is set by the runner.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RUNNER="scripts/massu-gate-anti-vacuity.sh"
SCANNER="scripts/massu-pattern-scanner.sh"
REGISTRY="scripts/lib/gate-registry.json"
RATCHET="scripts/lib/symbol-grep-ratchet.json"
BLIND_SCANNER="scripts/massu-p7a-blindtest-scanner.sh"   # matches the discoverer's SCANNER_NAME_RE 'scanner\.sh$'

CANARY_GID="pattern-scanner-3--faeef9064c"   # Check 3: no process.exit() in library code (the canary)
T1_GID="pattern-scanner-9--2ead743cf2"       # Check 9  (T-1: the fixed ERE `new Database(`)
T2_GID="pattern-scanner-40--0374c57738"      # Check 40 (T-2: the fixed render-key-from-env pipe)

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
PASS=0; FAIL=0
_ok()  { printf '  %sOK%s   %s\n'   "$GREEN" "$NC" "$1"; PASS=$((PASS + 1)); }
_bad() { printf '  %sFAIL%s %s\n'   "$RED"   "$NC" "$1"; FAIL=$((FAIL + 1)); }

TOUCHED=("$SCANNER" "$REGISTRY" "$RATCHET")

porcelain() { git status --porcelain -- "${TOUCHED[@]}" 2>/dev/null; }

# ── M2 / CR-72: the tree MUST be clean before we plant. A leaked plant from a prior SIGKILL is
#    otherwise indistinguishable from a real bug. ──
if [ -n "$(porcelain)" ] || [ -e "$BLIND_SCANNER" ]; then
  echo "${RED}FATAL${NC}: target tree already dirty before the test — refusing to run:" >&2
  porcelain >&2
  [ -e "$BLIND_SCANNER" ] && echo "  leaked blind scanner: $BLIND_SCANNER" >&2
  exit 2
fi

# Snapshot (content + mtime) every tracked file we might mutate; restore + drop the blind scanner on exit.
SNAP="$(mktemp -d)"
snap_key() { printf '%s' "$1" | tr '/' '_'; }
for f in "${TOUCHED[@]}"; do cp -p "$f" "$SNAP/$(snap_key "$f")"; done
restore() {
  for f in "${TOUCHED[@]}"; do
    s="$SNAP/$(snap_key "$f")"
    [ -f "$s" ] && cp -p "$s" "$f"
  done
  rm -f "$BLIND_SCANNER"
}
cleanup() { restore; rm -rf "$SNAP"; }
trap cleanup EXIT

# Run the runner; capture combined output + exit code into globals RUN_OUT / RUN_EC.
run_runner() {
  RUN_OUT="$(bash "$RUNNER" "$@" 2>&1)"
  RUN_EC=$?
}

echo "════════════════════════════════════════════════════════════════════════"
echo " P7a — mutation-testing the anti-vacuity runner (CR-72 / M4, real tree)"
echo "════════════════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────────────────────────────────
# 1. DECORATION — a blind check (a fixture that cannot fail) must be reported DECORATION.
# ─────────────────────────────────────────────────────────────────────────────────────────
restore
cat > "$BLIND_SCANNER" <<'BLIND'
#!/usr/bin/env bash
# P7A MUTATION-TEST BLIND SCANNER — created and removed by test-anti-vacuity-runner-mutation.sh.
# This check ANNOUNCES itself (so the discoverer finds a fail-point) but its `fail` is guarded by
# a literal `false` and can NEVER fire. A registry fixture that plants an ORACLE-confirmed defect
# will find this check STILL GREEN → the runner must report DECORATION. A check that cannot fail
# is decoration; the runner exists to catch exactly this.
fail() { echo "FAIL: $*"; }
echo "Check 91: p7a blind decoration check (mutation-test)"
if false; then
  fail "Check 91: p7a blind decoration fail-point (mutation-test) never reached"
fi
exit 0
BLIND

# Discover the blind fail-point's id, then register a NON-HOLLOW fixture for it (write + oracle).
BLIND_FP_JSON="$(python3 scripts/tests/_discover_scanner_checks.py --repo-root "$REPO_ROOT" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
fp=[f for f in d["fail_points"] if f["scanner"].endswith("p7a-blindtest-scanner.sh")]
print(json.dumps(fp[0]) if fp else "")')"
if [ -z "$BLIND_FP_JSON" ]; then
  _bad "DECORATION: the discoverer did not find the blind scanner's fail-point (test scaffold broke)"
else
  BLIND_ID="$(printf '%s' "$BLIND_FP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  python3 - "$REGISTRY" "$BLIND_ID" "$BLIND_SCANNER" <<'PY'
import json, sys
reg_path, gid, scanner = sys.argv[1], sys.argv[2], sys.argv[3]
reg = json.load(open(reg_path))
reg["gates"].append({
    "id": gid,
    "scanner": scanner,
    "check": "91",
    "title": "p7a blind decoration check (mutation-test)",
    "defects": [{
        "name": "blind-probe",
        "write": {"p7a-decoration-probe.txt": "planted\n"},
        "oracle": "test -f p7a-decoration-probe.txt",
    }],
})
json.dump(reg, open(reg_path, "w"), indent=2)
PY
  run_runner --gate "$BLIND_ID"
  if [ "$RUN_EC" -ne 0 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -q 'IT IS DECORATION'; then
    _ok "DECORATION: blind check reported DECORATION and exited nonzero ($RUN_EC)"
  else
    _bad "DECORATION: expected DECORATION + nonzero exit; got exit=$RUN_EC (blind check not caught)"
  fi
fi
restore

# ─────────────────────────────────────────────────────────────────────────────────────────
# 2. CANARY ABORT — neuter the known-good Check 3; the runner must abort LOUD (exit 2), NOT
#    emit a wall of false "decoration" findings. (Fires only when the canary is selected.)
# ─────────────────────────────────────────────────────────────────────────────────────────
restore
# Neuter Check 3: make its fail unreachable by forcing the guard false. Targeted + unique
# (`PROCESS_EXIT_COUNT` appears only in Check 3), restored from the snapshot afterward.
python3 - "$SCANNER" <<'PY'
import io, sys
p = sys.argv[1]
s = open(p).read()
needle = 'if [ "$PROCESS_EXIT_COUNT" -gt 0 ]; then'
assert s.count(needle) == 1, f"expected exactly 1 Check-3 guard, found {s.count(needle)}"
open(p, "w").write(s.replace(needle, "if false; then  # P7A-NEUTERED", 1))
PY
run_runner --gate "$CANARY_GID"
if [ "$RUN_EC" -eq 2 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -q 'FATAL (CANARY)'; then
  _ok "CANARY ABORT: neutered Check 3 → runner aborted LOUD (exit 2, FATAL (CANARY))"
else
  _bad "CANARY ABORT: expected exit 2 + 'FATAL (CANARY)'; got exit=$RUN_EC"
fi
restore

# ─────────────────────────────────────────────────────────────────────────────────────────
# 3. MISSING FIXTURE — delete a registry gate → --completeness-only must FAIL (missing proof).
# ─────────────────────────────────────────────────────────────────────────────────────────
restore
python3 - "$REGISTRY" "$T1_GID" <<'PY'
import json, sys
reg_path, gid = sys.argv[1], sys.argv[2]
reg = json.load(open(reg_path))
reg["gates"] = [g for g in reg["gates"] if g["id"] != gid]
json.dump(reg, open(reg_path, "w"), indent=2)
PY
run_runner --completeness-only
if [ "$RUN_EC" -ne 0 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -qE 'have (NO|NEITHER a) can-fail proof'; then
  _ok "MISSING FIXTURE: deleted a fixture → completeness FAILed ($RUN_EC)"
else
  _bad "MISSING FIXTURE: expected completeness FAIL; got exit=$RUN_EC"
fi
restore

# ─────────────────────────────────────────────────────────────────────────────────────────
# 4. HOLLOW FIXTURE — gut a gate to empty `defects` (then, separately, empty `oracle`) → FAIL.
#    Distinct from the delete above: the id is still PRESENT, so only a non-hollow check catches it.
# ─────────────────────────────────────────────────────────────────────────────────────────
restore
python3 - "$REGISTRY" "$T1_GID" <<'PY'
import json, sys
reg_path, gid = sys.argv[1], sys.argv[2]
reg = json.load(open(reg_path))
for g in reg["gates"]:
    if g["id"] == gid:
        g["defects"] = []   # id present, but no can-fail proof
json.dump(reg, open(reg_path, "w"), indent=2)
PY
run_runner --completeness-only
HOLLOW_EMPTY_OK=0
if [ "$RUN_EC" -ne 0 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -q 'HOLLOW'; then HOLLOW_EMPTY_OK=1; fi
restore
# Second hollow shape: a defect present but with an empty oracle.
python3 - "$REGISTRY" "$T1_GID" <<'PY'
import json, sys
reg_path, gid = sys.argv[1], sys.argv[2]
reg = json.load(open(reg_path))
for g in reg["gates"]:
    if g["id"] == gid and g.get("defects"):
        g["defects"][0]["oracle"] = ""   # a defect with no oracle is decoration wearing a fixture's clothes
json.dump(reg, open(reg_path, "w"), indent=2)
PY
run_runner --completeness-only
HOLLOW_ORACLE_OK=0
if [ "$RUN_EC" -ne 0 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -q 'HOLLOW'; then HOLLOW_ORACLE_OK=1; fi
restore
if [ "$HOLLOW_EMPTY_OK" -eq 1 ] && [ "$HOLLOW_ORACLE_OK" -eq 1 ]; then
  _ok "HOLLOW FIXTURE: empty-defects AND empty-oracle both FAILed completeness"
else
  _bad "HOLLOW FIXTURE: empty-defects ok=$HOLLOW_EMPTY_OK, empty-oracle ok=$HOLLOW_ORACLE_OK (both must FAIL)"
fi

# ─────────────────────────────────────────────────────────────────────────────────────────
# 5. SYMBOL-GREP BAN — inject a comment-satisfiable `grep -q "Sym" "$file"` predicate into a
#    real scanner check → the ban must FAIL (a bare identifier is not a gate; T-3).
# ─────────────────────────────────────────────────────────────────────────────────────────
restore
# Append a fresh check block whose pass/fail hinges on a bare-literal symbol grep.
cat >> "$SCANNER" <<'SG'

# P7A MUTATION-TEST — a comment-satisfiable symbol grep (removed by the test's restore).
echo "Check 92: p7a symbol-grep ban probe (mutation-test)"
if grep -q "P7aBlindSymbolProbe" "$SRC_DIR/config.ts"; then
  pass "Check 92: probe present"
fi
SG
run_runner --completeness-only
if [ "$RUN_EC" -ne 0 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -q 'symbol-grep'; then
  _ok "SYMBOL-GREP BAN: a new comment-satisfiable predicate → ban FAILed ($RUN_EC)"
else
  _bad "SYMBOL-GREP BAN: expected the ban to FAIL on a new predicate; got exit=$RUN_EC"
fi
restore

# ─────────────────────────────────────────────────────────────────────────────────────────
# 6. GREP PORTABILITY (M3) — the T-1 and T-2 DEFEAT fixtures must go RED under BOTH the real
#    /usr/bin/grep AND ggrep (GNU) when present. A check alive under one grep and dead under
#    another is half-built (§0.2 ugrep-shim incident). Denominator (M1): print the greps tried.
# ─────────────────────────────────────────────────────────────────────────────────────────
GREP_BIN_BSD="/usr/bin/grep"
GREP_BIN_GNU="$(command -v ggrep || true)"
grep_defeat_red() { # $1 = path to a grep binary, $2 = gate id, $3 = label
  local gbin="$1" gid="$2" label="$3"
  local shim="$SNAP/grepbin-$label"
  rm -rf "$shim"; mkdir -p "$shim"
  ln -sf "$gbin" "$shim/grep"
  local out ec
  out="$(PATH="$shim:$PATH" bash "$RUNNER" --gate "$gid" 2>&1)"; ec=$?
  rm -rf "$shim"
  [ "$ec" -eq 0 ] && printf '%s' "$out" | /usr/bin/grep -q 'went RED'
}
GREPS_TRIED=0; GREP_ALL_RED=1
for pair in "BSD:$GREP_BIN_BSD" "GNU:$GREP_BIN_GNU"; do
  gl="${pair%%:*}"; gb="${pair#*:}"
  [ -z "$gb" ] && { echo "  ${YELLOW}NOTE${NC}: $gl grep not present — grep '$gl' half of M3 not exercised here"; continue; }
  [ -x "$gb" ] || [ -e "$gb" ] || { echo "  ${YELLOW}NOTE${NC}: $gl grep ($gb) not runnable — skipped"; continue; }
  GREPS_TRIED=$((GREPS_TRIED + 1))
  if grep_defeat_red "$gb" "$T1_GID" "t1$gl" && grep_defeat_red "$gb" "$T2_GID" "t2$gl"; then
    echo "  ${GREEN}·${NC} T-1 and T-2 DEFEAT went RED under $gl grep ($gb)"
  else
    GREP_ALL_RED=0
    echo "  ${RED}·${NC} T-1/T-2 DEFEAT did NOT go RED under $gl grep ($gb)"
  fi
done
if [ "$GREPS_TRIED" -eq 0 ]; then
  _bad "GREP PORTABILITY: scanned 0 grep binaries — cannot report clean (M1)"
elif [ "$GREP_ALL_RED" -eq 1 ]; then
  _ok "GREP PORTABILITY: T-1 + T-2 went RED under all $GREPS_TRIED grep binary(ies) tried"
else
  _bad "GREP PORTABILITY: a T-1/T-2 DEFEAT failed to go RED under some grep (half-built)"
fi

# ─────────────────────────────────────────────────────────────────────────────────────────
# 7. GENUINE GREEN (anti-brick) — a real known-good gate must DEFEAT and go RED on a clean tree.
#    A runner that RED-flags everything is as useless as one that fails on nothing.
# ─────────────────────────────────────────────────────────────────────────────────────────
restore
run_runner --gate "$CANARY_GID"
if [ "$RUN_EC" -eq 0 ] && printf '%s' "$RUN_OUT" | /usr/bin/grep -q 'went RED. This is a gate.'; then
  _ok "GENUINE GREEN: a known-good gate DEFEATed and went RED on the clean tree (exit 0)"
else
  _bad "GENUINE GREEN: expected exit 0 + a genuine RED; got exit=$RUN_EC (the runner may be a brick)"
fi
restore

# ── FINAL: the tree must be byte-identical to how we found it (CR-72 / mutation-mtime). ──
LEAK="$(porcelain)"
if [ -n "$LEAK" ] || [ -e "$BLIND_SCANNER" ]; then
  echo
  echo "${RED}FATAL${NC}: the test LEAKED changes into the working tree (restore is incomplete):" >&2
  [ -n "$LEAK" ] && printf '%s\n' "$LEAK" >&2
  [ -e "$BLIND_SCANNER" ] && echo "  leaked blind scanner: $BLIND_SCANNER" >&2
  FAIL=$((FAIL + 1))
else
  _ok "RESTORE: working tree byte-identical (git status --porcelain empty; blind scanner removed)"
fi

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "${RED}FAIL${NC}: the anti-vacuity runner did not behave correctly under mutation."
  exit 1
fi
echo "${GREEN}PASS${NC}: the runner catches decoration, aborts on a defeated canary, fails on"
echo "       missing/hollow fixtures and new symbol-greps, fires under every grep, and still"
echo "       goes GREEN on a genuine success. The meta-gate can fail."
exit 0

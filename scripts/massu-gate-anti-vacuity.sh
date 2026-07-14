#!/usr/bin/env bash
#
# G-6 — THE ANTI-VACUITY REGISTRY (the meta-gate)
#
#   "A gate is not proven until you have tried to DEFEAT it. Reintroduce the defect on a
#    scratch copy and demand the gate go RED. Asserting it still flags the cases you already
#    know about is a REGRESSION test — and a regression test cannot find a FALSE NEGATIVE."
#                                                                        — CR-52, rule 3
#
# WHAT THIS EXISTS TO KILL (all three REPRODUCED AND DEFEATED by execution, 2026-07-14):
#
#   T-1  pattern-scanner Check 9's regex is a hard SYNTAX ERROR (`sqlite3\(` — unbalanced
#        paren in a BRE). grep exits 1, stderr is swallowed by `2>/dev/null`, the count is
#        0, and the check reports PASS. It has NEVER run. Planting a real
#        `new Database('/tmp/pwned.db')` still yields "uses DB accessor functions only".
#
#   T-2  pattern-scanner Check 40(g) pipes `grep -q` into `grep -qv`. `-q` is QUIET: it
#        prints nothing. So the right-hand grep always reads EMPTY stdin and always exits
#        non-zero. The condition CANNOT be true. A production `process.env.MASSU_RENDER_KEY`
#        — the exact forgery vector it forbids — leaves it silent.
#
#   T-3  8 checks decide pass/fail by grepping for a bare SYMBOL. A COMMENT satisfies them.
#        Deleting every real call to `assertAutoLearningEntitled` and leaving the identifier
#        in a comment still yields "Check 30: Auto-learning tier-gate wiring (CR-54)" PASS.
#
# Every one of those checks was GREEN. Green measured the code's agreement with itself.
#
# ── HOW IT WORKS ────────────────────────────────────────────────────────────────────────
# For every check DISCOVERED in the tree (never a hand-typed list — see
# scripts/tests/_discover_scanner_checks.py), the registry must supply at least one
# violating-input fixture. For each fixture we assert FOUR things, in order:
#
#   1. CONTROL    — on the pristine tree the check is GREEN. (A check that is already RED
#                   would pass a defeat test trivially, for the wrong reason.)
#   2. PLANT      — the mutation actually changed the scratch tree. A defeat test that
#                   fails to plant its defect is itself vacuous.
#   3. ORACLE     — an INDEPENDENT command proves the planted defect is genuinely present.
#                   Without this, "my fixture was bogus" and "the check is blind" produce
#                   byte-identical output — which is the very conflation (CR-65) this whole
#                   workstream exists to end.
#   4. DEFEAT     — the check goes RED on the mutated tree. If it stays GREEN: it is
#                   DECORATION, and CI fails.
#
# Plus two registry-level gates:
#   COMPLETENESS  — every discovered check has a fixture. A check with no can-fail proof
#                   FAILS CI. (This is what makes the gate survive the next check someone adds.)
#   SYMBOL-GREP   — no check may decide pass/fail on the presence of a bare identifier.
#                   Known offenders are held in a SHRINK-ONLY ratchet; a NEW one fails CI.
#
# Nothing real is ever mutated. All work happens on scratch copies. PROVE BEFORE YOU DESTROY.
#
# Usage:
#   bash scripts/massu-gate-anti-vacuity.sh              # all gates
#   bash scripts/massu-gate-anti-vacuity.sh --gate pattern-scanner-9
#   bash scripts/massu-gate-anti-vacuity.sh --completeness-only
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="$REPO_ROOT/scripts/lib/gate-registry.json"
DISCOVER="$REPO_ROOT/scripts/tests/_discover_scanner_checks.py"
RATCHET="$REPO_ROOT/scripts/lib/symbol-grep-ratchet.json"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

ONLY_GATE=""
COMPLETENESS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --gate) ONLY_GATE="${2:-}"; shift 2 ;;
    --completeness-only) COMPLETENESS_ONLY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# FAIL CLOSED: a missing registry or discoverer must never read as "nothing to check".
for f in "$REGISTRY" "$DISCOVER"; do
  if [ ! -f "$f" ]; then
    echo "${RED}FATAL${NC}: missing $f — refusing to report success. (Cannot-see is not nothing-found.)" >&2
    exit 2
  fi
done

FAILURES=0
PROVEN=0

# ── Scratch pristine copy of the tree (once) ────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PRISTINE="$TMP/pristine"
WORK="$TMP/work"

RSYNC_EXCLUDES=(
  --exclude node_modules --exclude .git --exclude dist --exclude coverage
  --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm'
  --exclude .next --exclude '*.tsbuildinfo'
)
echo "Preparing scratch tree..."
rsync -a "${RSYNC_EXCLUDES[@]}" "$REPO_ROOT/" "$PRISTINE/" || {
  echo "${RED}FATAL${NC}: could not build the scratch tree." >&2; exit 2; }

# ── strip ANSI: the scanners colorize, so "FAIL:" is really "FAIL\033[0m:" ──────────────
# A naive grep for 'FAIL:' matches NOTHING against colorized output — a parser that
# silently matches nothing would make every gate look proven. Strip first, always.
strip_ansi() { sed -E $'s/\033\\[[0-9;]*[A-Za-z]//g'; }

# Run one scanner inside a tree, return its de-colorized output.
run_scanner() { # $1 = tree, $2 = scanner relpath
  ( cd "$1" && bash "$1/$2" 2>&1 | strip_ansi )
}

# Did the named check report a FAIL line?
#
# ⚠️ SECTIONAL ATTRIBUTION — do NOT match `FAIL: Check N`.
#
# Most checks do NOT name themselves in their failure text. Check 3 fails with
#     FAIL: Found 1 process.exit() calls in library code
# — the string "Check 3" appears ONLY in the section header. A matcher keyed on
# "FAIL: Check N" therefore matches NOTHING for those checks and reports a perfectly
# working gate as DECORATION.
#
# That is not hypothetical: the first version of THIS FILE did exactly that, and called
# Check 3 decoration while Check 3 was busy correctly failing. The gate built to catch
# blind gates was blind, in the same way, for the same reason — a pattern that silently
# matches nothing (CR-65: broken and empty rendered identically).
#
# So: walk the output, track the current `Check N:` header, and attribute every FAIL line
# to the section it falls in.
check_is_red() { # $1 = scanner output, $2 = check number
  printf '%s' "$1" | python3 -c '
import re, sys
want = sys.argv[1]
cur = None
for line in sys.stdin:
    h = re.match(r"^Check ([0-9]+[a-z]?):", line)
    if h:
        cur = h.group(1)
        continue
    if cur == want and re.match(r"^\s*FAIL:", line):
        sys.exit(0)   # RED
sys.exit(1)           # not red
' "$2"
}

# ── COMPLETENESS: every DISCOVERED check must carry a can-fail proof ───────────────────
echo
echo "════ COMPLETENESS — every discovered check must ship a violating-input fixture ════"
python3 "$DISCOVER" --repo-root "$REPO_ROOT" > "$TMP/discovered.json" || {
  echo "${RED}FATAL${NC}: discovery failed." >&2; exit 2; }

MISSING="$(python3 - "$TMP/discovered.json" "$REGISTRY" <<'PY'
import json, sys
disc = json.load(open(sys.argv[1]))
reg  = json.load(open(sys.argv[2]))
have = {g["id"] for g in reg.get("gates", [])}
missing = [c["id"] for c in disc["checks"] if c["id"] not in have]
# A registry entry for a check that NO LONGER EXISTS is also drift — report it.
stale = sorted(have - {c["id"] for c in disc["checks"]})
print(json.dumps({"missing": missing, "stale": stale}))
PY
)"
N_MISSING=$(printf '%s' "$MISSING" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["missing"]))')
N_STALE=$(printf '%s' "$MISSING" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["stale"]))')

if [ "$N_MISSING" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $N_MISSING discovered check(s) have NO can-fail proof:"
  printf '%s' "$MISSING" | python3 -c 'import json,sys
for c in json.load(sys.stdin)["missing"]: print("          -", c)'
  echo "         A check with no can-fail proof is not a gate. Add a fixture to scripts/lib/gate-registry.json."
  FAILURES=$((FAILURES + 1))
else
  echo "  ${GREEN}OK${NC}: all discovered checks carry a can-fail proof."
fi
if [ "$N_STALE" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $N_STALE registry entr(ies) reference a check that no longer exists:"
  printf '%s' "$MISSING" | python3 -c 'import json,sys
for c in json.load(sys.stdin)["stale"]: print("          -", c)'
  FAILURES=$((FAILURES + 1))
fi

# ── SYMBOL-GREP BAN (T-3): a comment may not satisfy a gate ─────────────────────────────
echo
echo "════ SYMBOL-GREP BAN — a bare identifier is not a gate (T-3) ════"
SG_RESULT="$(python3 - "$TMP/discovered.json" "$RATCHET" <<'PY'
import json, os, sys
disc = json.load(open(sys.argv[1]))
ratchet_path = sys.argv[2]
allowed = set()
bound = 0
if os.path.exists(ratchet_path):
    r = json.load(open(ratchet_path))
    allowed = {f"{x['scanner']}:{x['check']}:{x['symbol']}" for x in r.get("known", [])}
    bound = r.get("max", len(allowed))
current = {f"{x['scanner']}:{x['check']}:{x['symbol']}" for x in disc["symbol_greps"]}
new = sorted(current - allowed)
print(json.dumps({"count": len(current), "bound": bound, "new": new}))
PY
)"
SG_COUNT=$(printf '%s' "$SG_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])')
SG_BOUND=$(printf '%s' "$SG_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["bound"])')
SG_NEW=$(printf '%s' "$SG_RESULT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["new"]))')

if [ "$SG_NEW" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $SG_NEW NEW symbol-grep predicate(s) — a comment would satisfy these:"
  printf '%s' "$SG_RESULT" | python3 -c 'import json,sys
for s in json.load(sys.stdin)["new"]: print("          -", s)'
  echo "         Assert BEHAVIOR AT A CALL SITE, not the presence of an identifier."
  FAILURES=$((FAILURES + 1))
elif [ "$SG_COUNT" -gt "$SG_BOUND" ]; then
  echo "  ${RED}FAIL${NC}: symbol-grep ratchet BREACHED — $SG_COUNT > bound $SG_BOUND (shrink-only)."
  FAILURES=$((FAILURES + 1))
else
  echo "  ${YELLOW}RATCHET${NC}: $SG_COUNT known symbol-grep predicate(s), bound $SG_BOUND (shrink-only; no new ones)."
  [ "$SG_COUNT" -eq 0 ] && echo "  ${GREEN}OK${NC}: zero symbol-greps remain."
fi

if [ "$COMPLETENESS_ONLY" -eq 1 ]; then
  echo
  [ "$FAILURES" -gt 0 ] && { echo "${RED}FAIL${NC}: $FAILURES registry-level gate(s) failed."; exit 1; }
  echo "${GREEN}PASS${NC}: registry-level gates green."; exit 0
fi

# ── PER-GATE: CONTROL -> PLANT -> ORACLE -> DEFEAT ──────────────────────────────────────
echo
echo "════ DEFEAT — plant each violating input and demand the check goes RED ════"

GATE_IDS=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
only=sys.argv[2]
for g in reg["gates"]:
    if not only or g["id"]==only: print(g["id"])
' "$REGISTRY" "$ONLY_GATE")

if [ -z "$GATE_IDS" ]; then
  echo "${RED}FATAL${NC}: no gates selected — refusing to exit 0 on an empty run." >&2
  exit 2
fi

for gid in $GATE_IDS; do
  SCANNER=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g["scanner"])' "$REGISTRY" "$gid")
  CHECKNUM=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g["check"])' "$REGISTRY" "$gid")
  TITLE=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g.get("title",""))' "$REGISTRY" "$gid")

  echo
  echo "── $gid — Check $CHECKNUM: $TITLE"

  # 1. CONTROL — green on the pristine tree.
  CONTROL_OUT="$(run_scanner "$PRISTINE" "$SCANNER")"
  if check_is_red "$CONTROL_OUT" "$CHECKNUM"; then
    echo "   ${RED}FAIL${NC}  CONTROL: Check $CHECKNUM is ALREADY RED on the pristine tree."
    echo "          A defeat test against an already-failing check proves nothing. Fix the tree first."
    FAILURES=$((FAILURES + 1))
    continue
  fi
  echo "   ${GREEN}ok${NC}    CONTROL: green on the pristine tree"

  # Each defect fixture for this gate.
  NDEF=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(len(g.get("defects",[])))' "$REGISTRY" "$gid")

  if [ "$NDEF" -eq 0 ]; then
    echo "   ${RED}FAIL${NC}  no defect fixture — this check has no can-fail proof."
    FAILURES=$((FAILURES + 1))
    continue
  fi

  for i in $(seq 0 $((NDEF - 1))); do
    DNAME=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g["defects"][int(sys.argv[3])]["name"])' "$REGISTRY" "$gid" "$i")

    # Fresh work tree from pristine (delta rsync — fast).
    rm -rf "$WORK"; cp -R "$PRISTINE" "$WORK"

    # 2. PLANT the defect.
    PLANTED=$(python3 - "$REGISTRY" "$gid" "$i" "$WORK" <<'PY'
import json, os, re, sys
reg_path, gid, idx, work = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
g = [x for x in json.load(open(reg_path))["gates"] if x["id"] == gid][0]
d = g["defects"][idx]
changed = 0

for rel, content in d.get("write", {}).items():
    p = os.path.join(work, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    before = open(p).read() if os.path.exists(p) else None
    open(p, "w").write(content)
    if before != content:
        changed += 1

for rel in d.get("delete", []):
    p = os.path.join(work, rel)
    if os.path.exists(p):
        os.remove(p); changed += 1

for op in d.get("replace", []):
    p = os.path.join(work, op["path"])
    if not os.path.exists(p):
        continue
    s = open(p).read()
    new = re.sub(op["pattern"], op["replace"], s, flags=re.M)
    if new != s:
        open(p, "w").write(new); changed += 1

print(changed)
PY
)
    if [ "${PLANTED:-0}" -eq 0 ]; then
      echo "   ${RED}FAIL${NC}  [$DNAME] PLANT: the mutation changed NOTHING."
      echo "          A defeat test that fails to plant its defect is itself vacuous."
      FAILURES=$((FAILURES + 1))
      continue
    fi

    # 3. ORACLE — independent proof the planted defect is genuinely present.
    ORACLE=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g["defects"][int(sys.argv[3])].get("oracle",""))' "$REGISTRY" "$gid" "$i")
    if [ -z "$ORACLE" ]; then
      echo "   ${RED}FAIL${NC}  [$DNAME] no ORACLE. Without one, 'my fixture was bogus' and 'the check is"
      echo "          blind' are indistinguishable — the exact conflation this gate exists to end."
      FAILURES=$((FAILURES + 1))
      continue
    fi
    if ! ( cd "$WORK" && bash -c "$ORACLE" >/dev/null 2>&1 ); then
      echo "   ${RED}FAIL${NC}  [$DNAME] ORACLE did not find the planted defect — the fixture is bogus."
      echo "          oracle: $ORACLE"
      FAILURES=$((FAILURES + 1))
      continue
    fi

    # 4. DEFEAT — the check MUST go red.
    DEFEAT_OUT="$(run_scanner "$WORK" "$SCANNER")"
    if check_is_red "$DEFEAT_OUT" "$CHECKNUM"; then
      echo "   ${GREEN}OK${NC}    [$DNAME] went RED. This is a gate."
      PROVEN=$((PROVEN + 1))
    else
      echo "   ${RED}FAIL${NC}  [$DNAME] stayed ${GREEN}GREEN${NC} with the defect planted and ORACLE-confirmed."
      echo "          ${RED}IT IS DECORATION.${NC} It could pass while the thing it guards is 100% dead."
      FAILURES=$((FAILURES + 1))
    fi
  done
done

echo
echo "═════════════════════════════════════════════════════════════════════"
echo "  proven can-fail : $PROVEN"
echo "  failures        : $FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  echo "${RED}FAIL${NC}: $FAILURES gate(s) are not proven. A gate that cannot fail is not a gate."
  exit 1
fi
echo "${GREEN}PASS${NC}: every registered gate was DEFEATED and went RED. They are real."
exit 0

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
#        0, and the check reports PASS. It has NEVER run.
#   T-2  pattern-scanner Check 40(g) pipes `grep -q` into `grep -qv`. `-q` is QUIET: it
#        prints nothing. So the right-hand grep always reads EMPTY stdin and always exits
#        non-zero. The condition CANNOT be true — ONE dead sub-predicate of Check 40's 16.
#   T-3  checks decide pass/fail by grepping for a bare SYMBOL. A COMMENT satisfies them.
#
# Every one of those checks was GREEN. Green measured the code's agreement with itself.
#
# ── FAIL-POINT GRANULARITY (F1, plan-2026-07-15-wave-1-g6-anti-vacuity-registry P0) ───────
# Decoration lives per fail-PREDICATE, not per check-HEADER. Check 40 alone carries 16
# independent c40fail sub-invariants; T-2 is one dead one of those. So the DISCOVERED
# candidate set — and the completeness denominator — is the set of `fail "…"` / `cNNfail "…"`
# CALL SITES (the discoverer's `fail_points`), each keyed by its message (the sub-invariant).
# A header-level fixture would leave 15 of Check 40's 16 sub-invariants unproven; the gate
# demands a fixture PER FAIL-POINT, and the DEFEAT observes the SPECIFIC fail-point's message
# going red (not merely that some sibling predicate in the same check fired).
#
# ── HOW IT WORKS ────────────────────────────────────────────────────────────────────────
# For every fail-point DISCOVERED in the tree (never a hand-typed list — see
# scripts/tests/_discover_scanner_checks.py), the registry must supply at least one
# violating-input fixture. For each fixture we assert FOUR things, in order:
#
#   1. CONTROL    — on the pristine tree the fail-point is GREEN (its message is not RED).
#   2. PLANT      — the mutation actually changed the scratch tree.
#   3. ORACLE     — an INDEPENDENT command proves the planted defect is genuinely present.
#   4. DEFEAT     — the fail-point's SPECIFIC message goes RED on the mutated tree. If it
#                   stays GREEN: it is DECORATION, and CI fails.
#
# Plus two registry-level gates:
#   COMPLETENESS  — every discovered fail-point has a NON-HOLLOW fixture (a fixture with an
#                   empty `defects` array or an empty/absent `oracle` is HOLLOW → FAIL, R14-1),
#                   OR a VALID `exempt` entry. A fail-point in neither FAILS CI.
#   SYMBOL-GREP   — no check may decide pass/fail on the presence of a bare identifier.
#                   Known offenders are held in a SHRINK-ONLY ratchet; a NEW one fails CI.
#
# Nothing real is ever mutated. All work happens on scratch copies. PROVE BEFORE YOU DESTROY.
#
# Usage:
#   bash scripts/massu-gate-anti-vacuity.sh              # all gates
#   bash scripts/massu-gate-anti-vacuity.sh --gate pattern-scanner-9--2ead743cf2
#   bash scripts/massu-gate-anti-vacuity.sh --completeness-only
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="$REPO_ROOT/scripts/lib/gate-registry.json"
DISCOVER="$REPO_ROOT/scripts/tests/_discover_scanner_checks.py"
RATCHET="$REPO_ROOT/scripts/lib/symbol-grep-ratchet.json"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

ONLY_GATE=""
LIKE=""
COMPLETENESS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --gate) ONLY_GATE="${2:-}"; shift 2 ;;
    --like) LIKE="${2:-}"; shift 2 ;;
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
# Gates whose PLANT TARGET was dirty, so their proof could not run. Counted as
# failures (a proof that did not run is not a pass) but reported rather than aborting.
DIRTY_SKIPPED=0
DIRTY_GATES=""
# Gates whose PLANT TARGET was absent (a missing build, or a probe's deliberate
# withdrawal). Same contract as DIRTY: reported and counted, never a silent pass.
ABSENT_SKIPPED=0
ABSENT_GATES=""

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
strip_ansi() { sed -E $'s/\033\\[[0-9;]*[A-Za-z]//g'; }

# Run one scanner inside a tree, return its de-colorized output.
# The scratch tree EXCLUDES node_modules (rsync), but the scanners now call the AST symbol
# checker (scripts/lib/ast-symbol-present.mjs) which needs `typescript`. Point NODE_PATH at the
# REAL repo's node_modules so the scratch-tree scanner resolves it — otherwise every ast_present
# call would fail-closed (exit 2) and turn every AST-backed check into a false positive.
run_scanner() { # $1 = tree, $2 = scanner relpath
  ( cd "$1" && NODE_PATH="$REPO_ROOT/node_modules" bash "$1/$2" 2>&1 | strip_ansi )
}

# ── DISCOVER once (shared by completeness, symbol-grep, and DEFEAT match-resolution) ─────
python3 "$DISCOVER" --repo-root "$REPO_ROOT" > "$TMP/discovered.json" || {
  echo "${RED}FATAL${NC}: shell fail-point discovery failed." >&2; exit 2; }

# ── DISCOVER the guard universe (P4, Wave 1b): vitest-guards + shell-gate-scripts + eslint ─
# The AST classifier sibling of the shell discoverer. Its candidates share the same registry
# (gates[] + exempt[]) and the same completeness gate below. FAIL CLOSED: a broken discoverer is
# never an empty universe (M2).
GUARD_DISCOVER="$REPO_ROOT/scripts/tests/_discover_guard_universe.mjs"
if [ ! -f "$GUARD_DISCOVER" ]; then
  echo "${RED}FATAL${NC}: missing $GUARD_DISCOVER — cannot enumerate the guard universe." >&2; exit 2
fi
NODE_PATH="$REPO_ROOT/node_modules" node "$GUARD_DISCOVER" --repo-root "$REPO_ROOT" > "$TMP/guards.json" 2>"$TMP/guards.err" || {
  echo "${RED}FATAL${NC}: guard-universe discovery failed:" >&2; cat "$TMP/guards.err" >&2; exit 2; }

# Did the named fail-point's SPECIFIC message go RED?  (F1 — not merely "some FAIL in this
# check", which a sibling predicate would satisfy; the fail-point's own `match` literal must
# appear on a FAIL line inside its check's section.)
fail_point_is_red() { # $1 = scanner output, $2 = check number, $3 = match substring
  printf '%s' "$1" | python3 -c '
import re, sys
want, want_match = sys.argv[1], sys.argv[2]
cur = None
for line in sys.stdin:
    h = re.match(r"^Check ([0-9]+[a-z]?):", line)
    if h:
        cur = h.group(1)
        continue
    if cur == want and re.match(r"^\s*FAIL:", line) and want_match in line:
        sys.exit(0)   # RED — this specific sub-invariant fired
sys.exit(1)           # not red
' "$2" "$3"
}

# ── COMPLETENESS: every DISCOVERED fail-point must carry a NON-HOLLOW can-fail proof ─────
echo
echo "════ COMPLETENESS — every discovered fail-point must ship a violating-input fixture ════"

# NOTE: assignment is UNQUOTED $(...) — bash 3.2 (macOS) mis-parses a heredoc body containing a
# backtick/apostrophe when the command substitution is wrapped in outer double-quotes. RHS of an
# assignment is not word-split, so unquoted is correct here.
COMPLETENESS=$(python3 - "$TMP/discovered.json" "$TMP/guards.json" "$REGISTRY" "$REPO_ROOT" <<'PY'
import hashlib, json, os, sys
disc   = json.load(open(sys.argv[1]))
guniv  = json.load(open(sys.argv[2]))
reg    = json.load(open(sys.argv[3]))
repo   = sys.argv[4]
gates  = reg.get("gates", [])
exempt = reg.get("exempt", [])

# ── SHELL fail-points (Wave 1a universe) ──────────────────────────────────────────────────
fps = disc.get("fail_points", [])
# ── GUARD candidates (Wave 1b universe): vitest-guard | shell-gate-script | eslint ────────
cands = guniv.get("candidates", [])
cr_named = set(guniv.get("cr_named", []))

# M1 — PROVE IT LOOKED. A zero denominator in EITHER universe is a LOUD error, never a pass.
if not fps:
    print(json.dumps({"fatal": "discovered ZERO shell fail-points — refusing to report completeness."})); sys.exit(0)
if not cands:
    print(json.dumps({"fatal": "discovered ZERO guard candidates — refusing to report completeness."})); sys.exit(0)

fp_ids = {c["id"] for c in fps}
fp_msg = {c["id"]: c.get("message", "") for c in fps}
cand_paths = {c["path"] for c in cands}
cand_kind  = {c["path"]: c["kind"] for c in cands}

# ── NON-HOLLOW classification of registry gates ───────────────────────────────────────────
# shell-failpoint : non-empty defects[], every defect with a non-empty oracle (R14-1).
# guard kinds     : a real can-fail proof spec — a `recipe` AND one of
#                   {companion_script, proof_script, non-empty plant}. An id/path present but
#                   with no proof spec is HOLLOW (decoration wearing a fixture's clothes).
shell_ok = set()        # fail_point ids with a non-hollow shell gate
guard_ok = {}           # path -> kind, for a non-hollow guard gate
hollow = []
reg_shell_ids = set()
reg_guard_paths = set()
for g in gates:
    kind = g.get("kind", "shell-failpoint")
    if kind == "shell-failpoint":
        gid = g["id"]; reg_shell_ids.add(gid)
        defects = g.get("defects", [])
        if not defects: hollow.append((gid, "empty defects[]")); continue
        if any(not d.get("oracle") for d in defects): hollow.append((gid, "a defect has an empty/absent oracle")); continue
        shell_ok.add(gid)
    else:
        p = g.get("path", g.get("id", "")); reg_guard_paths.add(p)
        recipe = g.get("recipe", "")
        if recipe in ("companion", "self-proving"):
            # G28/CR-91 — a scope predicate must BE the property, not a correlate of it.
            # This was `bool(companion_script or proof_script)`: ANY truthy string satisfied
            # it, so the two recipes were indistinguishable to the only check that reads them.
            # `companion` MEANS "a DISTINCT artifact proves me" — every one of the 11 companion
            # rows names a separate live-fire, and exempt-reasons.json rules those live-fires
            # NON-GUARD precisely because re-registering one as `self-proving` "would run it
            # twice". A companion row that named ITSELF would silently collapse into
            # self-proving and be accepted here AND by _run_guard_defeat.py:158, which branches
            # on the two recipes jointly. Enforce each recipe's own semantics, BOTH directions.
            script = g.get("companion_script") or g.get("proof_script")
            if not script:
                has_proof = False
                why = "companion/self-proving gate names no companion_script/proof_script"
            elif not os.path.exists(os.path.join(repo, script)):
                # The executor also checks this, but only for gates it is SELECTED to run;
                # completeness classifies the whole registry, so a dangling proof must be
                # hollow here rather than wait for a sweep that happens to select it.
                has_proof = False
                why = f"names a proof script that does not exist: {script}"
            elif recipe == "companion" and script == p:
                has_proof = False
                why = f"recipe=companion must name a DISTINCT artifact — it names itself ({script})"
            elif recipe == "self-proving" and script != p:
                has_proof = False
                why = f"recipe=self-proving must name ITSELF — it names {script} (declare recipe=companion)"
            else:
                has_proof = True
                why = ""
        elif recipe in ("source-plant", "dist-artifact", "plant"):
            has_proof = bool(g.get("plant")) and bool(g.get("oracle")) and (recipe == "plant" or g.get("test"))
            why = "plant recipe needs a non-empty plant + oracle (+ test for vitest kinds)"
        elif recipe == "eslint-ruletester":
            has_proof = bool(g.get("test")); why = "eslint-ruletester needs a RuleTester test"
        else:
            has_proof = False; why = f"unknown/absent recipe '{recipe}'"
        if not has_proof: hollow.append((g.get("id", p), why)); continue
        guard_ok[p] = kind

# ── EXEMPT validation (R7-1 / R8-1) — invariants (i)-(iv). A VALIDATED allowlist, not a stamp. ─
exempt_paths = set()
exempt_violations = []
for e in exempt:
    if not isinstance(e, dict):
        exempt_violations.append({"path": str(e), "why": "exempt entry must be an object {path, reason, hash}"}); continue
    p = e.get("path", "")
    exempt_paths.add(p)
    # (i) no CR-named guard may EVER be exempted — the T-3 laundering through the exempt hatch.
    if p in cr_named:
        exempt_violations.append({"path": p, "why": "(i) a CR-named enforcement guard may NEVER be exempted"})
    # (ii) stale — the exempt names a path that is no longer a discovered candidate.
    if p not in cand_paths:
        exempt_violations.append({"path": p, "why": "(ii) stale — not a current guard candidate"})
    # (v) a candidate ruled BOTH a proven gate AND exempt is a double-ruling conflict.
    if p in guard_ok:
        exempt_violations.append({"path": p, "why": "ruled BOTH a proven gate AND exempt — pick one"})
    # (iii) empty/placeholder reason.
    reason = (e.get("reason") or "").strip()
    if not reason:
        exempt_violations.append({"path": p, "why": "(iii) empty/placeholder reason"})
    # (iv) pinned content-hash must match — any EDIT to an exempted test forces a fresh ruling.
    want = e.get("hash", "")
    fp = os.path.join(repo, p)
    try:
        got = "sha256:" + hashlib.sha256(open(fp, "rb").read()).hexdigest()
    except Exception as ex:
        exempt_violations.append({"path": p, "why": f"(iv) cannot read to hash: {ex}"}); continue
    if want != got:
        exempt_violations.append({"path": p, "why": f"(iv) content-hash mismatch — file edited since ruling (want {want[:23]}…, got {got[:23]}…); re-rule + re-pin"})

# A valid exempt entry is one with ZERO invariant violations.
bad_paths = {v["path"] for v in exempt_violations}
valid_exempt = {p for p in exempt_paths if p not in bad_paths}

# ── MISSING: a candidate satisfied by neither a non-hollow proof nor a valid exempt ───────
missing_shell = sorted(i for i in fp_ids if i not in shell_ok)  # shell fps are never exempt
missing_guard = sorted(c["path"] for c in cands if c["path"] not in guard_ok and c["path"] not in valid_exempt)

# ── STALE registry entries (a gate for something no longer discovered) ─────────────────────
stale = sorted([i for i in reg_shell_ids if i not in fp_ids] + [p for p in reg_guard_paths if p not in cand_paths])

print(json.dumps({
    "denominator_shell": len(fp_ids),
    "denominator_guard": len(cand_paths),
    "missing": [{"id": i, "message": fp_msg.get(i, "")[:90], "kind": "shell-failpoint"} for i in missing_shell]
             + [{"id": p, "message": "", "kind": cand_kind.get(p, "guard")} for p in missing_guard],
    "hollow": [{"id": i, "why": w} for i, w in hollow],
    "stale": stale,
    "exempt_violations": exempt_violations,
    "n_exempt": len(exempt_paths),
    "n_valid_exempt": len(valid_exempt),
}))
PY
)

FATAL_C=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("fatal",""))')
if [ -n "$FATAL_C" ]; then
  echo "  ${RED}FATAL${NC}: $FATAL_C" >&2
  exit 2
fi
DENOM_S=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["denominator_shell"])')
DENOM_G=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["denominator_guard"])')
N_MISSING=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["missing"]))')
N_HOLLOW=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["hollow"]))')
N_STALE=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["stale"]))')
N_EXV=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["exempt_violations"]))')
N_VEX=$(printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["n_valid_exempt"])')

echo "  scanned $DENOM_S shell fail-point(s) + $DENOM_G guard candidate(s) (the completeness denominators); $N_VEX valid exempt(s)."
if [ "$N_MISSING" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $N_MISSING discovered candidate(s) have NEITHER a can-fail proof NOR a valid exempt:"
  printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys
for c in json.load(sys.stdin)["missing"][:60]: print("          -", "["+c["kind"]+"]", c["id"], ("— "+c["message"]) if c["message"] else "")'
  echo "         An un-ruled candidate is a hard FAIL: register a can-fail proof (GUARD) or a cited+hashed exempt entry (NON-GUARD)."
  FAILURES=$((FAILURES + 1))
fi
if [ "$N_HOLLOW" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $N_HOLLOW registry gate(s) are HOLLOW (id present but no real fixture):"
  printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys
for c in json.load(sys.stdin)["hollow"]: print("          -", c["id"], "—", c["why"])'
  echo "         An id-present-but-hollow entry is decoration wearing a fixture's clothes (R14-1)."
  FAILURES=$((FAILURES + 1))
fi
if [ "$N_STALE" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $N_STALE registry entr(ies) reference a candidate that no longer exists:"
  printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys
for c in json.load(sys.stdin)["stale"]: print("          -", c)'
  FAILURES=$((FAILURES + 1))
fi
if [ "$N_EXV" -gt 0 ]; then
  echo "  ${RED}FAIL${NC}: $N_EXV invalid exempt entr(ies) — the exempt allowlist is VALIDATED, not a green-stamp (R7-1):"
  printf '%s' "$COMPLETENESS" | python3 -c 'import json,sys
for c in json.load(sys.stdin)["exempt_violations"][:60]: print("          -", c["path"], "—", c["why"])'
  FAILURES=$((FAILURES + 1))
fi
[ "$N_MISSING" -eq 0 ] && [ "$N_HOLLOW" -eq 0 ] && [ "$N_STALE" -eq 0 ] && [ "$N_EXV" -eq 0 ] && \
  echo "  ${GREEN}OK${NC}: all $DENOM_S shell fail-points + $DENOM_G guard candidates carry a non-hollow can-fail proof or a valid exempt entry."

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
  # X-1: the precondition preflight runs on the DEFEAT path ONLY, and its suppression here is
  # ANNOUNCED rather than inferred (G11 — name the switch). `--completeness-only` runs no gate,
  # so it needs no artifact; a preflight above this exit would exit 2 on every fresh clone and
  # brick pre-push [22/22] plus both mutation scripts, which is CR-72's brick direction on the
  # mechanism this plan calls the one that matters most.
  echo "  preflight       : NOT RUN (--completeness-only runs no gate, so it requires no artifact)"
  [ "$FAILURES" -gt 0 ] && { echo "${RED}FAIL${NC}: $FAILURES registry-level gate(s) failed."; exit 1; }
  echo "${GREEN}PASS${NC}: registry-level gates green."; exit 0
fi

# ── PER-GATE: CONTROL -> PLANT -> ORACLE -> DEFEAT ──────────────────────────────────────
#
# P6 PERFORMANCE REDESIGN (plan-2026-07-15 §3, measured CR-68):
#   A bare scanner run is ~48 s. The serial design re-ran the FULL scanner once for CONTROL
#   PER GATE (97 identical pattern-scanner CONTROL runs) + once per DEFEAT — ~112 s for a
#   SINGLE gate, ~3.2 h for all 103. Two structural fixes:
#     (1) CONTROL is cached ONCE per scanner (its pristine output is identical across all its
#         fail-points), reused by every gate of that scanner.
#     (2) DEFEAT is inherently per-defect but embarrassingly parallel — each defect gets its
#         OWN scratch work-tree (clonefile-accelerated on APFS) and they run concurrently,
#         capped at cores-2. Each job writes an ISOLATED result file; the main process
#         aggregates in deterministic gate/defect order so the verdict is identical to serial.
#   Correctness is unchanged: CONTROL(pristine) is deterministic for a given tree, and jobs
#   share only READ-ONLY inputs (registry, discovered.json, pristine) — no mutable shared state.
echo
echo "════ DEFEAT — plant each violating input and demand the fail-point goes RED ════"

GATE_IDS=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
only=sys.argv[2]; like=sys.argv[3]
for g in reg["gates"]:
    if g.get("kind","shell-failpoint") != "shell-failpoint": continue  # guard kinds run in their own real-tree phase
    if only and g["id"]!=only: continue
    if like and like not in g["id"]: continue
    print(g["id"])
' "$REGISTRY" "$ONLY_GATE" "$LIKE")

# Guard-kind gates (vitest-guard / shell-gate-script / eslint) run in the real-tree phase below.
GUARD_GATE_IDS=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
only=sys.argv[2]; like=sys.argv[3]
for g in reg["gates"]:
    if g.get("kind","shell-failpoint") == "shell-failpoint": continue
    if only and g["id"]!=only: continue
    if like and like not in g["id"]: continue
    print(g["id"])
' "$REGISTRY" "$ONLY_GATE" "$LIKE")

if [ -z "$GATE_IDS" ] && [ -z "$GUARD_GATE_IDS" ]; then
  echo "${RED}FATAL${NC}: no gates selected — refusing to exit 0 on an empty run." >&2
  exit 2
fi

# ── X-1 PRECONDITION PREFLIGHT ──────────────────────────────────────────────────────────
#
# A gate whose proof needs an artifact the job never built is NOT decoration, and must never
# be reported in the words used for decoration. This asserts the SELECTED gates' declared
# `requires[]` before any of them runs, and fails LOUD naming each unmet one AND its remedy.
#
# SCOPED TO THE SELECTED SET, not the registry-wide union. `--gate`/`--like` take this same
# DEFEAT path; a registry-wide union would exit 2 at all four `--gate` sites in
# test-anti-vacuity-runner-mutation.sh the moment ANY annotated gate's precondition is unmet,
# whether or not that gate is selected — reddening a registry `self-proving` gate that is also
# an anti-vacuity job step, on a tree where nothing it tests is broken.
#
# ANTI-LAUNDERING: an unmet precondition is FATAL for the whole sweep (exit 2). There is no
# per-gate skip, and PRECONDITION MISSING is counted in NEITHER `proven` NOR `failures`.
# INJECTABLE, so the ADJUDICATOR can measure without being constrained by its own prior
# conclusions. `scripts/ops/probe-gate-requires.sh` discovers which gates require which
# artifacts by WITHDRAWING an artifact and observing which gates go red — but once its
# output is in place, this preflight sees that same artifact declared as required and
# FATALs the sweep before a single gate runs, emitting zero verdicts.
#
# Measured 2026-07-28: the probe succeeded exactly once, against an empty ledger
# (`dc29151b`: requires=0, probed=false). Re-running it after `6c52ae9f` populated 14
# annotations aborted on the first withdrawal — so the adjudicator was ONE-SHOT, and every
# future gate addition would have hit the same wall.
#
# Default is unchanged for every real caller; only the probe overrides it.
REQUIRES_SOT="${MASSU_REQUIRES_SOT:-$REPO_ROOT/scripts/lib/gate-requires.json}"
if [ ! -r "$REQUIRES_SOT" ]; then
  echo "${RED}FATAL${NC}: cannot read $REQUIRES_SOT — refusing to run gates with an unknown" >&2
  echo "       precondition contract. A missing SoT is an ERROR, never an empty one (M2)." >&2
  exit 2
fi
PREFLIGHT_OUT=$(python3 - "$REQUIRES_SOT" "$REGISTRY" "$(echo $GATE_IDS $GUARD_GATE_IDS)" <<'PY'
import json, os, subprocess, sys

sot_path, reg_path, selected_blob = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    sot = json.load(open(sot_path))
    reg = json.load(open(reg_path))
except (OSError, json.JSONDecodeError) as exc:
    print(f"__FATAL__\tunreadable precondition contract: {exc}")
    raise SystemExit(0)

vocab = sot.get("vocabulary") or {}
requires = sot.get("requires") or {}
if not vocab:
    print("__FATAL__\tvocabulary is EMPTY — refusing to validate against nothing (M1)")
    raise SystemExit(0)

all_gate_ids = [g["id"] for g in reg["gates"]]
selected = [g for g in selected_blob.split() if g]

# (a) VALIDATE THE WHOLE REGISTRY, and report the validator's OWN denominator. A validator
#     scoped to the gates it happens to reach passes the unknown-value test while never
#     looking at the rest — so N < M is a hard error, not a smaller number.
validated = 0
unknown = []
for gid in all_gate_ids:
    validated += 1
    for name in requires.get(gid, []):
        if name not in vocab:
            unknown.append((gid, name))
print(f"__VALIDATED__\t{validated}\t{len(all_gate_ids)}")
if unknown:
    for gid, name in unknown:
        print(f"__UNKNOWN__\t{gid}\t{name}")
    raise SystemExit(0)

# A ledger id that no longer exists in the registry is drift, not a skip.
for gid in requires:
    if gid not in set(all_gate_ids):
        print(f"__STALE__\t{gid}")

# (b) The union is taken over the SELECTED gates only.
needed = {}
for gid in selected:
    for name in requires.get(gid, []):
        needed.setdefault(name, []).append(gid)
print(f"__SCOPE__\t{len(needed)}\t{len(selected)}")

for name in sorted(needed):
    spec = vocab[name]
    rc = subprocess.run(["bash", "-c", spec["probe"]], capture_output=True).returncode
    if rc != 0:
        print(f"__UNMET__\t{name}\t{spec['remedy']}\t{len(needed[name])}\t{needed[name][0]}")
PY
)
if [ -z "$PREFLIGHT_OUT" ]; then
  echo "${RED}FATAL${NC}: the precondition preflight produced NO output — a check that cannot" >&2
  echo "       report what it looked at has not looked (M1)." >&2
  exit 2
fi
while IFS=$'\t' read -r tag a b c d; do
  case "$tag" in
    __FATAL__)     echo "${RED}FATAL${NC}: precondition contract unusable — $a" >&2; exit 2 ;;
    __VALIDATED__)
      echo "  validated $a of $b registry gates against the requires[] vocabulary"
      if [ "$a" -lt "$b" ]; then
        echo "${RED}FATAL${NC}: the requires[] validator saw $a of $b gates — a validator that" >&2
        echo "       did not read every gate cannot report a clean vocabulary (M1)." >&2
        exit 2
      fi ;;
    __UNKNOWN__)
      echo "${RED}FATAL${NC}: unknown requires value '$b' on gate $a." >&2
      echo "       A closed vocabulary that ignores what it does not recognise swallows its" >&2
      echo "       own input (G3). Add it to scripts/lib/gate-requires.json or remove it." >&2
      exit 2 ;;
    __STALE__)
      echo "${RED}FATAL${NC}: gate-requires.json annotates '$a', which is not in the registry." >&2
      echo "       Re-run scripts/ops/probe-gate-requires.sh --write." >&2
      exit 2 ;;
    __SCOPE__)     echo "  preflight       : $a requirement(s) over $b selected gate(s)" ;;
    __UNMET__)
      echo
      echo "${RED}PRECONDITION MISSING${NC}: $a — NOT SATISFIED."
      echo "  remedy : $b"
      echo "  blocks : $c selected gate(s), e.g. $d"
      echo
      echo "${RED}FATAL${NC}: this sweep cannot judge those gates. They are NOT decoration and are" >&2
      echo "       counted in neither 'proven can-fail' nor 'failures' — the artifact is missing." >&2
      exit 2 ;;
  esac
done <<< "$PREFLIGHT_OUT"

# ── Detect a copy-on-write clone flag so 100+ full-tree copies are near-free (APFS/reflink) ─
# macOS BSD cp: `-c` (clonefile). GNU cp: `--reflink=auto`. Fall back to a plain deep copy.
CLONE_FLAG=""
_ct="$TMP/_clonetest"; mkdir -p "$_ct/src"; echo x > "$_ct/src/f"
if cp -Rc "$_ct/src" "$_ct/d1" 2>/dev/null; then CLONE_FLAG="-c"
elif cp -R --reflink=auto "$_ct/src" "$_ct/d2" 2>/dev/null; then CLONE_FLAG="--reflink=auto"; fi
rm -rf "$_ct"
copy_tree() { # $1 src  $2 dest
  if [ -n "$CLONE_FLAG" ]; then cp -R $CLONE_FLAG "$1" "$2" 2>/dev/null && return 0; fi
  cp -R "$1" "$2"
}

# ── Concurrency cap: cores-2, floored at 1, softly capped at 16 (each scanner run itself
#    spawns ~20 short node/AST children; 16 keeps ~16 * a few hundred MB well within budget).
if command -v nproc >/dev/null 2>&1; then NCPU=$(nproc); else NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 4); fi
CAP=${AV_CONCURRENCY:-$(( NCPU - 2 ))}
[ "$CAP" -lt 1 ] && CAP=1
if [ -z "${AV_CONCURRENCY:-}" ] && [ "$CAP" -gt 16 ]; then CAP=16; fi

# ── (1) CONTROL ONCE per DISTINCT scanner among the selected gates. ─────────────────────
# Cache the de-colorized pristine output keyed by a sanitized scanner path. `fail_point_is_red`
# against this cached text is cheap (python only), so the per-gate already-red check costs
# nothing beyond the ONE run per scanner.
control_cache_path() { printf '%s/control__%s.out' "$TMP" "$(printf '%s' "$1" | tr '/.' '__')"; }
CONTROL_SCANNERS=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1])); sel=set(sys.argv[2].split())
seen=[]
for g in reg["gates"]:
    if g["id"] in sel and g["scanner"] not in seen: seen.append(g["scanner"])
print("\n".join(seen))
' "$REGISTRY" "$(echo $GATE_IDS)")
for sc in $CONTROL_SCANNERS; do
  cpath="$(control_cache_path "$sc")"
  echo "  CONTROL (cached once): $sc"
  run_scanner "$PRISTINE" "$sc" > "$cpath"
done

# ── (2) Build the job list (one line per gate+defect) and run in parallel batches. ──────
# Serial pre-pass per gate: resolve scanner/check/match, reject stale ids, reject already-red
# CONTROL, reject zero-defect gates — all CHEAP (no scanner runs). Survivors emit defect jobs.
JOBDIR="$TMP/jobs"; RESDIR="$TMP/results"; mkdir -p "$JOBDIR" "$RESDIR"
JOB_LIST="$TMP/joblist.txt"; : > "$JOB_LIST"
GATE_ORDER="$TMP/gateorder.txt"; : > "$GATE_ORDER"

for gid in $GATE_IDS; do
  echo "$gid" >> "$GATE_ORDER"
  RESOLVED=$(python3 - "$REGISTRY" "$TMP/discovered.json" "$gid" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
disc = json.load(open(sys.argv[2]))
gid = sys.argv[3]
g = [x for x in reg["gates"] if x["id"] == gid][0]
fp = next((f for f in disc["fail_points"] if f["id"] == gid), None)
if fp is None:
    print("__STALE__")
else:
    print("\t".join([g["scanner"], str(fp["check_num"]), fp["match"], g.get("title", ""), fp["message"][:70]]))
PY
)
  RF="$RESDIR/$gid.txt"; : > "$RF"
  if [ "$RESOLVED" = "__STALE__" ]; then
    { echo "── $gid";
      echo "   ${RED}FAIL${NC}  registry gate references a fail-point that no longer exists (stale id)."
      echo "__VERDICT__ FAIL"; } > "$RF"
    continue
  fi
  SCANNER=$(printf '%s' "$RESOLVED" | cut -f1)
  CHECKNUM=$(printf '%s' "$RESOLVED" | cut -f2)
  MATCH=$(printf '%s' "$RESOLVED" | cut -f3)
  TITLE=$(printf '%s' "$RESOLVED" | cut -f5)

  CONTROL_OUT="$(cat "$(control_cache_path "$SCANNER")")"
  if fail_point_is_red "$CONTROL_OUT" "$CHECKNUM" "$MATCH"; then
    { echo "── $gid — Check $CHECKNUM: $TITLE";
      echo "   ${RED}FAIL${NC}  CONTROL: this fail-point is ALREADY RED on the pristine tree.";
      echo "          A defeat test against an already-failing fail-point proves nothing. Fix the tree first.";
      echo "__VERDICT__ FAIL"; } > "$RF"
    continue
  fi

  NDEF=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(len(g.get("defects",[])))' "$REGISTRY" "$gid")
  if [ "$NDEF" -eq 0 ]; then
    { echo "── $gid — Check $CHECKNUM: $TITLE";
      echo "   ${RED}FAIL${NC}  no defect fixture — this fail-point has no can-fail proof.";
      echo "__VERDICT__ FAIL"; } > "$RF"
    continue
  fi

  # Header line for this gate (printed once, before its defect results).
  echo "── $gid — Check $CHECKNUM: $TITLE" > "$RF.header"
  # Emit one job per defect. Fields are TAB-separated: gid, idx, scanner, checknum, match.
  i=0
  while [ "$i" -lt "$NDEF" ]; do
    printf '%s\t%s\t%s\t%s\t%s\n' "$gid" "$i" "$SCANNER" "$CHECKNUM" "$MATCH" >> "$JOB_LIST"
    i=$((i + 1))
  done
done

# ── The per-defect worker. Runs in a subshell (backgrounded). Writes to $RESDIR/<gid>.d<idx>. ─
defeat_one() { # $1=gid $2=idx $3=scanner $4=checknum $5=match
  local gid="$1" idx="$2" scanner="$3" checknum="$4" match="$5"
  local out="$RESDIR/$gid.d$idx"; : > "$out"
  local work="$TMP/work-$gid-$idx"
  rm -rf "$work"
  copy_tree "$PRISTINE" "$work" || { echo "   ${RED}FAIL${NC}  [d$idx] could not build scratch work tree." > "$out"; echo "__V__ FAIL" >> "$out"; return; }

  local dname
  dname=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g["defects"][int(sys.argv[3])]["name"])' "$REGISTRY" "$gid" "$idx")

  # 2. PLANT
  local planted
  planted=$(python3 - "$REGISTRY" "$gid" "$idx" "$work" <<'PY'
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
    if os.path.isdir(p) and not os.path.islink(p):
        import shutil; shutil.rmtree(p); changed += 1   # a fixture may need to remove a whole dir (e.g. a "dir not found" check)
    elif os.path.exists(p) or os.path.islink(p):
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
  if [ "${planted:-0}" -eq 0 ]; then
    { echo "   ${RED}FAIL${NC}  [$dname] PLANT: the mutation changed NOTHING.";
      echo "          A defeat test that fails to plant its defect is itself vacuous.";
      echo "__V__ FAIL"; } > "$out"
    rm -rf "$work"; return
  fi

  # 3. ORACLE — independent proof the planted defect is genuinely present.
  local oracle
  oracle=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
g=[x for x in reg["gates"] if x["id"]==sys.argv[2]][0]
print(g["defects"][int(sys.argv[3])].get("oracle",""))' "$REGISTRY" "$gid" "$idx")
  if [ -z "$oracle" ]; then
    { echo "   ${RED}FAIL${NC}  [$dname] no ORACLE. Without one, 'my fixture was bogus' and 'the check is";
      echo "          blind' are indistinguishable — the exact conflation this gate exists to end.";
      echo "__V__ FAIL"; } > "$out"
    rm -rf "$work"; return
  fi
  # G29/CR-92 — NEUTRALISE THE CALLER'S GIT ENVIRONMENT FOR THE ORACLE SANDBOX.
  # `cd "$work"` DOES NOT SCOPE GIT. GIT_DIR outranks the working directory, `git -C`
  # and `cwd:`, and is inherited from any CALLER that sets it — a nested git invocation,
  # a wrapper, a harness, a tool. (Git does NOT hand GIT_DIR to the hooks it runs;
  # measured, scripts/ops/probe-git-hook-env.sh. Under pre-push git supplies only
  # GIT_PREFIX; at commit stage it also supplies GIT_INDEX_FILE, which redirects the
  # index by itself.) This sweep runs from pre-push [22/22] and from CI, so it inherits
  # whatever environment those callers hand it.
  # An oracle is an ARBITRARY command string from the registry, and at
  # least one of them runs `git init -q .` + `git add -N`: with GIT_DIR inherited that
  # re-inits the REAL repo and stages into the REAL index, while the gate's verdict is
  # simultaneously wrong (it adjudicates the wrong tree).
  # Scoped to THIS subshell on purpose: the sweep's other steps operate on the real
  # tree and must keep the caller's git context. Fixing the executor rather than the
  # one registry string covers every oracle, present and future — the registry is data,
  # this is the chokepoint. 2026-08-04, Incident #166.
  if ! ( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
               GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
         cd "$work" && NODE_PATH="$REPO_ROOT/node_modules" bash -c "$oracle" >/dev/null 2>&1 ); then
    { echo "   ${RED}FAIL${NC}  [$dname] ORACLE did not find the planted defect — the fixture is bogus.";
      echo "          oracle: $oracle";
      echo "__V__ FAIL"; } > "$out"
    rm -rf "$work"; return
  fi

  # 4. DEFEAT — the fail-point's SPECIFIC message MUST go red.
  local defeat_out
  defeat_out="$(run_scanner "$work" "$scanner")"
  if fail_point_is_red "$defeat_out" "$checknum" "$match"; then
    { echo "   ${GREEN}OK${NC}    [$dname] went RED. This is a gate.";
      echo "__V__ OK"; } > "$out"
  else
    { echo "   ${RED}FAIL${NC}  [$dname] stayed ${GREEN}GREEN${NC} with the defect planted and ORACLE-confirmed.";
      echo "          ${RED}IT IS DECORATION.${NC} It could pass while the thing it guards is 100% dead.";
      echo "__V__ FAIL"; } > "$out"
  fi
  rm -rf "$work"
}

N_JOBS=$(wc -l < "$JOB_LIST" | tr -d ' ')
if [ "$N_JOBS" -gt 0 ]; then
  echo "  Running $N_JOBS defect job(s) across up to $CAP worker(s) (clone flag: '${CLONE_FLAG:-none}')..."
  running=0
  while IFS=$'\t' read -r jgid jidx jsc jck jmatch; do
    defeat_one "$jgid" "$jidx" "$jsc" "$jck" "$jmatch" &
    running=$((running + 1))
    if [ "$running" -ge "$CAP" ]; then wait; running=0; fi
  done < "$JOB_LIST"
  wait
fi

# ── Aggregate results in deterministic gate/defect order (verdict identical to serial). ──
while IFS= read -r gid; do
  RF="$RESDIR/$gid.txt"
  if [ -s "$RF" ]; then
    # Pre-rejected gate (stale / already-red / no-defect): body already written with __VERDICT__.
    grep -v '^__VERDICT__' "$RF"
    if grep -q '^__VERDICT__ FAIL' "$RF"; then FAILURES=$((FAILURES + 1)); fi
    echo
    continue
  fi
  # Gate with defect jobs: header + each defect result in index order (0,1,2,...).
  [ -f "$RF.header" ] && cat "$RF.header"
  di=0
  while [ -f "$RESDIR/$gid.d$di" ]; do
    out="$RESDIR/$gid.d$di"
    grep -v '^__V__' "$out"
    if grep -q '^__V__ OK' "$out"; then PROVEN=$((PROVEN + 1)); fi
    if grep -q '^__V__ FAIL' "$out"; then FAILURES=$((FAILURES + 1)); fi
    di=$((di + 1))
  done
  echo
done < "$GATE_ORDER"

# ════ GUARD DEFEAT (P4, Wave 1b) — real-tree can-fail proofs for the vitest/shell-gate/eslint kinds ═
# Unlike shell fail-points (rsync scratch tree), these guards assert invariants needing node_modules,
# so their can-fail proof runs the CR-72 REAL-TREE pattern IN PLACE (snapshot content+mtime → plant →
# oracle → run guard → assert RED → restore → assert git-clean), via the per-kind executor. Serial —
# only ONE plant is live on the real tree at a time (parallel real-tree plants would collide). The
# executor exits 2 (FATAL) on a dirty tree or a leaked restore — PROVE BEFORE YOU DESTROY.
GUARD_EXEC="$REPO_ROOT/scripts/tests/_run_guard_defeat.py"
if [ -n "$GUARD_GATE_IDS" ]; then
  echo
  echo "════ GUARD DEFEAT — real-tree can-fail proofs (vitest-guard / shell-gate-script / eslint) ════"
  if [ ! -f "$GUARD_EXEC" ]; then
    echo "${RED}FATAL${NC}: missing $GUARD_EXEC — cannot run guard-kind proofs." >&2; exit 2
  fi
  for gid in $GUARD_GATE_IDS; do
    # RE-CHECK the executor EVERY iteration, not just once up front. A guard's
    # own defeat run can destroy the tree it runs in (a planted defect can make
    # a test file's payload live), and `python3 <missing-file>` ALSO exits 2 —
    # the same code the executor uses for "dirty tree / leaked restore". Before
    # this re-check, a vanished executor was reported as a dirty tree: a
    # confident, specific, WRONG diagnosis that pointed away from the real
    # cause for two full CI runs (30139986763, 30187340635). Distinguishing the
    # two is the difference between "your restore leaked" and "something just
    # deleted this checkout".
    if [ ! -f "$GUARD_EXEC" ]; then
      echo "${RED}FATAL${NC}: $GUARD_EXEC VANISHED mid-sweep (was present at start, gone before $gid)." >&2
      echo "        The working tree is being destroyed BY the sweep. Do NOT re-run this locally:" >&2
      echo "        a planted defect can make a test's own payload execute. Inspect the last" >&2
      echo "        OK guard above — its plant is the prime suspect." >&2
      exit 2
    fi
    # X-3 (plan-2026-07-26-anti-vacuity-9-unproven-gates): CAPTURE the executor's output,
    # RE-EMIT it, then discriminate on its text. This invocation used to run bare, so
    # inside the exit-2 branch only `$?` was in scope and EVERY exit 2 — no such gate,
    # tree already dirty, unknown kind/recipe, restore leak, and now PLANT TARGET ABSENT
    # — was rendered as "dirty tree / leaked restore". A missing BUILD therefore surfaced
    # in CI as a dirty-tree accusation and aborted the sweep before the summary, naming a
    # cause that was not the cause. anti-vacuity-plant-payload-safety.test.ts:140-141
    # records the same conflation disguising a deletion as a restore leak for two CI runs.
    # A bare $(…) capture would fix the discrimination and DELETE the executor's lines
    # from the job log — the only place they appear — so it is re-emitted first.
    gout="$(python3 "$GUARD_EXEC" --registry "$REGISTRY" --repo-root "$REPO_ROOT" --gate "$gid" 2>&1)"
    gec=$?
    printf '%s\n' "$gout"
    if [ "$gec" -eq 0 ]; then
      PROVEN=$((PROVEN + 1))
    elif [ "$gec" -eq 2 ]; then
      case "$gout" in
        *"PLANT TARGET ABSENT"*)
          # REPORTED, NOT ABORTING — same treatment as the dirty case above, and for
          # the same reason: one gate's unavailable input says nothing about the other
          # 400, so aborting made it un-provable-by-proxy for the entire registry.
          #
          # MEASURED 2026-07-28, and the cost was the whole point of fixing it. The
          # requires[] probe adjudicates by WITHDRAWING a build artifact and re-sweeping,
          # so an absent plant target is the DELIBERATE, EXPECTED condition of every
          # withdrawal sweep. Aborting on it truncated each sweep to 12 verdicts against
          # a 267-verdict baseline; the 255 unjudged gates then all read as "differing",
          # producing 241 candidates that per-item confirmation spent ~an hour refuting
          # down to 1 — per requirement, six requirements, ~6 hours a run. The gate that
          # aborted the sweep was adapter-bundle-reproducibility.test.ts: the single TRUE
          # dependent of the artifact being withdrawn. The probe found its answer and
          # then destroyed its ability to measure anything else.
          #
          # It stays a FAILURE (counted, non-zero exit) — a proof that could not run is
          # never a pass. For an ordinary CI sweep this is now strictly MORE informative:
          # you learn every missing artifact in one run instead of only the first.
          ABSENT_SKIPPED=$((ABSENT_SKIPPED + 1))
          ABSENT_GATES="${ABSENT_GATES}${ABSENT_GATES:+$'\n'}  $gid"
          echo "${YELLOW}UNPROVEN${NC} [$gid] plant target ABSENT — proof could not run. Build the artifact (e.g. \`npm run build\`) and re-run." >&2
          FAILURES=$((FAILURES + 1))
          continue ;;
        *"target tree already dirty"*)
          # REPORTED, NOT ABORTING — and this one case only.
          #
          # A dirty plant target says nothing about the OTHER gates, so aborting the
          # whole sweep for it made one uncommitted file un-provable-by-proxy for
          # every gate in the registry. That created a cycle with no legal ordering:
          # adding a gate makes invariant 3c red (registry > gates_probed), 3c blocks
          # `npm test` and therefore the commit, the fix is to re-probe — and the probe
          # runs this sweep, which aborted on the very file the commit would have
          # cleaned. Hit 2026-07-28 registering the suite-requires-build guard, whose
          # plant target is the ci.yml being changed in the same batch.
          #
          # It stays a FAILURE (counted below, non-zero exit): a gate whose proof could
          # not run must never read as proven — that is the blind-gate law and it is
          # not negotiable. What changes is blast radius: this gate is named and
          # counted, the rest of the sweep still executes. Every OTHER exit-2 cause
          # (absent plant target, leaked restore, unknown recipe, unrecognised) still
          # aborts, because each of those means the harness itself is untrustworthy.
          DIRTY_SKIPPED=$((DIRTY_SKIPPED + 1))
          DIRTY_GATES="${DIRTY_GATES}${DIRTY_GATES:+$'\n'}  $gid"
          echo "${YELLOW}UNPROVEN${NC} [$gid] plant target is DIRTY — proof could not run. Commit that file and re-run." >&2
          FAILURES=$((FAILURES + 1))
          continue ;;
        *"LEAKED changes into the working tree"*)
          echo "${RED}FATAL${NC}: guard defeat ABORTED for $gid — the proof LEAKED changes into the tree (restore incomplete)." >&2 ;;
        *"no gate "*)
          echo "${RED}FATAL${NC}: guard defeat ABORTED for $gid — the registry has no gate with that id." >&2 ;;
        *"unknown kind/recipe"*)
          echo "${RED}FATAL${NC}: guard defeat ABORTED for $gid — unknown kind/recipe in its registry row." >&2 ;;
        *)
          # A closed vocabulary silently swallows what it did not anticipate (G3), so the
          # unmatched case is LOUD and points at the re-emitted text rather than guessing.
          echo "${RED}FATAL${NC}: guard defeat ABORTED for $gid — executor exit 2 with an UNRECOGNISED cause. Its output is directly above; do not infer a cause from this line." >&2 ;;
      esac
      exit 2
    else
      FAILURES=$((FAILURES + 1))
    fi
  done
fi

# ── CANARY GUARD (registry `_canary_doc`, plan §4 P7a / CR-72) ───────────────────────────
# The canary is a KNOWN-GOOD gate (Check 3: "no process.exit() in library code"). Planting a
# process.exit() genuinely turns it RED. If the canary does NOT go RED, the defect is in the
# RUNNER (its match logic broke — the exact failure the first runner shipped: it keyed on
# 'FAIL: Check N', matched nothing, and called every working gate decoration) OR Check 3 itself
# was neutered — NOT the tree. In that state every "decoration" verdict is a FALSE POSITIVE, and
# a harness that reports EVERYTHING broken is as useless as one that reports nothing broken — and
# it fails in the more believable direction. So: if the canary was actually SELECTED and did not
# go all-OK, ABORT LOUD (exit 2) instead of exiting 1 with a wall of false positives. Fires only
# when the canary is in the selected set (a `--gate other` / `--like x` run that excludes it is
# unaffected).
CANARY_ID=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1]))
c=[g["id"] for g in reg.get("gates",[]) if g.get("canary") is True]
print(c[0] if c else "")' "$REGISTRY")
if [ -n "$CANARY_ID" ] && grep -qxF "$CANARY_ID" "$GATE_ORDER"; then
  canary_ran=0; canary_bad=0
  RF="$RESDIR/$CANARY_ID.txt"
  if [ -s "$RF" ]; then
    canary_ran=1
    grep -q '^__VERDICT__ FAIL' "$RF" && canary_bad=1   # pre-rejected (stale / already-red / no-defect)
  fi
  di=0
  while [ -f "$RESDIR/$CANARY_ID.d$di" ]; do
    canary_ran=1
    grep -q '^__V__ OK' "$RESDIR/$CANARY_ID.d$di" || canary_bad=1   # any canary defect not going RED
    di=$((di + 1))
  done
  [ "$canary_ran" -eq 0 ] && canary_bad=1   # selected but produced NO result — the runner could not even run it
  if [ "$canary_bad" -eq 1 ]; then
    echo
    echo "${RED}FATAL (CANARY)${NC}: the known-good canary gate ($CANARY_ID) did NOT go RED on its"
    echo "        ORACLE-confirmed planted defect. Check 3 is known-good; if the canary reports"
    echo "        'decoration', the defect is in the RUNNER (or Check 3 was neutered) — NOT the checks."
    echo "        Refusing to report a tree of false positives. (registry _canary_doc)" >&2
    exit 2
  fi
fi

echo
echo "═════════════════════════════════════════════════════════════════════"
echo "  proven can-fail : $PROVEN"
if [ "$ABSENT_SKIPPED" -gt 0 ]; then
  echo "  UNPROVEN (plant target absent) : $ABSENT_SKIPPED"
  printf '%s\n' "$ABSENT_GATES"
  echo "  ^ these gates were NOT proven. Build the missing artifact(s) and re-run."
fi
if [ "$DIRTY_SKIPPED" -gt 0 ]; then
  echo "  UNPROVEN (dirty plant target) : $DIRTY_SKIPPED"
  printf '%s\n' "$DIRTY_GATES"
  echo "  ^ these gates were NOT proven. Commit the listed plant target(s) and re-run."
fi
echo "  failures        : $FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  echo "${RED}FAIL${NC}: $FAILURES gate(s) are not proven. A gate that cannot fail is not a gate."
  exit 1
fi
echo "${GREEN}PASS${NC}: every registered gate was DEFEATED and went RED. They are real."
exit 0

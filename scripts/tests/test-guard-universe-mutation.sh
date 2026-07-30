#!/usr/bin/env bash
# scripts/tests/test-guard-universe-mutation.sh
#
# P7b (plan-2026-07-15-wave-1-g6-anti-vacuity-registry §4, CR-72 / M4) — mutation-test the P4 GUARD-
# UNIVERSE machinery: the AST discoverer, the completeness gate over the guard universe, and the
# `exempt` allowlist validator. The Wave-1a P7a harness attacks the shell fail-point runner; this
# attacks the parts that only exist in Wave 1b. A gate nobody attacked is a brick.
#
# Each mutation is REAL-TREE (CR-72): plant a scratch test file / a scratch registry-or-reasons edit,
# run the REAL discoverer + completeness gate, demand the expected verdict, then restore. A planted
# *.test.ts is `git add -N`'d so `git ls-files` (the discoverer's tracked-membership source) sees it,
# then unstaged + removed. Restores run in a `trap … EXIT`. Cleanliness is proven by BYTE-COMPARING
# the registry + exempt-reasons to a start-of-run snapshot (robust whether they are committed or an
# intentional WIP — a git-vs-HEAD check would conflate "my plant leaked" with "the file was WIP"),
# and by asserting every scratch probe is gone at start AND end (a SIGKILL skips the trap, so the
# start assertion is the only way to tell a leak from pre-existing dirt).
#
# Asserts (each must go the ANTI-vacuity direction):
#   1. FULL-UNIVERSE GREEN  — the pristine registry PASSES completeness (anti-brick; a gate that FAILs on everything gets disabled)
#   2. UN-RULED CANDIDATE   — a new committed-source-reading *.test.ts in NEITHER gates NOR exempt → completeness FAIL
#   3. EXEMPT (i)           — a CR-named guard smuggled into exempt → FAIL (the T-3 laundering hatch)
#   4. EXEMPT (ii)          — a stale exempt path (not a candidate) → FAIL
#   5. EXEMPT (iii)         — an empty-reason exempt entry → FAIL
#   6. EXEMPT (iv)          — an edited-since-ruling exempt (hash mismatch) → FAIL
#   7. M-exec DISCOVERY     — a git-ls-files shell-out test → discovered (M-exec), un-ruled → FAIL
#   8. M-import DISCOVERY   — a first-party-import-only test → discovered (M-import), un-ruled → FAIL
#   9. dist DISCOVERY       — a spawnSync(dist/…) test → discovered (M-exec dist), un-ruled → FAIL
#  10. UNRESOLVABLE         — a readFileSync(runtimeVar) test → FLAGGED unresolvable, un-ruled → FAIL (never silently dropped)
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to $REPO_ROOT" >&2; exit 2; }
RUNNER="scripts/massu-gate-anti-vacuity.sh"
REG="scripts/lib/gate-registry.json"
REASONS="scripts/lib/exempt-reasons.json"
DISC="scripts/tests/_discover_guard_universe.mjs"
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'
PASS=0; FAIL=0
_ok(){ printf '  %sOK%s   %s\n' "$GREEN" "$NC" "$1"; PASS=$((PASS+1)); }
_bad(){ printf '  %sFAIL%s %s\n' "$RED" "$NC" "$1"; FAIL=$((FAIL+1)); }

PROBE_DIR="packages/core/src/__tests__"
PROBES=("$PROBE_DIR/__av_p7b_unruled.test.ts" "$PROBE_DIR/__av_p7b_mexec.test.ts" \
        "$PROBE_DIR/__av_p7b_mimport.test.ts" "$PROBE_DIR/__av_p7b_dist.test.ts" \
        "$PROBE_DIR/__av_p7b_unresolvable.test.ts")

probe_present(){ for p in "${PROBES[@]}"; do [ -e "$p" ] && echo "$p"; done; }
if [ -n "$(probe_present)" ]; then
  echo "${RED}FATAL${NC}: a P7b scratch probe already exists before the test — leaked from a prior kill:" >&2
  probe_present >&2; exit 2
fi
SNAP="$(mktemp -d)"; cp -p "$REG" "$SNAP/reg.json"; cp -p "$REASONS" "$SNAP/reasons.json"
drop_probe(){ git reset -q -- "$1" 2>/dev/null || true; rm -f "$1"; }
restore(){ cp -p "$SNAP/reg.json" "$REG"; cp -p "$SNAP/reasons.json" "$REASONS"; for p in "${PROBES[@]}"; do drop_probe "$p"; done; }
# A FUNCTION, not an inline trap string. The previous form inlined a call to `restore`, a
# separator, and a recursive force-delete of the snapshot dir all inside ONE quoted trap
# argument — putting a shell metacharacter beside a destructive token in a single literal,
# the shape G25/CR-88 forbids,
# and the payload-safety gate correctly flagged it. This is real cleanup rather than a test
# payload, so it was never weaponizable by a plant; the fix is still worth making, because a
# scanner that has to distinguish "cleanup" from "payload" by intent is a scanner people learn
# to argue with.
#
# `${SNAP:?}` is the G17/CR-77 half: if SNAP were ever empty or unset this aborts LOUDLY
# instead of running `rm -rf ""`. `set -u` does NOT cover this — SNAP would be SET-and-empty
# if mktemp failed, and empty is exactly the value that widens a delete to its parent.
# shellcheck disable=SC2329  # invoked indirectly by `trap cleanup EXIT` below
cleanup() {
  restore
  rm -rf "${SNAP:?cleanup: SNAP is empty/unset — refusing to rm}"
}
trap cleanup EXIT

# CAPTURE-then-here-string: `<producer> | grep -q` short-circuits under `set -o pipefail` (grep -q
# exits on match → SIGPIPE to the runner → pipeline non-zero → the `&&` never fires). That is the
# Wave-1a Check-26 broken-pipe bug; do NOT reintroduce it. Capture once, grep a here-string.
COMP=""
run_comp(){ COMP="$(bash "$RUNNER" --completeness-only 2>&1 | sed -E $'s/\033\\[[0-9;]*m//g')"; }
comp_has(){ /usr/bin/grep -qE "$1" <<<"$COMP"; }
disc_mech(){ # $1 = probe path -> prints the mechanisms+flags list, or MISSING
  NODE_PATH="$REPO_ROOT/node_modules" node "$DISC" --repo-root "$REPO_ROOT" 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); p=sys.argv[1]
c=next((x for x in d["candidates"] if x["path"]==p), None)
print("MISSING" if not c else ",".join(c.get("mechanisms",[])+c.get("flags",[])))' "$1"; }

echo "════════════════════════════════════════════════════════════════"
echo " P7b — mutation-testing the guard-universe machinery (CR-72, real tree)"
echo "════════════════════════════════════════════════════════════════"

# 1. FULL-UNIVERSE GREEN (anti-brick)
restore; run_comp
if comp_has 'OK: all .* guard candidates carry'; then
  _ok "FULL-UNIVERSE GREEN: pristine registry passes completeness (not a brick)"
else _bad "FULL-UNIVERSE GREEN: pristine registry did NOT pass completeness"; fi

# 2 + 7-10: plant a *.test.ts, git add -N so it's a candidate, assert discovery mechanism + un-ruled FAIL
plant_disc(){ # $1=probe  $2=expected-mechanism  $3=name  $4=heredoc-content
  local probe="$1" mech="$2" name="$3" content="$4"
  restore
  printf '%s' "$content" > "$probe"; git add -N "$probe" 2>/dev/null
  local got; got="$(disc_mech "$probe")"
  run_comp; local red=0; comp_has 'NEITHER a can-fail proof' && red=1
  if /usr/bin/grep -q "$mech" <<<"$got" && [ "$red" -eq 1 ]; then
    _ok "$name: discovered ($mech) + un-ruled → completeness FAIL"
  else _bad "$name: mech='$got' (want $mech), completeness-fail=$red"; fi
  drop_probe "$probe"
}
plant_disc "$PROBE_DIR/__av_p7b_unruled.test.ts" "M-fs" "UN-RULED CANDIDATE" \
"import { readFileSync } from 'fs'; import { join } from 'path';
const SRC = join(__dirname, '..');
it('p', () => { expect(readFileSync(join(SRC, 'config.ts'), 'utf8').length).toBeGreaterThan(0); });
"
plant_disc "$PROBE_DIR/__av_p7b_mexec.test.ts" "M-exec" "M-exec DISCOVERY" \
"import { execSync } from 'node:child_process';
it('p', () => { expect(execSync('git ls-files', { encoding: 'utf8' }).length).toBeGreaterThan(0); });
"
plant_disc "$PROBE_DIR/__av_p7b_mimport.test.ts" "M-import" "M-import DISCOVERY" \
"import { getConfig } from '../config.ts';
it('p', () => { expect(typeof getConfig).toBe('function'); });
"
plant_disc "$PROBE_DIR/__av_p7b_dist.test.ts" "M-exec" "dist DISCOVERY" \
"import { spawnSync } from 'node:child_process'; import { resolve } from 'node:path';
const HOOK = resolve(__dirname, '..', '..', 'dist', 'hooks', 'session-start.js');
it('p', () => { spawnSync('node', [HOOK]); expect(true).toBe(true); });
"
plant_disc "$PROBE_DIR/__av_p7b_unresolvable.test.ts" "unresolvable-reference" "UNRESOLVABLE (fail-closed)" \
"import { readFileSync } from 'fs';
const p: string = process.env.SOME_RUNTIME_VAR || 'x';
it('p', () => { try { readFileSync(p); } catch {} expect(true).toBe(true); });
"

# 3-6: EXEMPT invariants — edit the registry exempt array on a scratch copy, restore after each
exempt_append(){ python3 - "$1" <<PY
import json,sys
reg=json.load(open("$REG")); reg.setdefault("exempt",[]).append(json.loads(sys.argv[1]))
json.dump(reg,open("$REG","w"),indent=2)
PY
}
CR_NAMED="packages/core/src/__tests__/ci-prepush-parity.test.ts"
restore; exempt_append "$(printf '{"path":"%s","reason":"laundering","hash":"sha256:x"}' "$CR_NAMED")"; run_comp
if comp_has '\(i\) a CR-named'; then _ok "EXEMPT (i): CR-named guard in exempt → FAIL"; else _bad "EXEMPT (i): not caught"; fi
restore; exempt_append '{"path":"packages/core/src/__tests__/__nope.test.ts","reason":"x","hash":"sha256:x"}'; run_comp
if comp_has '\(ii\) stale'; then _ok "EXEMPT (ii): stale exempt path → FAIL"; else _bad "EXEMPT (ii): not caught"; fi
restore; exempt_append '{"path":"scripts/tests/test-run-logged.sh","reason":"   ","hash":"sha256:x"}'; run_comp
if comp_has '\(iii\) empty'; then _ok "EXEMPT (iii): empty reason → FAIL"; else _bad "EXEMPT (iii): not caught"; fi
restore
python3 - <<PY
import json
reg=json.load(open("$REG"))
for e in reg.get("exempt",[]):
    if e["path"].endswith("test-run-logged.sh"): e["hash"]="sha256:deadbeef"
json.dump(reg,open("$REG","w"),indent=2)
PY
run_comp
if comp_has '\(iv\) content-hash mismatch'; then _ok "EXEMPT (iv): hash mismatch → FAIL"; else _bad "EXEMPT (iv): not caught"; fi
restore

# FINAL: registry + reasons byte-identical to snapshot; no probe leaked.
LEAK=""
cmp -s "$REG" "$SNAP/reg.json" || LEAK="$LEAK gate-registry.json"
cmp -s "$REASONS" "$SNAP/reasons.json" || LEAK="$LEAK exempt-reasons.json"
[ -n "$(probe_present)" ] && LEAK="$LEAK $(probe_present)"
if [ -n "$LEAK" ]; then echo; echo "${RED}FATAL${NC}: leaked:$LEAK"; FAIL=$((FAIL+1));
else _ok "RESTORE: registry + reasons byte-identical to snapshot; no probe leaked"; fi

echo
echo "  passed: $PASS   failed: $FAIL"
[ "$FAIL" -gt 0 ] && { echo "${RED}FAIL${NC}: guard-universe machinery did not behave under mutation."; exit 1; }
echo "${GREEN}PASS${NC}: the discoverer flags every mechanism + fail-closed, and the completeness/exempt"
echo "       validator FAILs on an un-ruled candidate and every invalid exempt entry."
exit 0

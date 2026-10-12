#!/usr/bin/env bash
# CR-72 live-fire for X-6 — plant each defect in the REAL tree, demand the guard goes RED
# FOR ITS OWN DECLARED REASON, restore, prove byte-identity, prove it OPENS again.
#
# SUBJECT: packages/core/src/__tests__/gate-reddening-proof-drift-guard.test.ts and
#          scripts/ops/prove-gate-reddening.py (plan item X-6).
#
# ⛔ WHY EACH CHECK EXISTS. A reddening proof is pinned to a TRIPLE, and a guard that
# notices only one leg of it is worse than none: it reports the same green for "all three
# unchanged" as for "two of them moved". So the three invalidation paths are attacked
# SEPARATELY and each must be named by the guard:
#
#     1. the PLANT SPEC changed   -> the mutation being made is a different claim
#     2. a PLANT TARGET changed   -> the planted defect may no longer be a defect
#     3. the TEST changed         -> the assertion that noticed it may have moved or parked
#
# Path 3 is the one the 2026-09-21 failures needed and the one implementations omit —
# StrykerJS carries a reported bug of exactly that shape.
#
# ⛔ AND TWO CONTROLS WITHOUT WHICH THE ABOVE PROVES NOTHING:
#     4. NEGATIVE — untouched tree: the guard is GREEN and the prover re-proves ZERO.
#        A guard that is always red is a brick, and a brick gets disabled (CR-72).
#     5. EXIT-2 ISOLATION — with a plant target withdrawn the prover must exit 2, name the
#        gate, and leave the ledger BYTE-IDENTICAL. "I could not look" must neither
#        overwrite a real RED nor masquerade as a defect (G26/CR-89).
#
# ⛔ NO `rm -rf`, NO INTERPOLATED DELETE PATH (G17). Withdrawal is a `mv` aside and a `mv`
# back. Cleanup lives in a FUNCTION, never inside a `trap '...'` string, because this
# machine's payload-safety guard refuses a shell metacharacter beside a destructive token
# inside one literal (G25/CR-88).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SELF_DIR}/../.." && pwd)"

# ── DIAGNOSTIC SENTINELS — read from the EMITTER, never typed here ───────────────────────
# Check 4a used to grep for 'working tree is DIRTY'. prove-gate-reddening.py has NEVER
# printed that phrase — it belongs to probe-gate-requires.sh — so the assertion could only
# ever fail, and the scenario's two OTHER assertions passing made a DEAD PIN look like a
# near-miss. A pin is the right kind of assertion; a pin whose literal is typed at the
# CONSUMER has no link to the PRODUCER, so a reworded message de-arms it with no diff and
# no error. Both sides now read scripts/lib/gate_sentinels.py.
#
# FAILS CLOSED, and that is load-bearing: an empty sentinel would make `grep -qF ""` match
# every line, turning every assertion below permanently GREEN.
# ⛔ `return`, NEVER `exit`, and the CALLER must check. The first draft of this helper said
# `exit 2` — which runs in the COMMAND-SUBSTITUTION SUBSHELL, so it exited the subshell, the
# assignment took the empty string, the script carried on, and `grep -qF ""` matched every
# line: every assertion below would have been permanently GREEN. The live-fire passed 21/21
# while carrying it, because the sentinel WAS readable — a green run cannot see this. It was
# caught only by running the fail-closed path on purpose (G10 — a fix is a new instance of
# the defect until proven otherwise).
sentinel() {
  local _v
  _v="$(python3 "${REPO}/scripts/lib/gate_sentinels.py" --print "$1")" || {
    echo "FATAL: gate sentinel '$1' could not be read — refusing to assert on a phrase" >&2
    echo "       this script invented. (scripts/lib/gate_sentinels.py --list)" >&2
    return 2
  }
  [ -n "${_v}" ] || {
    echo "FATAL: gate sentinel '$1' is EMPTY — that would match every line." >&2; return 2; }
  printf '%s' "${_v}"
}
S_DIRTY="$(sentinel dirty-tree)"           || exit 2
S_ABSENT="$(sentinel plant-target-absent)" || exit 2
S_STALE="$(sentinel proof-stale)"          || exit 2
S_NOTHING="$(sentinel nothing-to-prove)"   || exit 2
# Belt and braces: `|| exit` above depends on the substitution propagating the status, so the
# VALUES are asserted non-empty independently. An empty pattern is the whole hazard.
for _s_name in S_DIRTY S_ABSENT S_STALE S_NOTHING; do
  eval "_s_val=\${$_s_name}"
  [ -n "${_s_val}" ] || {
    echo "FATAL: gate sentinel ${_s_name} resolved EMPTY — refusing to run, because an" >&2
    echo "       empty pattern makes every grep below match and every check pass." >&2
    exit 2; }
done
cd "${REPO}" || exit 2

# G29: this script operates on the REAL repository and reads its status, so it ASSERTS the
# repo rather than scrubbing. `--show-toplevel` is blind to a leaked GIT_DIR; git_bind_or_die
# compares the GIT DIRECTORY, which is the value that actually moves.
# shellcheck source=scripts/lib/git-env-scrub.sh
. "${REPO}/scripts/lib/git-env-scrub.sh"
git_bind_or_die "${REPO}" || exit 2

GATE='vitest-guard::packages/core/src/__tests__/asset-render-parity.test.ts'
TARGET='packages/core/src/commands/show-template.ts'
TEST='packages/core/src/__tests__/asset-render-parity.test.ts'
GUARD='src/__tests__/gate-reddening-proof-drift-guard.test.ts'
REG='scripts/lib/gate-registry.json'
LEDGER='scripts/lib/gate-proofs.json'

# A SECOND gate, chosen because its plant pattern carries a CAPTURE GROUP over a SHARED,
# high-churn target. GATE's pattern is fully literal, so on it "the matched region changed" and
# "the pattern stopped matching" are the SAME event, and the capture case would go untested.
# A capture group is the shape a dependency bump actually hits.
GATE2='vitest-guard::website/src/__tests__/security-packages-pinned.test.ts'
TARGET2='website/package.json'
MATCHED_LINE='  process.stdout.write(rendered.content);'

for f in "${TARGET}" "${TEST}" "${REG}" "${LEDGER}" "${TARGET2}"; do
  [ -f "${f}" ] || { echo "FATAL: ${f} not found — the attack cannot run" >&2; exit 2; }
done

# The plant's matched region must really be there, or every assertion below about "the matched
# region moved" is vacuous — a positive control has to reach the branch it names.
if [ "$(grep -cF "${MATCHED_LINE}" "${TARGET}")" != "1" ]; then
  echo "FATAL: expected exactly 1 occurrence of the planted line in ${TARGET}" >&2
  echo "       The scope assertions would not exercise the branch they claim to." >&2
  exit 2
fi

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

SHA_TARGET="$(sha "${TARGET}")"
SHA_TEST="$(sha "${TEST}")"
SHA_REG="$(sha "${REG}")"
SHA_LEDGER="$(sha "${LEDGER}")"
SHA_TARGET2="$(sha "${TARGET2}")"

BK="$(mktemp -d)" || exit 2
cp "${TARGET}" "${BK}/target" || exit 2
cp "${TEST}"   "${BK}/test"   || exit 2
cp "${REG}"    "${BK}/reg"    || exit 2
cp "${LEDGER}" "${BK}/ledger" || exit 2
cp "${TARGET2}" "${BK}/target2" || exit 2

restore_all() {
  cp "${BK}/target" "${TARGET}" 2>/dev/null
  cp "${BK}/test"   "${TEST}"   2>/dev/null
  cp "${BK}/reg"    "${REG}"    2>/dev/null
  cp "${BK}/ledger" "${LEDGER}" 2>/dev/null
  cp "${BK}/target2" "${TARGET2}" 2>/dev/null
  # Path 5 moves the target aside; put it back if we died mid-flight.
  # Checks 4a/4b move a target aside; put it back if we died mid-flight.
  if [ -f "${TARGET}.withdrawn" ]; then
    mv "${TARGET}.withdrawn" "${TARGET}" 2>/dev/null
  fi
  if [ -f "packages/core/dist/detect/adapters/.bundle-shasums.json.withdrawn" ]; then
    mv "packages/core/dist/detect/adapters/.bundle-shasums.json.withdrawn" \
       "packages/core/dist/detect/adapters/.bundle-shasums.json" 2>/dev/null
  fi
}
cleanup() {
  restore_all
  rm -rf "${BK}"
}
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /' | tail -12; FAIL=$((FAIL+1)); }

# Run the guard the way `npm test` runs it (M3), capturing both streams.
guard() {
  GOUT="$(cd packages/core && npx vitest run "${GUARD}" 2>&1)"; GRC=$?
}

echo "=== 0. NEGATIVE CONTROL — untouched tree: the guard OPENS and nothing re-proves ==="
guard
if [ "${GRC}" -eq 0 ]; then ok "guard is GREEN on a current ledger"
else bad "guard is RED before any plant — it is a brick, and a brick gets bypassed" "${GOUT}"; fi

DRY="$(python3 scripts/ops/prove-gate-reddening.py --dry-run 2>&1)"; DRC=$?
if [ "${DRC}" -eq 0 ] && printf '%s' "${DRY}" | grep -qF "${S_NOTHING}"; then
  ok "prover re-proves ZERO gates on an unchanged tree (the ledger is doing its job)"
else
  bad "prover wanted to re-prove work on an unchanged tree (rc=${DRC})" "${DRY}"
fi

DERIVED="$(printf '%s' "${DRY}" | sed -n 's/.*source-plant gates (derived)[^0-9]*\([0-9]*\).*/\1/p' | head -1)"
if [ "${DERIVED:-0}" -gt 0 ] 2>/dev/null; then ok "denominator reported and non-zero: ${DERIVED} gate(s)"
else bad "prover reported no denominator — a census over nothing reads healthy"; fi

# ── the three invalidation paths ───────────────────────────────────────────────────────
# Each asserts BOTH that the guard went RED and that it named THIS gate as STALE. A red
# for some other reason would score a false pass.
attack() {
  local label="$1"
  guard
  if [ "${GRC}" -ne 0 ] && printf '%s' "${GOUT}" | grep -qF "${S_STALE}" && printf '%s' "${GOUT}" | grep -qF "${GATE}"; then
    ok "${label} -> guard RED, naming this gate as STALE"
  else
    bad "${label} -> guard did NOT report this gate STALE (rc=${GRC})" "${GOUT}"
  fi
  restore_all
}

# The OTHER direction, added with the 2026-09-21 scope fix: an edit that CANNOT affect whether
# the plant still reddens its test must leave the verdict STANDING. Asserting only the RED
# direction is how a key silently drifts back to whole-file hashing — over-invalidation is
# invisible to any test that only ever plants a real defect.
survive() {
  local label="$1"
  guard
  if [ "${GRC}" -eq 0 ]; then
    ok "${label} -> proof SURVIVES (guard GREEN), as a mis-scoped key would not"
  else
    bad "${label} -> guard went RED on a change that cannot affect reddening (rc=${GRC}); the proof key has drifted back to covering more than the plant-relevant slice" "${GOUT}"
  fi
  restore_all
}

echo "=== 1. PLANT SPEC invalidation — the mutation itself is a different claim ==="
python3 - "${REG}" "${GATE}" <<'PY'
import io, json, sys
p, gid = sys.argv[1], sys.argv[2]
reg = json.load(io.open(p, encoding='utf-8'))
g = next(x for x in reg['gates'] if x['id'] == gid)
g['plant'][0]['replace'] = g['plant'][0]['replace'] + ' // AV-SPEC-DRIFT'
io.open(p, 'w', encoding='utf-8').write(json.dumps(reg, indent=1) + '\n')
print('  planted: the gate plant spec changed')
PY
attack "plant spec changed"

echo "=== 2. PLANT TARGET invalidation — scoped to the PLANT-RELEVANT SLICE (2026-09-21) ==="
# Until 2026-09-21 the key hashed the WHOLE target, so 2a below was asserted as a RED. That made
# the key a CORRELATE of the property rather than the property itself (G28/CR-91): measured across
# the two open Dependabot PRs, 6 of 7 stale proofs had an UNCHANGED matched region, so six of
# seven demanded re-proves measured nothing. Both directions are asserted here so that neither
# can regress on its own.

echo "--- 2a. an UNRELATED region of the target changes -> the proof MUST STAND ---"
printf '\n// LF-UNRELATED-EDIT — deliberately not the planted region\n' >> "${TARGET}"
echo "  planted: ${TARGET} changed OUTSIDE the plant's matched region"
survive "unrelated region of the plant target changed"

echo "--- 2b. the MATCHED region itself changes -> RED, naming this gate ---"
python3 - "${TARGET}" "${MATCHED_LINE}" <<'LF_2B'
import io, sys
p, line = sys.argv[1], sys.argv[2]
s = io.open(p, encoding='utf-8').read()
assert s.count(line) == 1, 'expected exactly one occurrence'
# Perturb the planted line itself. Deliberately NOT the oracle's marker string: this has to go
# STALE because the SLICE moved, not because the planted defect appeared.
io.open(p, 'w', encoding='utf-8').write(s.replace(line, line.replace(');', ' );'), 1))
print('  planted: the matched region itself changed')
LF_2B
attack "matched region of the plant target changed"

echo "--- 2c. a SECOND occurrence appears (match COUNT moves) -> RED ---"
python3 - "${TARGET}" "${MATCHED_LINE}" <<'LF_2C'
import io, sys
p, line = sys.argv[1], sys.argv[2]
s = io.open(p, encoding='utf-8').read()
assert s.count(line) == 1, 'expected exactly one occurrence'
# A duplicate makes it ambiguous which site the plant rewrites. Digesting the matched TEXT alone
# would miss this, which is why the COUNT is part of the slice.
io.open(p, 'w', encoding='utf-8').write(s.replace(line, line + '\n' + line, 1))
print('  planted: a second matching occurrence')
LF_2C
attack "match count of the plant target changed"

echo "=== 2d. CAPTURE-GROUP pattern on a SHARED target — the dependency-bump shape ==="
echo "--- 2d-i. a DIFFERENT dependency is bumped -> the proof MUST STAND ---"
python3 - "${TARGET2}" <<'LF_2DI'
import io, json, re, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
deps = json.loads(s).get('dependencies', {})
victim = next((k for k, v in sorted(deps.items())
               if k != '@upstash/redis' and re.fullmatch(r'\d+\.\d+\.\d+', str(v))), None)
if victim is None:
    sys.exit('FATAL: no other exact-pinned dependency to bump — control cannot run')
cur = deps[victim]
head, last = cur.rsplit('.', 1)
old = '"%s": "%s"' % (victim, cur)
if s.count(old) != 1:
    sys.exit('FATAL: ambiguous dependency line for %s' % victim)
io.open(p, 'w', encoding='utf-8').write(
    s.replace(old, '"%s": "%s.%d"' % (victim, head, int(last) + 1), 1))
print('  planted: bumped %s (NOT the line this plant rewrites)' % victim)
LF_2DI
survive "an unrelated dependency bumped in the shared plant target"

echo "--- 2d-ii. the PLANTED dependency is bumped -> RED, naming that gate ---"
python3 - "${TARGET2}" <<'LF_2DII'
import io, json, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
cur = json.loads(s)['dependencies']['@upstash/redis']
head, last = cur.rsplit('.', 1)
old = '"@upstash/redis": "%s"' % cur
if s.count(old) != 1:
    sys.exit('FATAL: ambiguous @upstash/redis line')
io.open(p, 'w', encoding='utf-8').write(
    s.replace(old, '"@upstash/redis": "%s.%d"' % (head, int(last) + 1), 1))
print('  planted: bumped @upstash/redis — the very line this plant rewrites')
LF_2DII
guard
if [ "${GRC}" -ne 0 ] && printf '%s' "${GOUT}" | grep -qF "${S_STALE}" \
   && printf '%s' "${GOUT}" | grep -qF "${GATE2}"; then
  ok "planted dependency bumped -> guard RED, naming the capture-group gate as STALE"
else
  bad "a bump of the plant's OWN target line did not invalidate its proof (rc=${GRC})" "${GOUT}"
fi
restore_all

echo "=== 3. TEST invalidation — the assertion that noticed it may have moved or parked ==="
printf '\n// AV-TEST-DRIFT\n' >> "${TEST}"
echo "  planted: ${TEST} content changed"
attack "test changed"

echo "=== 4. EXIT-2 ISOLATION — could-not-measure must not touch the ledger ==="
#
# ⛔ THERE ARE TWO COULD-NOT-MEASURE STATES AND THEY ARE REACHED BY DIFFERENT TARGETS.
# Measured 2026-09-21 over all 272 source-plant gates: 180 distinct plant targets, of which
# 175 are TRACKED and 5 are build artifacts or generated fixtures.
#
#   a TRACKED target withdrawn   -> shows as `D` in porcelain -> the prover's DIRTY-TREE
#                                   refusal fires FIRST and the plant is never attempted
#   an IGNORED target withdrawn  -> the tree stays clean, the prover proceeds, and the
#                                   executor raises PLANT TARGET ABSENT
#
# The first draft of this check withdrew a TRACKED file and demanded `PLANT TARGET ABSENT`.
# It could never have passed — and had it merely asserted `exit 2` it would have passed for
# the WRONG REASON, certifying a branch it never reached (G23). Both states are asserted
# below, each by the target class that actually reaches it, because the property that matters
# is the same for both: an unmeasurable run must leave the ledger untouched.

assert_ledger_untouched() {
  local label="$1" before="$2" after="$3"
  if [ "${before}" = "${after}" ]; then ok "${label}: ledger BYTE-IDENTICAL across the exit-2 run"
  else bad "${label}: the ledger CHANGED on an unmeasurable run (${before} -> ${after})"; fi
}

echo "--- 4a. a TRACKED plant target withdrawn -> refuse on the dirty tree ---"
LEDGER_BEFORE="$(sha "${LEDGER}")"
mv "${TARGET}" "${TARGET}.withdrawn" || exit 2
POUT="$(python3 scripts/ops/prove-gate-reddening.py --gates "${GATE}" --all 2>&1)"; PRC=$?
mv "${TARGET}.withdrawn" "${TARGET}" || exit 2
LEDGER_AFTER="$(sha "${LEDGER}")"
if [ "${PRC}" -eq 2 ] && printf '%s' "${POUT}" | grep -qF "${S_DIRTY}"; then
  ok "4a: prover exits 2 naming the DIRTY TREE (the plant is never attempted)"
else
  bad "4a: prover exited ${PRC} without naming the dirty tree" "${POUT}"
fi
assert_ledger_untouched "4a" "${LEDGER_BEFORE}" "${LEDGER_AFTER}"

echo "--- 4b. an IGNORED (build-artifact) plant target withdrawn -> PLANT TARGET ABSENT ---"
# `.bundle-shasums.json` is matched by `.gitignore:2:dist/`, verified with
# `git check-ignore -v`, so withdrawing it leaves the tree clean and the prover reaches the
# plant. This is also the realistic shape of the condition: a MISSING BUILD.
BGATE='vitest-guard::packages/core/src/__tests__/adapter-bundle-reproducibility.test.ts'
BTARGET='packages/core/dist/detect/adapters/.bundle-shasums.json'
if [ ! -f "${BTARGET}" ]; then
  bad "4b: ${BTARGET} absent before the attack — run \`npm run build\` first; SKIPPED is not a pass"
else
  LEDGER_BEFORE="$(sha "${LEDGER}")"
  mv "${BTARGET}" "${BTARGET}.withdrawn" || exit 2
  POUT="$(python3 scripts/ops/prove-gate-reddening.py --gates "${BGATE}" --all 2>&1)"; PRC=$?
  mv "${BTARGET}.withdrawn" "${BTARGET}" || exit 2
  LEDGER_AFTER="$(sha "${LEDGER}")"
  if [ "${PRC}" -eq 2 ] && printf '%s' "${POUT}" | grep -qF "${S_ABSENT}"; then
    ok "4b: prover exits 2 naming PLANT TARGET ABSENT (not a defect, not a pass)"
  else
    bad "4b: prover exited ${PRC} without naming PLANT TARGET ABSENT" "${POUT}"
  fi
  if printf '%s' "${POUT}" | grep -qF "${BGATE}"; then ok "4b: the unmeasurable gate is NAMED"
  else bad "4b: the prover did not name which gate it could not measure" "${POUT}"; fi
  assert_ledger_untouched "4b" "${LEDGER_BEFORE}" "${LEDGER_AFTER}"
fi

echo "=== 5. RESTORE — byte-identical, and the guard OPENS again ==="
restore_all
[ "$(sha "${TARGET}")" = "${SHA_TARGET}" ] && ok "target restored byte-identical" || bad "target NOT restored"
[ "$(sha "${TEST}")"   = "${SHA_TEST}" ]   && ok "test restored byte-identical"   || bad "test NOT restored"
[ "$(sha "${REG}")"    = "${SHA_REG}" ]    && ok "registry restored byte-identical" || bad "registry NOT restored"
[ "$(sha "${LEDGER}")" = "${SHA_LEDGER}" ] && ok "ledger restored byte-identical"  || bad "ledger NOT restored"
[ "$(sha "${TARGET2}")" = "${SHA_TARGET2}" ] && ok "shared plant target restored byte-identical" || bad "TARGET2 NOT restored — a dependency manifest was left planted"
guard
if [ "${GRC}" -eq 0 ]; then ok "guard OPENS again after restore"
else bad "guard still RED after restore — it does not open, so it will be disabled" "${GOUT}"; fi

echo "----"
echo "live-fire: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ] || exit 1
exit 0

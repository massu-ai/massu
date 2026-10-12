#!/usr/bin/env bash
# CR-72 live-fire — does the parser-parity drift-guard actually READ the parser it polices?
#
# SUBJECT: website/src/__tests__/ruleset-parser-parity.test.ts (the guard)
#          scripts/ruleset-context-coverage.mjs (the parser it CLAIMS to police, and the one
#          that backs the REQUIRED status check `Ruleset Drift Guard` on BOTH repos)
#
# ⛔ WHY THIS ATTACK AND NOT THE REGISTERED ONE. The anti-vacuity registry already carries a
# plant for this gate against this file, and it breaks the `jobs.<id>.name` regex — job names
# fall back to job IDs, required display names stop being emitted, FORWARD coverage fails, and
# the :165 smoke test goes RED. That proof is valid and it exercises ONE of the gate's two
# claims. This attack takes the OTHER one: reverse coverage is a universally quantified claim
# over a set the parser itself computes, so SHRINKING that set makes the claim EASIER. A plant
# that empties it is the shape no forward-coverage assertion can ever see.
#
# ⛔ THE PLANT IS A REGEX TEXT SWAP AND NOTHING ELSE (G25/CR-88). No destructive token, no
# shell metacharacter beside one, no interpolated path (G17). Restoration is
# `git checkout -- <literal path>` and is asserted by sha256, not by reading the diff.
#
# EXIT: 0 the guard went RED under the plant (the blindness is closed)
#       1 the guard stayed GREEN under the plant (BLIND — the finding)
#       2 could not look (M2: bind failure, plant not applied, suite never ran)
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SELF_DIR}/.." && cd .. && pwd)"
# shellcheck source-path=SCRIPTDIR/../lib source=vitest-verdict.sh
. "${REPO}/scripts/lib/vitest-verdict.sh"

# G29/CR-92: this script is repo-bound, so it ASSERTS the repository rather than scrubbing —
# `--show-toplevel` is blind to a leaked GIT_DIR, git_bind_or_die compares the absolute git dir.
# shellcheck source=scripts/lib/git-env-scrub.sh
. "${REPO}/scripts/lib/git-env-scrub.sh"
git_bind_or_die "${REPO}" || exit 2

# The parser lives in the SHARED CORE now, so that is where the plant goes: planting in the
# CLI would be planting in a file that no longer contains a parser (CR-74 — the fix moved the
# obligated site). The CLI is still the thing run, because that is how production runs it.
CORE_REL='scripts/lib/ruleset-coverage-core.mjs'
CORE="${REPO}/${CORE_REL}"
MJS_REL='scripts/ruleset-context-coverage.mjs'
MJS="${REPO}/${MJS_REL}"
# ⛔ THE GUARD SET IS DERIVED, NEVER TYPED (G32, Rule 25). The first version of this script
# carried the three filenames as a literal list; renaming one of them left the roster naming a
# deleted file, the run scored UNMEASURED, and a stale roster is how a live-fire quietly stops
# covering what it claims to. The registry already knows which guards plant into these subjects —
# ask it. A guard added or renamed is then covered on its first commit.
derive_guards() {
  python3 - "${REPO}" "${CORE_REL}" "${MJS_REL}" <<'PYEOF'
import json, io, sys
repo, *subjects = sys.argv[1:]
d = json.load(io.open(f'{repo}/scripts/lib/gate-registry.json', encoding='utf-8'))
out = []
for g in d.get('gates', []):
    if g.get('kind') != 'vitest-guard':
        continue
    paths = {str(p.get('path', '')) for p in (g.get('plant') or [])}
    if paths & set(subjects):
        t = g.get('test') or g.get('path') or ''
        if t.startswith('website/'):
            out.append(t[len('website/'):])
for t in sorted(set(out)):
    print(t)
PYEOF
}
GUARDS="$(derive_guards)" || { printf 'M2: could not read the gate registry\n' >&2; exit 2; }
# Plus the coverage guard, which consumes the same judgement without planting into it. Derived
# from its existence on disk rather than assumed, so a rename is a LOUD failure.
COV_REL='website/src/__tests__/ruleset-context-coverage.test.ts'
[ -f "${REPO}/${COV_REL}" ] || { printf 'M2: %s absent\n' "${COV_REL}" >&2; exit 2; }
GUARDS="${GUARDS}
${COV_REL#website/}"
GUARD_N="$(printf '%s\n' "${GUARDS}" | grep -c .)"
[ "${GUARD_N}" -ge 2 ] || {
  printf 'M1: derived only %s guard(s) from the registry for subjects %s / %s — refusing to judge.\n' \
    "${GUARD_N}" "${CORE_REL}" "${MJS_REL}" >&2
  exit 2
}
OUT="$(mktemp -d)"

DRY_RUN=0; LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --list)    LIST=1 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;   # R-011: never resolve an unmatched arg
  esac
  shift
done

if [ "${LIST}" = 1 ]; then
  printf 'subject parser : %s\n' "${CORE_REL}"
printf 'subject CLI    : %s\n' "${MJS_REL}"
  printf 'guards attacked (denominator %s, DERIVED from gate-registry.json):\n' "${GUARD_N}"
  printf '%s\n' "${GUARDS}" | sed 's/^/  - /'
  exit 0
fi

[ -f "${MJS}" ]  || { printf 'M2: subject absent: %s\n' "${MJS_REL}" >&2; exit 2; }
[ -f "${CORE}" ] || { printf 'M2: subject absent: %s\n' "${CORE_REL}" >&2; exit 2; }
# ⛔ THE RESTORE PATH MUST EXIST BEFORE THE PLANT DOES. Restoration is `git checkout --`, which
# CANNOT restore an untracked file — so planting in one leaves the defect in the tree and the
# only signal is a sha mismatch after the damage. Measured here on this script's first run
# against the new core, before it was committed. Refuse up front instead (M2, CR-67: a
# successful plant is not a receipt that it can be undone).
for _subject in "${CORE_REL}" "${MJS_REL}"; do
  if ! git -C "${REPO}" ls-files --error-unmatch "${_subject}" >/dev/null 2>&1; then
    printf 'M2: %s is NOT TRACKED — git checkout could not restore it, so refusing to plant.\n' \
      "${_subject}" >&2
    exit 2
  fi
done

SHA_BEFORE="$(shasum -a 256 "${CORE}" | awk '{print $1}')"

restore_subject() {
  git -C "${REPO}" checkout -- "${CORE_REL}"
  local now; now="$(shasum -a 256 "${CORE}" | awk '{print $1}')"
  if [ "${now}" = "${SHA_BEFORE}" ]; then
    printf 'RESTORE : byte-identical (%s)\n' "${SHA_BEFORE:0:12}"
  else
    printf 'RESTORE : ⛔ MISMATCH — before=%s after=%s\n' "${SHA_BEFORE:0:12}" "${now:0:12}" >&2
  fi
}
trap restore_subject EXIT

# ── run the guard the way production runs it (M3), three-valued ──────────────────────────
# A suite that never STARTED prints no `Tests` summary line. Scoring that as RED is how a
# startup error gets counted as a working gate, so it is its own verdict.
run_guard() {
  # SC2155: declare then assign, so `basename`'s exit status is the command's own rather
  # than `local`'s (which is always 0). A failing basename would otherwise leave
  # log="${OUT}/.log" silently, and every guard in this sweep would append to one shared
  # file while still reporting per-guard verdicts.
  local rel="$1" rc log
  log="${OUT}/$(basename "$1").log"
  # The did-it-run verdict and the summary come from scripts/lib/vitest-verdict.sh, which forces
  # colour OFF and strips ANSI. The `grep -qE '^ *Tests +[0-9]'` that used to be here was
  # ANSI-BLIND, so under CI's coloured output it would have called every run DID-NOT-RUN — the
  # brick that put a REQUIRED check red for ten consecutive runs in a sibling harness.
  vv_run "${REPO}/website" "${log}" "${rel}"
  rc=$?
  if [ "${rc}" -eq 2 ]; then
    printf '  %-40s DID-NOT-RUN (unmeasured)\n' "$(basename "${rel}")"
    tail -4 "${log}" | sed 's/^/      | /'
    return 2
  fi
  printf '  %-40s exit=%s  %s\n' "$(basename "${rel}")" "${rc}" "$(vv_summary "${log}")"
  return "${rc}"
}

printf '=== UNPLANTED baseline ===\n'
node "${MJS}" > "${OUT}/base.txt" 2>&1
printf 'node %s exit=%s\n' "${MJS_REL}" "$?"
grep -E 'REVERSE COVERAGE' "${OUT}/base.txt" | sed 's/^/  base | /'
BASE_N="$(sed -n 's/.*REVERSE COVERAGE PASS: all \([0-9]*\) push-triggered.*/\1/p' "${OUT}/base.txt")"
case "${BASE_N}" in
  ''|*[!0-9]*) printf 'M2: could not read the baseline denominator — refusing to judge\n' >&2; exit 2 ;;
esac
[ "${BASE_N}" -gt 0 ] || { printf 'M1: baseline denominator is 0 — the corpus is already empty\n' >&2; exit 2; }
printf 'baseline push-triggered contexts : %s\n' "${BASE_N}"

if [ "${DRY_RUN}" = 1 ]; then printf '\n--dry-run: would plant and stop here.\n'; exit 0; fi

# ── CR-72's other half: the gate must OPEN on a genuine pass. A guard that is always red is a
# brick, and a brick gets disabled — after which nothing is enforced. Run the derived set on the
# CLEAN tree and require every one of them green BEFORE planting anything.
printf '\n=== does the gate OPEN on a clean tree? ===\n'
OPEN_FAIL=0
while IFS= read -r g; do
  [ -n "${g}" ] || continue
  run_guard "${g}" || OPEN_FAIL=$((OPEN_FAIL+1))
done <<< "${GUARDS}"
if [ "${OPEN_FAIL}" -gt 0 ]; then
  printf 'BRICK: %s of %s guards are RED on an UNPLANTED tree — this run cannot attribute a red\n' \
    "${OPEN_FAIL}" "${GUARD_N}" >&2
  printf 'to the plant, and a permanently-red gate gets switched off.\n' >&2
  exit 2
fi
printf 'all %s guards GREEN unplanted.\n' "${GUARD_N}"

printf '\n=== PLANT: block-form push detection in %s isPushTriggered ===\n' "${CORE_REL}"
perl -0pi -e 's{if \(/\^  push:/\.test\(lines\[j\]\)\) return true}{if (/^  pushX:/.test(lines[j])) return true}' "${CORE}"
grep -q 'pushX' "${CORE}" || { printf 'M2: PLANT NOT APPLIED — anchor moved; refusing to judge\n' >&2; exit 2; }
printf 'plant applied.\n'

node "${MJS}" > "${OUT}/planted.txt" 2>&1
printf 'node %s exit=%s\n' "${MJS_REL}" "$?"
grep -E 'REVERSE COVERAGE|Ruleset Drift Guard' "${OUT}/planted.txt" | sed 's/^/  planted | /'
PLANT_N="$(sed -n 's/.*REVERSE COVERAGE PASS: all \([0-9]*\) push-triggered.*/\1/p' "${OUT}/planted.txt")"

printf '\n=== do the guards that police this file go RED? ===\n'
RED=0; UNMEASURED=0; TOTAL=0
while IFS= read -r g; do
  [ -n "${g}" ] || continue
  TOTAL=$((TOTAL+1))
  run_guard "${g}"; rc=$?
  if [ "${rc}" = 2 ] && ! vv_ran "${OUT}/$(basename "${g}").log"; then
    UNMEASURED=$((UNMEASURED+1))
  elif [ "${rc}" != 0 ]; then
    RED=$((RED+1))
  fi
done <<< "${GUARDS}"

printf '\n=== VERDICT ===\n'
printf 'guards attacked : %s   RED: %s   UNMEASURED: %s\n' "${TOTAL}" "${RED}" "${UNMEASURED}"
printf 'reverse-coverage denominator : %s -> %s\n' "${BASE_N}" "${PLANT_N:-<absent>}"
if [ "${UNMEASURED}" -gt 0 ]; then
  printf 'UNMEASURED — a guard never executed; this run proves nothing.\n' >&2
  exit 2
fi
if [ "${RED}" -gt 0 ]; then
  printf 'PASS — the plant was detected. The parity guard reads the parser it polices.\n'
  exit 0
fi
printf 'FAIL — BLIND. The production parser was neutered (%s -> %s push-triggered contexts)\n' \
  "${BASE_N}" "${PLANT_N:-0}" >&2
printf 'and every guard that claims to police it stayed GREEN.\n' >&2
exit 1

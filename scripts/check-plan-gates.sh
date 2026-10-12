#!/usr/bin/env bash
# check-plan-gates — run EVERY gate this repo adjudicates plan documents with.
#
# WHY THIS EXISTS (retro law, occurrence #2 — the mechanism, not another memory).
# 2026-09-20, one session, twice:
#   1. Three /massu-plan audit passes ran over a new plan while `massu-pattern-scanner.sh`
#      (Check 41 -> massu-claim-ledger.mjs) was RED on it. The plan was uncommittable the
#      whole time and nobody ran the gate. CLAUDE.md lists VR-PATTERN as mandatory.
#   2. Two passes later, `npm test` failed on plan-status-drift-guard: the same plan was
#      missing `**Plan Token**:`. 124 of 125 plans passed; the new one was the violation.
#      Again: an existing gate, never run directly.
#
# A red gate you never invoke is indistinguishable from a green one — it emits nothing
# either way. The defect was never in a gate; it was in the ENUMERATION of gates, which
# lived only in someone's memory. Memory is not a control, so this is the command.
#
# M1 denominator reported. M2 fails closed. Closed verdict vocabulary (G3).
# G29: never inherit a caller's git environment.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "check-plan-gates: cannot cd to repo root" >&2; exit 2; }

# ⛔ CYCLE BREAKER — a runner that can invoke an arbitrary discovered script can invoke
# ITSELF, and that is not hypothetical: 2026-09-20 this script and its own live-fire
# harness spawned 69 mutually-recursive processes in ~25 minutes (see the header note).
# The header-block predicate below closes the text collision that caused THAT instance;
# this closes the CLASS, for any future path into a cycle. Independent, because a
# predicate is a judgement and this file's own history has four wrong predicates in it.
if [ "${MASSU_PLAN_GATE_RUNNING:-0}" = "1" ]; then
  echo "check-plan-gates: BLOCKED — re-entered from inside a gate run." >&2
  echo "        A discovered gate invoked this runner, which would recurse without bound." >&2
  echo "        Offending run: \$0=$0  plan=${1:-<none>}" >&2
  exit 2
fi
export MASSU_PLAN_GATE_RUNNING=1

LIST_ONLY=0
PLAN=""
for arg in "$@"; do
  case "$arg" in
    --list|--dry-run) LIST_ONLY=1 ;;
    -*) echo "check-plan-gates: unknown flag '$arg'" >&2; exit 2 ;;
    *)  [ -n "$PLAN" ] && { echo "check-plan-gates: more than one plan given" >&2; exit 2; }
        PLAN="$arg" ;;
  esac
done

if [ -z "$PLAN" ] && [ "$LIST_ONLY" -eq 0 ]; then
  echo "usage: check-plan-gates.sh [--list|--dry-run] <plan.md>" >&2
  echo "  runs every plan-adjudicating gate in this repo against that plan" >&2
  echo "  --list / --dry-run: print the DISCOVERED roster and exit, running nothing." >&2
  echo "     Discovery and execution are separable on purpose: attacking the discovery" >&2
  echo "     must not cost a full corpus scan per probe (G31 — the fast loop)." >&2
  exit 2
fi
[ -z "$PLAN" ] || [ -f "$PLAN" ] || { echo "check-plan-gates: plan not found: $PLAN" >&2; exit 2; }

# ⛔ THE ROSTER IS DISCOVERED, NOT TYPED (G32 — no hand-maintained lists).
#
# The first draft of this script carried a five-row GATES=() literal. That is the SAME
# defect it was written to end, one level down: the header above says "the defect was never
# in a gate; it was in the ENUMERATION of gates, which lived only in someone's memory" — and
# a literal in one file is just a second place to forget. A sixth gate would have been
# invisible here until somebody remembered to add a row, which is precisely how #1 and #2
# happened.
#
# So each gate DECLARES ITSELF, on one line, next to its own shebang:
#
#     # massu-plan-gate: <scope> | <label>          (.sh)
#     // massu-plan-gate: <scope> | <label>         (.mjs)
#
# scope ∈ {corpus, plan}: a corpus gate takes no argument, a plan gate takes the plan path.
# The RUNNER is derived from the extension, never declared — one less thing to get wrong.
# A new gate is therefore covered on its FIRST COMMIT rather than when someone remembers.
#
# ⚠️ `--cached --others --exclude-standard`, NOT a bare `git ls-files`. MEASURED: the first
# draft used the bare form, and the two newest gates were UNTRACKED at that moment — so
# discovery returned 3 where the roster it replaced had 5, and printed
# "RESULT: all 3 plan gates PASS". A shrunken candidate set reporting green is the exact
# defect this script exists to end (G18 — the candidate set IS the gate), and the moment a
# brand-new gate is most likely to be run is before it has ever been committed.
# `--exclude-standard` keeps .gitignore authoritative so node_modules/ stays out.
#
# `grep -l` here is the SESSION-SHELL grep hazard's opposite case (G9): these are tracked
# files inside the repo, nothing is .gitignored, and the candidate set comes from
# `git ls-files` rather than a recursive walk — so the answer does not depend on which grep
# is on PATH. Piped through `LC_ALL=C sort` so the order is FORCED and the output is
# reproducible evidence rather than a coin flip.
GATES=()
while IFS= read -r script; do
  [ -n "$script" ] || continue
  # ⛔ THE DECLARATION MUST LIVE IN THE FILE'S OWN HEADER BLOCK — the contiguous run of
  # comment/blank lines after the shebang, ending at the first line of actual code.
  #
  # "the file contains this marker ANYWHERE" is a CORRELATE of "this file declares itself
  # a gate", not the property (G28), and the difference is not academic: a HARNESS that
  # attacks this discovery must contain the marker text — inside a heredoc, a fixture
  # string, a test plant. On 2026-09-20 exactly that happened. The live-fire written to
  # attack this script carried
  #       <marker> corpus | live-fire planted gate
  # at column 0 inside a heredoc that WRITES a planted gate. Discovery matched it, ran the
  # harness, the harness ran discovery, and 69 mutually-recursive processes accumulated
  # over ~25 minutes before anyone noticed — the output was buffered, so it read as "slow".
  #
  # THIS IS G25 IN A NEW MEDIUM: "a test payload must be INERT UNDER EVERY PLANT." There the
  # payload was `rm -rf ~` becoming live when `shell: true` was planted; here it is a marker
  # string that is live to a grep. Obfuscating the string in the harness would have "fixed"
  # the instance and left the class: the next harness author writes it plainly, because
  # writing it plainly is the readable thing to do. Discipline is not a control.
  #
  # Scoping to the header block makes the collision IMPOSSIBLE rather than detectable: a
  # marker in a heredoc, a string literal, a fixture, a test plant, or prose halfway down a
  # file is not in the header block and is therefore not a declaration — for every file,
  # every language, forever, with nothing for an author to remember.
  header="$(awk '
    NR == 1 && /^#!/       { next }                 # the shebang is not the header
    /^[[:space:]]*$/       { next }                 # blank lines do not end it
    /^[[:space:]]*(#|\/\/)/ { print; next }         # a comment line: still the header
    { exit }                                        # anything else: code has begun
  ' "$script" 2>/dev/null)"
  decl="$(printf '%s\n' "$header" | grep -m1 -E '^[[:space:]]*(#|//) massu-plan-gate:')" || continue
  [ -n "$decl" ] || continue
  body="${decl#*massu-plan-gate:}"
  scope="$(echo "${body%%|*}" | tr -d '[:space:]')"
  label="$(echo "${body#*|}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  case "$script" in
    *.mjs|*.js) runner="node" ;;
    *.sh)       runner="bash" ;;
    # M2 / G3: a CLOSED vocabulary. An extension with no known runner is an ERROR here,
    # never a quietly dropped row — a skipped gate reports exactly what a passing one does.
    *) echo "check-plan-gates: BLOCKED — no runner for '$script' (closed vocabulary: .sh .mjs .js)" >&2; exit 2 ;;
  esac
  case "$scope" in
    corpus|plan) : ;;
    *) echo "check-plan-gates: BLOCKED — '$script' declares unrecognised scope '$scope' (closed vocabulary: corpus | plan)" >&2; exit 2 ;;
  esac
  [ -n "$label" ] || { echo "check-plan-gates: BLOCKED — '$script' declares no label" >&2; exit 2; }
  GATES+=("$label|$scope|$runner $script")
done <<EOF
$(git ls-files -z --cached --others --exclude-standard -- 'scripts/*' | xargs -0 grep -l -E '^(#|//) massu-plan-gate:' 2>/dev/null | LC_ALL=C sort)
EOF

TOTAL=${#GATES[@]}
# M1/M2: "discovered 0" is a LOUD ERROR, never a pass. A broken discovery and a repo with no
# gates return the same value, and it is the passing one.
[ "$TOTAL" -eq 0 ] && { echo "check-plan-gates: DENOMINATOR 0 — discovery found no '# massu-plan-gate:' declarations under scripts/. Failing closed." >&2; exit 2; }

# --list / --dry-run: report what WOULD run and stop. Discovery is the thing most worth
# attacking and the cheapest thing to attack; coupling it to a full corpus execution is what
# turned a 2-second defect into a 25-minute one (G31 — iterate on the cheap tier).
if [ "$LIST_ONLY" -eq 1 ]; then
  echo "GATES REGISTERED (denominator): $TOTAL"
  echo "----"
  for row in "${GATES[@]}"; do
    label="${row%%|*}"; rest="${row#*|}"
    scope="${rest%%|*}"; cmd="${rest#*|}"
    printf '  %-46s %-7s %s\n' "$label" "$scope" "$cmd"
  done
  echo "----"
  echo "RESULT: listed $TOTAL plan gate(s); nothing was executed"
  exit 0
fi

PASS=0; FAIL=0; MISSING=0
FAILED_LABELS=()
echo "PLAN: $PLAN"
echo "GATES REGISTERED (denominator): $TOTAL"
echo "----"
for row in "${GATES[@]}"; do
  label="${row%%|*}"; rest="${row#*|}"
  scope="${rest%%|*}"; cmd="${rest#*|}"
  # M2: a gate whose script is absent is an ERROR, never a silent skip.
  script="$(echo "$cmd" | awk '{print $2}')"
  if [ ! -f "$script" ]; then
    printf '  %-46s MISSING (%s)\n' "$label" "$script"
    MISSING=$((MISSING+1)); FAILED_LABELS+=("$label (script absent)"); continue
  fi
  if [ "$scope" = "plan" ]; then out="$($cmd "$PLAN" --quiet 2>&1)"; else out="$($cmd 2>&1)"; fi
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  %-46s PASS\n' "$label"; PASS=$((PASS+1))
  else
    printf '  %-46s FAIL (exit %s)\n' "$label" "$rc"
    echo "$out" | tail -4 | sed 's/^/        /'
    FAIL=$((FAIL+1)); FAILED_LABELS+=("$label")
  fi
done
echo "----"
echo "PASS: $PASS   FAIL: $FAIL   MISSING: $MISSING   (of $TOTAL)"
if [ "$FAIL" -gt 0 ] || [ "$MISSING" -gt 0 ]; then
  echo "RED gates:"; printf '  - %s\n' "${FAILED_LABELS[@]}"
  exit 1
fi
echo "RESULT: all $TOTAL plan gates PASS"

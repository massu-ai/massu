#!/usr/bin/env bash
# massu-incident-coverage.sh — CR-62 enforcement.
#
# THE BUG CLASS THIS CLOSES
# -------------------------
# Massu's incident pipeline was keyed on THE HUMAN COMPLAINING:
#   - .claude/settings.json:234 — the `[INCIDENT DETECTED]` UserPromptSubmit hook
#     fires on a REGEX OVER THE USER'S PROMPT ("you missed", "still broken", ...).
#   - .claude/settings.json:171 -> scripts/hooks/auto-ingest-incident.sh — a
#     PostToolUse hook that exits immediately unless the edited file already IS
#     INCIDENT-LOG.md. It ingests an incident someone already wrote; it does not
#     cause one to be written.
#
# So a defect found by Massu's OWN audit produced no incident, no memory entry and
# no rule — it was fixed and forgotten. On 2026-07-12 a single plan audit found
# FIVE silent data-loss defects in the memory subsystem; none would have been
# recorded. For a governance product that is exactly backwards: the defects the
# machine catches itself have the best evidence and the freshest context.
#
# THE RULE (CR-62): a fix that closes a silent-failure / data-loss class must ship
# an incident doc, a drift-guard, and a memory entry — in the same push.
#
# WHAT THIS SCRIPT CHECKS (the mechanical half)
#   For every commit in the push range whose subject starts with `fix(` or `fix:`
#   AND which touches non-test source (packages/*/src/, website/src/, scripts/,
#   .claude/hooks/), that commit must be LINKED to an incident doc by either:
#     (a) CONTAINMENT — the commit itself carries a docs/incidents/*.md, or
#     (b) CITATION    — a commit in the range carries a docs/incidents/*.md and
#                       names this commit's sha in its message.
#
#   It used to be enough for an incident doc to exist ANYWHERE in the range. That
#   is range-existence, not coverage, and it returned PASS on 2026-08-08 for a real
#   unrecorded fix because an UNRELATED incident sat in the same push. See
#   docs/incidents/2026-08-09-incident-coverage-discharged-on-range-existence.md.
#   Range-existence survives only as a FORWARD-ONLY fallback for commits authored
#   before MASSU_INCIDENT_LINKAGE_FROM, and that fallback is counted and printed.
#
# Bypass: MASSU_SKIP_INCIDENT_COVERAGE=1 (explicit + logged, never silent).
#
# Usage:  bash scripts/massu-incident-coverage.sh [<base>..<head>]
#         (defaults to origin/<branch>..HEAD, or the last commit on a fresh branch)
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo"; exit 0; }
cd "$REPO_ROOT" || exit 0

if [[ "${MASSU_SKIP_INCIDENT_COVERAGE:-0}" == "1" ]]; then
  echo -e "${YELLOW}SKIP: Incident coverage (CR-62) bypassed via MASSU_SKIP_INCIDENT_COVERAGE=1${NC}"
  echo "$(date -u +%FT%TZ) MASSU_SKIP_INCIDENT_COVERAGE=1 by ${USER:-unknown} on $(git rev-parse --short HEAD)" \
    >> "$REPO_ROOT/.massu-incident-coverage-bypass.log" 2>/dev/null || true
  exit 0
fi

# --- Resolve the push range -------------------------------------------------
RANGE="${1:-}"
if [[ -z "$RANGE" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
    RANGE="origin/$BRANCH..HEAD"
  else
    RANGE="HEAD~1..HEAD"
  fi
fi

COMMITS="$(git rev-list "$RANGE" 2>/dev/null)"
if [[ -z "$COMMITS" ]]; then
  echo -e "${GREEN}PASS${NC}: Incident coverage (CR-62) — no commits in range ($RANGE)"
  exit 0
fi

# ── DISCHARGE: LINKAGE, NOT RANGE-EXISTENCE (2026-08-09) ────────────────────
#
# This block used to be one line:
#     INCIDENT_DOCS="$(git diff --name-only "$RANGE" -- 'docs/incidents/*.md')"
# computed ONCE over the whole range and then tested identically for every fix
# commit in it. That is RANGE-EXISTENCE: *any* incident doc anywhere in the push
# discharged *every* fix commit in the push, related or not.
#
# Proven live on 2026-08-08: the gate returned PASS for a push containing
# `807f05eb fix(hooks): emit hookSpecificOutput.additionalContext` — a substantive
# fix with no record of its own — because an UNRELATED incident about a stale
# public mirror happened to sit in the same range.
#
# A fix commit is now discharged by EITHER of two pure path/string tests. Neither
# makes a relevance judgement; a semantic test is unjudgeable by a machine and
# would fire on compliant work.
#
#   (a) CONTAINMENT — the commit itself carries a docs/incidents/*.md.
#   (b) CITATION    — some commit in the range carries a docs/incidents/*.md AND
#                     names this commit's sha in its message.
#
# (b) exists because this repo's CORRECT workflow is fix-then-incident: measured
# over the last 60 obligated fix commits, 17 of 23 (74%) carry their incident in a
# SEPARATE commit. Requiring containment alone would go RED on 74% of compliant
# work, and a gate that fires on compliant work gets disabled (CR-72). (b) also
# preserves the legitimate cluster case — one incident commit may cite several fix
# shas, as the 2026-07-12 memory cluster did.
#
# FORWARD-ONLY RATCHET. Measured: of the last 120 commits carrying an incident doc,
# only 20 of 32 (63%) cite a sha. Enforcing linkage retroactively would therefore be
# the same brick by a different route. Commits authored BEFORE the ratchet epoch keep
# the historical range-existence behaviour; commits at or after it must link.
LINKAGE_RATCHET_EPOCH="${MASSU_INCIDENT_LINKAGE_FROM:-1786312583}"   # 2026-08-09T21:56:23Z

# Range-existence, retained ONLY for pre-ratchet commits.
INCIDENT_DOCS="$(git diff --name-only "$RANGE" -- 'docs/incidents/*.md' 2>/dev/null)"

# Every sha cited by a range commit that actually carries an incident doc.
# FAIL-CLOSED: if nothing in the range carries an incident doc this is empty, so
# (b) discharges nothing — the absence of evidence cannot become a pass.
CITED_SHAS=""
for c in $COMMITS; do
  # CAPTURE, then match with a here-string. `git show ... | grep -q` is a broken-pipe
  # race under `set -o pipefail`: grep -q exits at the first match, git takes SIGPIPE,
  # and the pipeline returns 141 — so a commit that DOES carry an incident reads as one
  # that does not. Caught by gate-script-grep-q-pipeline-drift-guard (incident 2026-07-16).
  C_FILES="$(git show --name-only --format= "$c" 2>/dev/null || true)"
  if grep -qE '^docs/incidents/.+\.md$' <<< "$C_FILES"; then
    CITED_SHAS="${CITED_SHAS}$(git log -1 --format='%B' "$c" 2>/dev/null \
      | grep -oE '\b[0-9a-f]{7,40}\b' || true)
"
  fi
done

# Is $1 (a full 40-char sha) named by any cited token? A citation may use any
# abbreviation length, so match by PREFIX rather than by a fixed short form.
cites_commit() {
  local full="$1" tok
  [[ -n "$CITED_SHAS" ]] || return 1
  while IFS= read -r tok; do
    [[ -n "$tok" ]] || continue
    [[ "$full" == "$tok"* ]] && return 0
  done <<< "$CITED_SHAS"
  return 1
}

OFFENDERS=()
# M1 — PROVE IT LOOKED. A gate that prints only a verdict cannot be audited, and
# this one printed PASS for months over a predicate that could not bind.
N_COMMITS=0; N_OBLIGATED=0; N_CONTAINED=0; N_CITED=0; N_LEGACY=0
for sha in $COMMITS; do
  N_COMMITS=$((N_COMMITS + 1))
  SUBJECT="$(git log -1 --format=%s "$sha")"
  # Only conventional `fix` commits. feat/docs/chore/refactor are not bug fixes.
  [[ "$SUBJECT" =~ ^fix(\(.*\))?!?: ]] || continue

  # Did it touch real (non-test) code?
  #
  # SCOPE — widened 2026-07-24 to include the ENFORCEMENT LAYER.
  # This regex used to be product source only:
  #     ^(packages/[^/]+/src/|website/src/)
  # On 2026-07-24 eight real defects were found and fixed — a pre-push gate whose
  # predicate could never be true, a sync script that exited 1 after succeeding, an
  # installer that wired the PUBLIC leak guard into the private repo, a scanner that
  # reported CLEAN when git failed — and this gate printed PASS on all six pushes.
  # Not because coverage existed: 0 of the 33 changed files matched the regex,
  # because every one of them lived in scripts/.
  #
  # A rule whose text is "a bug the MACHINE finds must produce the same artifacts as
  # a bug the HUMAN reports" cannot exclude the machinery from being code. The gate
  # layer is where gate bugs are, and gate bugs are the ones that make every OTHER
  # gate untrustworthy — so they are the LAST thing that should be exempt.
  #
  # Incident: docs/incidents/2026-07-24-incident-pipeline-blind-to-the-gate-layer.md
  # Drift-guard: packages/core/src/__tests__/incident-coverage-scope.test.ts
  SRC_TOUCHED="$(git show --name-only --format= "$sha" \
    | grep -E '^(packages/[^/]+/src/|website/src/|scripts/|\.claude/hooks/)' \
    | grep -vE '(__tests__/|\.test\.|\.spec\.|^scripts/tests/)' || true)"
  [[ -n "$SRC_TOUCHED" ]] || continue
  N_OBLIGATED=$((N_OBLIGATED + 1))

  # (a) CONTAINMENT — the commit carries its own incident doc.
  SHA_FILES="$(git show --name-only --format= "$sha" 2>/dev/null || true)"
  if grep -qE '^docs/incidents/.+\.md$' <<< "$SHA_FILES"; then
    N_CONTAINED=$((N_CONTAINED + 1))
    continue
  fi

  # (b) CITATION — an incident-bearing commit in the range names this sha.
  if cites_commit "$sha"; then
    N_CITED=$((N_CITED + 1))
    continue
  fi

  # FORWARD-ONLY RATCHET: a pre-ratchet commit keeps the historical, weaker
  # range-existence discharge. Counted separately so the exemption is VISIBLE and
  # can be watched shrink to zero, rather than being an invisible carve-out (G18).
  COMMIT_EPOCH="$(git log -1 --format=%ct "$sha" 2>/dev/null || echo 0)"
  if [[ "$COMMIT_EPOCH" -lt "$LINKAGE_RATCHET_EPOCH" ]]; then
    if [[ -n "$INCIDENT_DOCS" ]]; then
      N_LEGACY=$((N_LEGACY + 1))
      continue
    fi
  fi

  OFFENDERS+=("$(git log -1 --format='%h %s' "$sha")")
done

echo "  scanned $N_COMMITS commit(s) in $RANGE; $N_OBLIGATED obligated"
echo "  discharged: containment $N_CONTAINED · citation $N_CITED · pre-ratchet range-existence $N_LEGACY"

if [[ ${#OFFENDERS[@]} -gt 0 ]]; then
  echo -e "${RED}FAIL${NC}: Incident coverage (CR-62)"
  echo ""
  echo "  These fix commits change real source and are LINKED to no incident doc:"
  for o in "${OFFENDERS[@]}"; do echo "    - $o"; done
  echo ""
  echo "  A fix is discharged by EITHER of two checks — both are pure path/string"
  echo "  tests, so neither judges whether the incident is a GOOD one:"
  echo "    (a) CONTAINMENT — the fix commit itself carries a docs/incidents/*.md"
  echo "    (b) CITATION    — a commit in this range carries a docs/incidents/*.md"
  echo "                      AND names the fix's sha in its message, e.g."
  echo "                        docs(incident): CR-62 artifacts for <sha>"
  echo ""
  echo "  An incident doc merely PRESENT in the range no longer discharges anything."
  echo "  That is what let 807f05eb through on 2026-08-08: an unrelated incident about"
  echo "  a stale public mirror sat in the same push and satisfied the whole batch."
  echo ""
  echo "  A bug the MACHINE finds must produce the same artifacts as a bug the HUMAN"
  echo "  reports. A fix without a record is a lesson that dies with the session — and"
  echo "  the same class of bug comes back."
  echo ""
  echo "  Ship, in this push:"
  echo "    (a) docs/incidents/<YYYY-MM-DD>-<slug>.md  — what broke, the ROOT CAUSE,"
  echo "        the evidence (file:line / pasted output), and the prevention"
  echo "    (b) a drift-guard test that FAILS if the bug returns"
  echo "    (c) a memory entry so the lesson outlives this session"
  echo ""
  echo "  Run /massu-incident to scaffold it."
  echo "  Deliberate exception: MASSU_SKIP_INCIDENT_COVERAGE=1 (explicit + logged)."
  exit 1
fi

echo -e "${GREEN}PASS${NC}: Incident coverage (CR-62)"
exit 0

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
#   AND which touches non-test source under packages/ or website/src/, there must
#   be at least one docs/incidents/*.md added or modified in the SAME range.
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

# Incident docs touched anywhere in the range satisfy every fix commit in it:
# one incident may legitimately cover a cluster of related defects (as the
# 2026-07-12 memory cluster did).
INCIDENT_DOCS="$(git diff --name-only "$RANGE" -- 'docs/incidents/*.md' 2>/dev/null)"

OFFENDERS=()
for sha in $COMMITS; do
  SUBJECT="$(git log -1 --format=%s "$sha")"
  # Only conventional `fix` commits. feat/docs/chore/refactor are not bug fixes.
  [[ "$SUBJECT" =~ ^fix(\(.*\))?!?: ]] || continue

  # Did it touch real (non-test) product source?
  SRC_TOUCHED="$(git show --name-only --format= "$sha" \
    | grep -E '^(packages/[^/]+/src/|website/src/)' \
    | grep -vE '(__tests__/|\.test\.|\.spec\.)' || true)"
  [[ -n "$SRC_TOUCHED" ]] || continue

  if [[ -z "$INCIDENT_DOCS" ]]; then
    OFFENDERS+=("$(git log -1 --format='%h %s' "$sha")")
  fi
done

if [[ ${#OFFENDERS[@]} -gt 0 ]]; then
  echo -e "${RED}FAIL${NC}: Incident coverage (CR-62)"
  echo ""
  echo "  These fix commits change product source but ship NO incident doc:"
  for o in "${OFFENDERS[@]}"; do echo "    - $o"; done
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

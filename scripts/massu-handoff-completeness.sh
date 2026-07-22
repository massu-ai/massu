#!/usr/bin/env bash
#
# massu-handoff-completeness.sh — the HANDOFF COMPLETENESS gate (VR-HANDOFF / CR-68).
#
# THE RULE (operator directive 2026-07-21): a session handoff must be TURN-KEY. Never
# hand back an "Operator TODO" bullet list without, for EVERY piece of remaining work,
# the exact vehicle (/massu-golden-path, /massu-loop, /massu-deploy, or MANUAL), the
# explicit ordered steps, the STOP/gate points, and the acceptance criteria. An
# incomplete handoff forces the next session (or the operator) to re-derive the plan —
# the exact waste this gate exists to make impossible.
#
# THE CONTRACT — every `.claude/session-state/{RECAP,HANDOFF}-*.md` MUST contain a
# section headed exactly `## Next-Session Runbook`. Inside it, either:
#   - the sentinel line `_No open work_` (a genuinely final recap), OR
#   - one or more `### <item>` blocks, and EVERY such block MUST carry all four labels:
#         - **Vehicle**:      (/massu-golden-path <plan> | /massu-loop <plan> |
#                              /massu-deploy | MANUAL (operator))
#         - **Steps**:        (ordered, explicit commands)
#         - **Stop**:         (where to pause / the gate for the operator)
#         - **Acceptance**:   (how to know it is done)
#
# Fail-closed: an unreadable file or a missing section is a FAIL, never a silent pass.
#
# Exit 0 = PASS. Exit 1 = FAIL (incomplete handoff). Exit 2 = usage error.
#
# Usage:
#   bash scripts/massu-handoff-completeness.sh            # scan all handoff docs
#   bash scripts/massu-handoff-completeness.sh <file>...  # check specific files
#   bash scripts/massu-handoff-completeness.sh --self-test # prove the gate opens+closes

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_ROOT/.claude/session-state"
RUNBOOK_HEADING='## Next-Session Runbook'
REQUIRED_LABELS=("**Vehicle**" "**Steps**" "**Stop**" "**Acceptance**")

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

# Validate ONE file. Echoes violations to stdout; returns 0 = ok, 1 = violation.
check_file() {
  local f="$1"
  if [ ! -r "$f" ]; then
    echo "${RED}FAIL${NC}: $f — unreadable (fail-closed; a handoff we cannot read is not complete)"
    return 1
  fi

  # 1. The runbook section must exist.
  if ! grep -qF "$RUNBOOK_HEADING" "$f"; then
    echo "${RED}FAIL${NC}: $(basename "$f") — missing the required '${RUNBOOK_HEADING}' section."
    echo "        Every handoff must spell out the next steps. See .claude/templates/handoff-runbook.md"
    return 1
  fi

  # 2. Parse the runbook section and validate each ### item block. awk emits one line
  #    per problem: either "NOITEMS" (section has neither items nor the no-work sentinel)
  #    or "INCOMPLETE:<item>:<missing-labels>".
  local problems
  problems="$(awk -v heading="$RUNBOOK_HEADING" '
    function flush(   miss, i) {
      if (!in_item) return
      miss = ""
      # order: Vehicle, Steps, Stop, Acceptance
      if (!seen_vehicle)    miss = miss (miss?",":"") "**Vehicle**"
      if (!seen_steps)      miss = miss (miss?",":"") "**Steps**"
      if (!seen_stop)       miss = miss (miss?",":"") "**Stop**"
      if (!seen_acceptance) miss = miss (miss?",":"") "**Acceptance**"
      if (miss != "") print "INCOMPLETE:" item ":" miss
      in_item = 0
    }
    # Enter the runbook section.
    index($0, heading) == 1 { in_section = 1; next }
    # A new top-level ## heading ends the section.
    in_section && /^## / { flush(); in_section = 0 }
    !in_section { next }
    # Sentinel: an explicitly final recap.
    /_No open work_/ { has_sentinel = 1 }
    # An item block starts at ### .
    /^### / {
      flush()
      item = $0; sub(/^### +/, "", item)
      in_item = 1; item_count++
      seen_vehicle = seen_steps = seen_stop = seen_acceptance = 0
      next
    }
    in_item {
      if (index($0, "**Vehicle**"))    seen_vehicle = 1
      if (index($0, "**Steps**"))      seen_steps = 1
      if (index($0, "**Stop**"))       seen_stop = 1
      if (index($0, "**Acceptance**")) seen_acceptance = 1
    }
    END {
      flush()
      if (item_count == 0 && !has_sentinel) print "NOITEMS"
    }
  ' "$f")"

  if [ -z "$problems" ]; then
    return 0
  fi

  local rc=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    rc=1
    if [ "$p" = "NOITEMS" ]; then
      echo "${RED}FAIL${NC}: $(basename "$f") — the runbook has no '### <item>' blocks and no '_No open work_' sentinel."
    else
      local item="${p#INCOMPLETE:}"; local miss="${item##*:}"; item="${item%:*}"
      echo "${RED}FAIL${NC}: $(basename "$f") — runbook item '${item}' is missing: ${miss}"
    fi
  done <<< "$problems"
  return $rc
}

self_test() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  local pass=0 total=0

  ok() { total=$((total+1)); if [ "$1" = "$2" ]; then echo "  ${GREEN}PASS${NC}: $3"; pass=$((pass+1)); else echo "  ${RED}FAIL${NC}: $3 (want rc=$2 got rc=$1)"; fi; }

  # A complete handoff PASSES.
  cat > "$tmp/RECAP-complete.md" <<'EOF'
# Recap
## Next-Session Runbook
### WS-X do the thing
- **Vehicle**: /massu-loop docs/plans/x.md
- **Steps**: 1. run the loop  2. verify
- **Stop**: pause at the GO/NO-GO gate for operator
- **Acceptance**: suite green + operator go
EOF
  check_file "$tmp/RECAP-complete.md" >/dev/null 2>&1; ok $? 0 "a complete runbook PASSES"

  # Missing a label FAILS.
  cat > "$tmp/RECAP-missing-label.md" <<'EOF'
# Recap
## Next-Session Runbook
### WS-Y half-specified
- **Vehicle**: /massu-golden-path docs/plans/y.md
- **Steps**: 1. do it
EOF
  check_file "$tmp/RECAP-missing-label.md" >/dev/null 2>&1; ok $? 1 "a block missing **Stop**/**Acceptance** FAILS"

  # No runbook section at all FAILS.
  printf '# Recap\n- Operator TODO: finish WS4 somehow\n' > "$tmp/RECAP-no-section.md"
  check_file "$tmp/RECAP-no-section.md" >/dev/null 2>&1; ok $? 1 "a handoff with no runbook section FAILS"

  # The no-open-work sentinel PASSES.
  printf '# Recap\n## Next-Session Runbook\n_No open work_ — the roadmap is 100%% complete.\n' > "$tmp/RECAP-done.md"
  check_file "$tmp/RECAP-done.md" >/dev/null 2>&1; ok $? 0 "the '_No open work_' sentinel PASSES"

  # Unreadable FAILS (fail-closed).
  check_file "$tmp/does-not-exist.md" >/dev/null 2>&1; ok $? 1 "an unreadable file FAILS (fail-closed)"

  echo "self-test: $pass/$total passed"
  [ "$pass" -eq "$total" ]
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test; exit $?
  fi

  local files=()
  if [ "${1:-}" = "--changed" ]; then
    # Gate only handoffs written/edited in THIS change (vs origin/main + working tree).
    # Frozen historical recaps are grandfathered — the rule binds new handoffs, not the
    # archive. Mirrors the incident-coverage range-scoping.
    local rel
    while IFS= read -r rel; do
      [ -n "$rel" ] && files+=("$REPO_ROOT/$rel")
    done < <(
      { git -C "$REPO_ROOT" diff --name-only origin/main -- '.claude/session-state/RECAP-*.md' '.claude/session-state/HANDOFF-*.md' 2>/dev/null
        git -C "$REPO_ROOT" diff --name-only            -- '.claude/session-state/RECAP-*.md' '.claude/session-state/HANDOFF-*.md' 2>/dev/null
      } | sort -u
    )
    if [ "${#files[@]}" -eq 0 ]; then
      echo "${GREEN}PASS${NC}: no new/changed handoff docs to check."
      exit 0
    fi
  elif [ "$#" -gt 0 ]; then
    files=("$@")
  else
    shopt -s nullglob
    files=("$STATE_DIR"/RECAP-*.md "$STATE_DIR"/HANDOFF-*.md)
    shopt -u nullglob
  fi

  if [ "${#files[@]}" -eq 0 ]; then
    echo "${YELLOW}NOTE${NC}: no handoff docs (RECAP-*.md / HANDOFF-*.md) found — nothing to check."
    exit 0
  fi

  local rc=0 checked=0
  for f in "${files[@]}"; do
    case "$f" in *RECAP-*.md|*HANDOFF-*.md) ;; *) continue ;; esac
    checked=$((checked+1))
    check_file "$f" || rc=1
  done

  if [ "$rc" -eq 0 ]; then
    echo "${GREEN}PASS${NC}: all $checked handoff doc(s) carry a complete Next-Session Runbook."
  else
    echo ""
    echo "A handoff MUST be turn-key: every open item needs **Vehicle** / **Steps** / **Stop** / **Acceptance**."
    echo "Template: .claude/templates/handoff-runbook.md (CR-68 / VR-HANDOFF)."
  fi
  exit $rc
}

main "$@"

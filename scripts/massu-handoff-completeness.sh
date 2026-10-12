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
# THE SINGLE SOURCE OF TRUTH for what a runbook item must carry. Order is the order reported.
# ⛔ IT WAS NOT. Until 2026-09-24 this array was DECLARED AND READ BY NOTHING -- found by the
# SC2034 lint (a line here must not START with the linter's own name, or it is parsed as a
# DIRECTIVE, SC1072/SC1073) -- while the real checking sat in awk with all four names hardcoded
# times each -- so adding a label here changed nothing and a session would believe it had added
# a requirement (G32: a list the code depends on must be DERIVED, and an authoritative-looking
# roster nothing reads is the N+1 shape). The awk below now splits this array on US (0x1f) and
# drives its loop from it; a label added here takes effect immediately, and a run that receives
# ZERO labels is a LOUD ERROR rather than a check every item passes vacuously.
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

  # 3. NO DOCUMENT MAY CLAIM IT WAS WRITTEN IN THE FUTURE (added 2026-09-23).
  #    A SELF-DATING wall-clock line — "**Written**: …", "Last updated: …", "measured …" —
  #    records when THIS document or measurement was made. A claim ahead of the clock was
  #    TYPED, NOT READ, and evidence carrying an invented timestamp is not evidence.
  #    This gate's own handoff shipped `~11:55 PDT` at 10:33 PDT: 82 minutes into its own
  #    future. Retro: the 2026-09-23 self-dating-timestamp incident (massu-internal).
  #    (global CLAUDE.md G33 — every reported time is Pacific; G9 — unordered/unsourced
  #    evidence is decoration; G23 — the last unguarded surface is my own prose).
  #
  #    WHY THIS PREDICATE IS FALSE-POSITIVE-FREE AND CI-SAFE: it compares only against
  #    NOW, never against mtime (a git checkout rewrites every mtime, which would turn
  #    every historical handoff red — a brick gate gets disabled, CR-72). A past claim is
  #    never in the future of now, so the 771-file markdown corpus measured on adoption
  #    yields exactly 0 findings besides the live defect. Reference clocks are taken
  #    PER ZONE so no conversion is performed; fixed-width ISO strings compare
  #    chronologically under a plain lexicographic test.
  local now_pt now_utc ts_rc=0 future
  now_pt="$(TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M')" || now_pt=""
  now_utc="$(date -u '+%Y-%m-%dT%H:%M')" || now_utc=""
  if [ -z "$now_pt" ] || [ -z "$now_utc" ]; then
    # M2 fail closed: a check that could not read its reference must never report clean.
    echo "${RED}FAIL${NC}: $(basename "$f") — could not read the reference clock; the"
    echo "        self-dating-timestamp check could not run, which is a FAIL, not a pass."
    ts_rc=1
  else
    future="$(awk -v now_pt="$now_pt" -v now_utc="$now_utc" '
      function chk(stamp, zone, ref) {
        ref = (zone == "UTC") ? now_utc : now_pt
        if (stamp > ref) print "FUTURE:" NR ":" zone ":" stamp ":" ref
      }
      tolower($0) ~ /(written|last updated|last-updated|as of|measured|re-?checked|recorded|captured|generated)/ {
        rest = $0
        d = ""
        # EVERY clock on the line is judged, not just the first: a line carrying two stamps
        # can hide a fabricated one behind an honest one.
        #
        # ⛔ AND EACH TIME IS PAIRED WITH THE DATE THAT PRECEDES *IT*, not with the first date
        # on the line. Pairing every time with the first date made the second stamp unjudgeable
        # whenever the two stamps fell on different DAYS: `**Written**: 2026-09-23 20:33 PDT ·
        # **Last updated**: 2026-09-24 00:33 PDT` composed `2026-09-23T00:33`, which is in the
        # PAST, so a document claiming it was updated tomorrow passed. The self-test of this
        # gate caught it, and only between 22:00 and midnight local time: the fixture builds
        # the fabricated stamp as now+2h, so outside that window both stamps share a date and
        # the bug is invisible. A fixture whose coverage depends on the wall clock is why this
        # survived; the deterministic cross-midnight case is pinned in the self-test below.
        while (1) {
          dstart = 0; dlen = 0
          if (match(rest, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/) > 0) {
            dstart = RSTART; dlen = RLENGTH
          }
          tstart = 0; tlen = 0
          if (match(rest, /[0-9][0-9]?:[0-9][0-9] *(PDT|PST|UTC)/) > 0) {
            tstart = RSTART; tlen = RLENGTH
          }
          if (dstart == 0 && tstart == 0) break
          if (dstart != 0 && (tstart == 0 || dstart < tstart)) {
            d = substr(rest, dstart, dlen)
            rest = substr(rest, dstart + dlen)
            continue
          }
          t = substr(rest, tstart, tlen)
          rest = substr(rest, tstart + tlen)
          if (d == "") continue   # a clock with no date before it on this line is not a stamp
          zone = (t ~ /UTC/) ? "UTC" : "PT"
          if (match(t, /[0-9][0-9]?:[0-9][0-9]/) == 0) continue
          hm = substr(t, RSTART, RLENGTH)
          if (length(hm) == 4) hm = "0" hm
          chk(d "T" hm, zone)
        }
      }
    ' "$f")"
    if [ -n "$future" ]; then
      ts_rc=1
      while IFS= read -r ln; do
        [ -z "$ln" ] && continue
        local _n _z _stamp _ref
        _n="$(echo "$ln"    | cut -d: -f2)"
        _z="$(echo "$ln"    | cut -d: -f3)"
        _stamp="$(echo "$ln" | cut -d: -f4-5)"
        _ref="$(echo "$ln"   | cut -d: -f6-7)"
        echo "${RED}FAIL${NC}: $(basename "$f"):${_n} — a self-dating timestamp claims ${_stamp} ${_z},"
        echo "        which is AHEAD of the clock (${_ref} ${_z}). That value was typed, not read."
        echo "        Derive it: TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M %Z'"
      done <<< "$future"
    fi
  fi

  # 2. Parse the runbook section and validate each ### item block. awk emits one line
  #    per problem: either "NOITEMS" (section has neither items nor the no-work sentinel)
  #    or "INCOMPLETE:<item>:<missing-labels>".
  local problems
  # M2 BEFORE THE JOIN, and it is not merely belt-and-braces: this is bash 3.2 (macOS), where
  # "${arr[@]}" on an EMPTY array under `set -u` is an unbound-variable error that kills the
  # script mid-run. Count first, so an empty label set reports its own reason instead of dying
  # with a shell diagnostic -- and so the condition is reachable and therefore testable.
  if [ "${#REQUIRED_LABELS[@]}" -eq 0 ]; then
    echo "${RED}FAIL${NC}: $(basename "$f") — REQUIRED_LABELS is empty; refusing to check nothing."
    return 1
  fi
  local labels_joined
  labels_joined="$(printf '%s\037' "${REQUIRED_LABELS[@]}")"; labels_joined="${labels_joined%$'\037'}"
  problems="$(awk -v heading="$RUNBOOK_HEADING" -v labels="$labels_joined" '
    BEGIN {
      n = split(labels, L, "\037")
      # M1/M2: zero labels would make every item pass with nothing checked. Refuse.
      if (n < 1) { print "NOLABELS"; exit }
    }
    function flush(   miss, i) {
      if (!in_item) return
      miss = ""
      for (i = 1; i <= n; i++) if (!seen[i]) miss = miss (miss?",":"") L[i]
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
      for (i = 1; i <= n; i++) seen[i] = 0
      next
    }
    in_item {
      for (i = 1; i <= n; i++) if (index($0, L[i])) seen[i] = 1
    }
    END {
      flush()
      if (item_count == 0 && !has_sentinel) print "NOITEMS"
    }
  ' "$f")"

  if [ -z "$problems" ]; then
    return $ts_rc
  fi

  local rc=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    rc=1
    if [ "$p" = "NOLABELS" ]; then
      # CLOSED VOCABULARY (G3): an unrecognised token must be an ERROR, never a row that falls
      # through to the INCOMPLETE parse and gets reported as a mangled item name. NOLABELS means
      # REQUIRED_LABELS reached awk empty, which would pass every item while checking nothing.
      echo "${RED}FAIL${NC}: $(basename "$f") — the checker received ZERO required labels."
      echo "        REQUIRED_LABELS is empty or did not survive the join; this is a defect in"
      echo "        this script, not in the handoff. Refusing to report a completeness verdict."
    elif [ "$p" = "NOITEMS" ]; then
      echo "${RED}FAIL${NC}: $(basename "$f") — the runbook has no '### <item>' blocks and no '_No open work_' sentinel."
    elif [ "${p#INCOMPLETE:}" != "$p" ]; then
      local item="${p#INCOMPLETE:}"; local miss="${item##*:}"; item="${item%:*}"
      echo "${RED}FAIL${NC}: $(basename "$f") — runbook item '${item}' is missing: ${miss}"
    else
      echo "${RED}FAIL${NC}: $(basename "$f") — unrecognised checker token '${p}'."
      echo "        The vocabulary is NOLABELS | NOITEMS | INCOMPLETE:<item>:<missing>."
    fi
  done <<< "$problems"
  if [ "$ts_rc" -ne 0 ]; then rc=1; fi
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

  # --- check 3: a self-dating timestamp may not be in the future -------------------
  # One fixture per detection path, each demanded to FIRE, plus negative controls that
  # must STAY SILENT. A predicate proven only by its own silence is decoration.
  local _fut_pt _fut_utc _past_pt
  _fut_pt="$(TZ=America/Los_Angeles date -v+2H '+%Y-%m-%d %H:%M PDT' 2>/dev/null || TZ=America/Los_Angeles date -d '+2 hours' '+%Y-%m-%d %H:%M PDT')"
  _fut_utc="$(date -u -v+2H '+%Y-%m-%d %H:%M UTC' 2>/dev/null || date -u -d '+2 hours' '+%Y-%m-%d %H:%M UTC')"
  _past_pt="$(TZ=America/Los_Angeles date -v-2H '+%Y-%m-%d %H:%M PDT' 2>/dev/null || TZ=America/Los_Angeles date -d '-2 hours' '+%Y-%m-%d %H:%M PDT')"

  _runbook() {   # $1 = dest, $2 = the extra line placed above the runbook
    { echo "# Handoff"; echo "$2"; echo "$RUNBOOK_HEADING"; echo "### WS-1 thing";
      echo "- **Vehicle**: MANUAL (operator)"; echo "- **Steps**: 1. do it";
      echo "- **Stop**: operator go"; echo "- **Acceptance**: gate green"; } > "$1"
  }

  _runbook "$tmp/RECAP-future-pt.md" "**Written**: ${_fut_pt}"
  check_file "$tmp/RECAP-future-pt.md" >/dev/null 2>&1; ok $? 1 "a PT self-dating stamp in the FUTURE fails"

  _runbook "$tmp/RECAP-future-utc.md" "**Last updated**: ${_fut_utc}"
  check_file "$tmp/RECAP-future-utc.md" >/dev/null 2>&1; ok $? 1 "a UTC self-dating stamp in the FUTURE fails"

  # Two stamps on ONE line, the second fabricated: proves every clock is judged, not
  # only the first — an honest stamp must not launder a fabricated neighbour.
  _runbook "$tmp/RECAP-second-stamp.md" "**Written**: ${_past_pt} · **Last updated**: ${_fut_pt}"
  check_file "$tmp/RECAP-second-stamp.md" >/dev/null 2>&1; ok $? 1 "a FUTURE second stamp on a line whose first stamp is honest fails"

  # Two stamps on DIFFERENT DATES, the second fabricated. Deterministic: the year is fixed, so
  # this exercises the date-pairing path at every hour of the day. The clock-relative fixture
  # above only reaches it between 22:00 and midnight, which is how the pairing bug survived.
  _runbook "$tmp/RECAP-cross-midnight.md" "**Written**: ${_past_pt} · **Last updated**: 2099-01-01 00:30 PDT"
  check_file "$tmp/RECAP-cross-midnight.md" >/dev/null 2>&1; ok $? 1 "a FUTURE second stamp on a LATER DATE fails (date is paired per-clock)"

  # ⛔ NO CONTROL HERE FOR "a bare clock after an honest stamp". One was written and REMOVED: it
  # asserted that `**Written**: <honest> ... reopens at 23:59 PDT` should stay silent, which would
  # have meant abandoning the assertion directly above it — a second clock on a stamp line is
  # judged ON PURPOSE, because that is exactly where a fabricated stamp hides. The consequence is
  # a known authoring convention rather than an open defect: a SCHEDULED time belongs on a line
  # that carries no stamp keyword (NEGATIVE CONTROL 2 proves such a line stays silent). Verified
  # against the real corpus at the time of this change: zero handoffs trip it.

  # NEGATIVE CONTROL 1: a self-dating stamp in the past is the normal, correct case.
  _runbook "$tmp/RECAP-past-pt.md" "**Written**: ${_past_pt}"
  check_file "$tmp/RECAP-past-pt.md" >/dev/null 2>&1; ok $? 0 "a PT self-dating stamp in the PAST passes"

  # NEGATIVE CONTROL 2: a FUTURE clock that dates a SCHEDULED event, not the document,
  # is legitimate and must stay silent. Without this control the gate would punish
  # every plan that names a future gate time — and a gate that cries wolf gets disabled.
  _runbook "$tmp/RECAP-scheduled.md" "Re-check the soak at ${_fut_pt} and open the gate."
  check_file "$tmp/RECAP-scheduled.md" >/dev/null 2>&1; ok $? 0 "a FUTURE clock with no self-dating keyword stays silent (scheduled event)"

  # ── THE ARRAY IS LOAD-BEARING: prove it, rather than trusting the refactor ─────────────
  # Before 2026-09-24 REQUIRED_LABELS was read by nothing and these three cases would have
  # passed/failed identically with the array set to anything at all (G32, SC2034).
  local _saved_labels=("${REQUIRED_LABELS[@]}") _d_out _d_rc
  REQUIRED_LABELS=("${_saved_labels[@]}" "**Rollback**")
  _d_out="$(check_file "$tmp/RECAP-complete.md" 2>&1)"; _d_rc=$?
  REQUIRED_LABELS=("${_saved_labels[@]}")
  ok $_d_rc 1 "adding a label to REQUIRED_LABELS makes a previously-COMPLETE runbook FAIL"
  case "$_d_out" in
    *'**Rollback**'*) ok 0 0 "...and the failure NAMES the added label" ;;
    *)                ok 1 0 "...and the failure NAMES the added label" ;;
  esac

  REQUIRED_LABELS=()
  _d_out="$(check_file "$tmp/RECAP-complete.md" 2>&1)"; _d_rc=$?
  REQUIRED_LABELS=("${_saved_labels[@]}")
  ok $_d_rc 1 "an EMPTY label set FAILS CLOSED (a vacuous pass would clear every handoff)"
  case "$_d_out" in
    *'refusing to check nothing'*) ok 0 0 "...for its OWN declared reason, not a shell error" ;;
    *)                            ok 1 0 "...for its OWN declared reason, not a shell error" ;;
  esac

  # DRIFT GUARD: the label literals must exist in exactly ONE place -- the array. A future
  # hand-hardcoded copy in the awk is how this defect arose, and grep is what notices.
  local _lit _lit_n _lit_bad=0
  for _lit in Vehicle Steps Stop Acceptance; do
    _lit_n="$(/usr/bin/grep -c "\*\*${_lit}\*\*" "$REPO_ROOT/scripts/massu-handoff-completeness.sh")"
    # 1 in the array + fixtures in this self_test are expected; the AWK program must hold none.
    # Comment lines are PROSE, not a hardcode. G29's amendment, paid for in another repo: a
    # predicate that reads a comment as code cries wolf, and a gate people learn to ignore is
    # worse than none. Strip full-line comments (shell # and awk #) before matching.
    if /usr/bin/sed -n '/^  local labels_joined/,/^  .\ "$f")"/p' "$REPO_ROOT/scripts/massu-handoff-completeness.sh" \
         | /usr/bin/grep -vE '^[[:space:]]*#' \
         | /usr/bin/grep -q "\*\*${_lit}\*\*"; then
      echo "  ${RED}FAIL${NC}: '**${_lit}**' is hardcoded inside the awk program again (${_lit_n} total occurrences)"
      _lit_bad=1
    fi
  done
  ok $_lit_bad 0 "no required-label literal is hardcoded inside the awk program"

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
        # UNTRACKED files. `git diff` NEVER lists them, so without this line a brand-new
        # handoff — the most common case, and the exact file this rule binds — is invisible
        # to `--changed`, and the empty candidate set prints PASS. Measured 2026-08-12: a
        # new handoff returned "PASS: no new/changed handoff docs to check" having examined
        # NOTHING; staged, the identical file failed on three incomplete runbook items.
        # "Could not look" and "looked and found nothing" produced the same green.
        git -C "$REPO_ROOT" ls-files --others --exclude-standard -- '.claude/session-state/RECAP-*.md' '.claude/session-state/HANDOFF-*.md' 2>/dev/null
      } | LC_ALL=C sort -u
    )
    if [ "${#files[@]}" -eq 0 ]; then
      # M1: say WHAT was searched, so a zero denominator is legible as "nothing matched
      # these three sources" rather than as an unqualified pass.
      echo "${GREEN}PASS${NC}: 0 handoff doc(s) to check (searched: committed diff vs origin/main, unstaged edits, untracked)."
      exit 0
    fi
  elif [ "$#" -gt 0 ]; then
    # ⛔ AN UNRECOGNISED FLAG IS A USAGE ERROR, NOT A FILENAME. Without this, `--all` (not a
    # flag this gate has) was accepted as a PATH, filtered out by the RECAP-/HANDOFF- name
    # check below, and the run printed `PASS: all 0 handoff doc(s)` — a gate reporting clean
    # having examined nothing, on a typo. The header already promises `Exit 2 = usage error`.
    # Never resolve an unmatched argument to the most likely candidate (R-011).
    local _a
    for _a in "$@"; do
      case "$_a" in
        -*)
          echo "${RED}FAIL${NC}: unknown option '$_a'." >&2
          echo "usage: $(basename "$0") [--self-test | --changed | <handoff path>...]" >&2
          exit 2
          ;;
      esac
    done
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

  # M1: a candidate list that produced ZERO judgements is a FAILURE, not a pass. The name
  # filter above skips anything that is not RECAP-*.md / HANDOFF-*.md, so a caller who names
  # files that all get skipped would otherwise be told everything is fine.
  if [ "$checked" -eq 0 ]; then
    echo "${RED}FAIL${NC}: ${#files[@]} candidate(s) were supplied and NONE is a handoff doc" >&2
    echo "        (expected RECAP-*.md or HANDOFF-*.md). Nothing was judged, so this is not a pass." >&2
    exit 1
  fi

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

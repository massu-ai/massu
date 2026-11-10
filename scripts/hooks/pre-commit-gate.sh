#!/usr/bin/env bash
# Pre-commit gate hook: runs tsc --noEmit + npm test before git commit
# Triggered by PreToolUse on Bash commands containing "git commit"
# Exit 0 = allow, Exit 2 = block

set -euo pipefail

# Read the command from stdin JSON
COMMAND=$(jq -r '.tool_input.command // empty')

# Only gate on git commit commands
if ! echo "$COMMAND" | grep -qE '^git commit|&& git commit|; git commit'; then
  exit 0
fi

# ⛔ THE GATE MUST JUDGE THE REPOSITORY THE COMMIT LANDS IN (G28). FIXED 2026-09-21.
#
# This read `PROJECT_DIR="${CLAUDE_PROJECT_DIR:-...}"` — the ambient variable FIRST, the
# actual repository second. A Claude Code session's CLAUDE_PROJECT_DIR is wherever the
# session was started, which is not necessarily where a `cd <repo> && git commit` lands.
#
# MEASURED 2026-09-21: a session rooted at the PUBLIC MIRROR made five commits to
# massu-internal. Every one was gated by running `tsc --noEmit` and `npm test` in the
# MIRROR. They passed, so nothing looked wrong — a gate reporting green about a repository
# it was never asked about is the blind-gate law with the subject swapped out. It only
# surfaced when the mirror's node_modules were removed and the gate started failing for a
# commit that had nothing to do with it.
#
# The command string is the authority, because it carries the `cd`. Order: the path the
# command names, then the actual working tree, and the ambient variable only as a last
# resort. WHICH BRANCH WAS TAKEN IS PRINTED — a silent fallback to the wrong repo is the
# defect, so the choice must be observable (M1).
_gate_subject() {
  local dir=""
  # 1. `cd <path> && ... git commit` / `git -C <path> commit` — the command names its target.
  dir="$(printf '%s' "$COMMAND" | sed -nE 's|.*git -C ([^ ]+).*|\1|p' | head -1)"
  [ -z "$dir" ] && dir="$(printf '%s' "$COMMAND" | sed -nE 's|^[[:space:]]*cd ([^ &;|]+).*|\1|p' | head -1)"
  if [ -n "$dir" ]; then
    # Expand a leading `~` the way the shell would, WITHOUT `eval` — the text comes from a
    # command string, and eval on that is arbitrary execution for a path expansion. Through
    # the documented override seam so a test can redirect it (homedir-injectability guard).
    _gate_home="${MASSU_GATE_HOME:-$HOME}"
    # The quotes are the point: this matches a LITERAL `~` typed in the command string and
    # expands it here, deliberately without eval (SC2088 assumes the opposite intent).
    # shellcheck disable=SC2088
    case "$dir" in
      '~') dir="$_gate_home" ;;
      '~/'*) dir="$_gate_home/${dir#\~/}" ;;
    esac
    if top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" && [ -n "$top" ]; then
      printf '%s\t%s\n' "$top" "command"; return 0
    fi
  fi
  # 2. The working tree this hook is standing in.
  if top="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$top" ]; then
    printf '%s\t%s\n' "$top" "cwd"; return 0
  fi
  # 3. The ambient variable, last and announced.
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    printf '%s\t%s\n' "$CLAUDE_PROJECT_DIR" "CLAUDE_PROJECT_DIR"; return 0
  fi
  return 1
}
if ! _subject="$(_gate_subject)"; then
  # M2 — cannot identify the repository under test. That is an ERROR, never a pass.
  echo "[PRE-COMMIT GATE] could not identify the repository this commit targets — refusing." >&2
  exit 2
fi
PROJECT_DIR="${_subject%%	*}"
GATE_SUBJECT_SOURCE="${_subject##*	}"
echo "[PRE-COMMIT GATE] subject: $PROJECT_DIR (from: $GATE_SUBJECT_SOURCE)" >&2

# Node version pre-flight. massu supports Node >=20 (packages/core engines).
# The <26 ceiling was DROPPED in 1.15.1 (incident 2026-07-05): better-sqlite3
# 12.11.1 ships prebuilt binaries for Node 20/22/24/26 (incl. ABI 147), so the
# native module loads on every supported major and the full suite passes on
# Node 26. Enforce only the real >=20 floor; do NOT force an older Node — the
# gate must run under the developer's ACTUAL Node so the installed better-sqlite3
# ABI matches (forcing node@22 while the binary is built for Node 26 breaks it).
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[PRE-COMMIT GATE] Node v${NODE_MAJOR}.x is below packages/core/package.json engines floor (\">=20.0.0\")." >&2
    echo "  Fix: use Node >=20 (nvm: nvm use \$(cat .nvmrc), or a newer brew node)." >&2
    exit 2
  fi
fi

# Check if core packages have staged changes
# WHAT THIS COMMIT CAN INCLUDE — not what is staged right now (2026-11-09).
# This hook runs BEFORE the command, so a one-line `git add X && git commit` has staged nothing
# yet: reading `git diff --cached` here saw 0 packages/ paths, skipped tsc and npm test, and
# passed a commit whose suite was red (516010ce). The command can stage anything pending, so the
# scope is every staged, unstaged and untracked path — read in the commit's OWN repository
# ($PROJECT_DIR, not this hook's cwd). Could not ask git -> scope everything (fail closed).
_pending_paths() {
  git -C "$PROJECT_DIR" diff --cached --name-only &&
  git -C "$PROJECT_DIR" diff --name-only &&
  git -C "$PROJECT_DIR" ls-files --others --exclude-standard
}
if PENDING="$(_pending_paths 2>/dev/null)"; then
  CORE_STAGED=$(printf '%s\n' "$PENDING" | grep -c '^packages/' || true)
  WEBSITE_STAGED=$(printf '%s\n' "$PENDING" | grep -c '^website/' || true)
else
  echo "[PRE-COMMIT GATE] could not list pending changes in $PROJECT_DIR — checking everything." >&2
  CORE_STAGED=1
  WEBSITE_STAGED=1
fi
if [ "${MASSU_PRECOMMIT_SCOPE_ONLY:-}" = "1" ]; then
  # Test seam: report the scope decision and stop before tsc / npm test.
  echo "scope core=$CORE_STAGED website=$WEBSITE_STAGED"
  exit 0
fi

ERRORS=0

# ONE DEADLINE FOR EVERY CHECK, AND A CHECK THAT CANNOT FINISH HAS NOT PASSED (2026-11-09).
# Claude Code cancels a PreToolUse hook at its `timeout` (120 s in .claude/settings.json) and
# then takes NO decision, so the command runs: the gate failed OPEN whenever tsc + the full
# suite took longer than that (measured: 1f693059 committed with a stale proof). Now each step
# runs under bounded-run.sh against the time LEFT in MASSU_PRECOMMIT_BUDGET_SECS (default 100,
# under the hook limit), and a step that hits it BLOCKS the commit.
#
# AND THE FAST TIER, NOT THE EXHAUSTIVE ONE (operator decision 2026-11-09; G31). Tests are the
# ones the pending files reach: changed test files directly, changed sources via
# `vitest related` (Vitest's documented pre-commit pattern). Guards that READ files rather than
# import them — the gate registry, the plan corpus — are not in that graph; the full suite runs
# at pre-push (`[6/22] Tests`) and in CI, as before.
_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/bounded-run.sh
. "$_GATE_DIR/../lib/bounded-run.sh" || { echo "[PRE-COMMIT GATE] cannot load bounded-run.sh — refusing." >&2; exit 2; }
GATE_BUDGET_SECS="${MASSU_PRECOMMIT_BUDGET_SECS:-100}"
GATE_START=$(date +%s)
GATE_LOG_DIR=$(mktemp -d) || { echo "[PRE-COMMIT GATE] cannot create a log dir — refusing." >&2; exit 2; }
STAGED_TMP=""
# ONE EXIT trap for every temp dir (bash keeps only the last `trap ... EXIT`, and the plan
# section below used to set its own). Each path is checked non-empty and a directory first (G17).
_gate_cleanup() {
  local d
  for d in "${GATE_LOG_DIR:-}" "${STAGED_TMP:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && rm -rf -- "$d"
  done
  return 0
}
trap _gate_cleanup EXIT

# run_step <label> <dir> <cmd...> -> 0 pass, 1 fail, 2 could not finish (both 1 and 2 block)
run_step() {
  local label="$1" dir="$2"; shift 2
  local left log slug
  left=$(( GATE_BUDGET_SECS - ($(date +%s) - GATE_START) ))
  slug="$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')"
  log="$GATE_LOG_DIR/$slug.log"
  if [ "$left" -lt 5 ]; then
    echo "[PRE-COMMIT GATE] no time left for: $label (budget ${GATE_BUDGET_SECS}s) — BLOCKED; a check that did not run has not passed." >&2
    return 2
  fi
  local rc=0
  ( cd "$dir" && br_run_bounded "$left" "$log" "$@" ) || rc=$?
  if [ "$rc" -eq 0 ]; then tail -3 "$log"; return 0; fi
  tail -20 "$log" >&2
  if [ "$rc" -eq "$BR_EXIT_CEILING" ]; then
    echo "[PRE-COMMIT GATE] $label did not finish within the gate's ${GATE_BUDGET_SECS}s budget — BLOCKED (fail closed). Run it yourself, or raise MASSU_PRECOMMIT_BUDGET_SECS below the hook timeout." >&2
    return 2
  fi
  echo "[PRE-COMMIT GATE] $label failed. Fix before committing." >&2
  return 1
}

if [ "$CORE_STAGED" -gt 0 ]; then
  run_step "TypeScript (packages/core)" "$PROJECT_DIR/packages/core" npx tsc --noEmit || ERRORS=$((ERRORS + 1))

  # Test selection: pending, still-existing .ts files under packages/core, relative to it.
  CORE_TESTS=(); CORE_SRCS=()
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$PROJECT_DIR/$f" ] || continue
    rel="${f#packages/core/}"
    case "$rel" in
      *.test.ts) CORE_TESTS+=("$rel") ;;
      src/*.ts)  CORE_SRCS+=("$rel") ;;
    esac
  done < <(printf '%s\n' "$PENDING" | grep -E '^packages/core/.*\.ts$' || true)
  if [ "${#CORE_TESTS[@]}" -gt 0 ]; then
    run_step "changed tests (${#CORE_TESTS[@]})" "$PROJECT_DIR/packages/core" npx vitest run "${CORE_TESTS[@]}" || ERRORS=$((ERRORS + 1))
  fi
  if [ "${#CORE_SRCS[@]}" -gt 0 ]; then
    run_step "tests related to ${#CORE_SRCS[@]} changed source file(s)" "$PROJECT_DIR/packages/core" \
      npx vitest related --run --passWithNoTests "${CORE_SRCS[@]}" || ERRORS=$((ERRORS + 1))
  fi
fi

if [ "$WEBSITE_STAGED" -gt 0 ]; then
  run_step "TypeScript (website)" "$PROJECT_DIR/website" npx tsc --noEmit || ERRORS=$((ERRORS + 1))
fi

# ----------------------------------------------------------------------
# Plan-status drift gate (validates MERGED-STAGED tree, not HEAD).
# Plan 1.5.8 P3-003.
#
# Why merged tree: corpus-wide invariants (Plan Token uniqueness, total
# count, deletions) cannot be enforced if MASSU_PLAN_DIR contains only
# staged plans. Build a temp dir = entire current corpus + staged
# overlays - staged deletions, then point the validator + scanner at it.
#
# Fast-path skip: only run when this commit touches docs/plans/ or the
# validator/scanner scripts themselves.
# ----------------------------------------------------------------------
# Scoped by PENDING (staged + unstaged + untracked), like the checks above: the index before
# the command ran cannot see a plan staged by a one-line `git add … && git commit`.
PLAN_STAGED=$(printf '%s\n' "$PENDING" | grep -E '^docs/plans/.+\.md$' || true)
SCRIPT_STAGED=$(printf '%s\n' "$PENDING" | grep -E '^scripts/massu-plan-(status-validator|commit-drift)\.sh$' || true)
if [ -n "$PLAN_STAGED" ] || [ -n "$SCRIPT_STAGED" ]; then
  STAGED_TMP=$(mktemp -d)   # removed by _gate_cleanup (the single EXIT trap above)

  # Step 1: seed merged tree with the entire current corpus
  mkdir -p "$STAGED_TMP/docs/plans"
  if [ -d "$PROJECT_DIR/docs/plans" ]; then
    cp "$PROJECT_DIR/docs/plans/"*.md "$STAGED_TMP/docs/plans/" 2>/dev/null || true
  fi

  # Step 2: overlay STAGED content (Added, Modified, or Rename-target)
  # for plans. --diff-filter=AMR covers renames; the rename source is
  # naturally absent from the working-tree corpus already, so no separate
  # handling needed.
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    mkdir -p "$STAGED_TMP/$(dirname "$f")"
    git show ":$f" > "$STAGED_TMP/$f" 2>/dev/null || true
  done < <(git diff --cached --name-only --diff-filter=AMR 2>/dev/null | grep -E '^docs/plans/.+\.md$' || true)

  # Step 3: remove staged DELETIONS from merged tree
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    rm -f "$STAGED_TMP/$f" 2>/dev/null || true
  done < <(git diff --cached --name-only --diff-filter=D 2>/dev/null | grep -E '^docs/plans/.+\.md$' || true)

  # Step 4: validator + commit-drift see the post-commit corpus
  if ! MASSU_PLAN_DIR="$STAGED_TMP/docs/plans" bash "$PROJECT_DIR/scripts/massu-plan-status-validator.sh" >&2; then
    echo "[PRE-COMMIT GATE] Plan Status Validator failed (merged-staged tree). Fix Status/Plan Token field." >&2
    ERRORS=$((ERRORS + 1))
  fi
  if ! MASSU_PLAN_DIR="$STAGED_TMP/docs/plans" bash "$PROJECT_DIR/scripts/massu-plan-commit-drift.sh" >&2; then
    echo "[PRE-COMMIT GATE] Plan Commit Drift detected. A plan referenced by commits is still in DRAFT/IN PROGRESS." >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ----------------------------------------------------------------------
# CLAUDE.md size gate (plan-2026-06-01-claude-md-size-compliance).
# Fail-with-remedy: fast-path so it only runs when .claude/CLAUDE.md is
# staged. The budget (MAX_SIZE) lives ONCE in check-claude-md-size.sh; this
# gate, pre-push-light, and CI all invoke that single script (no re-hardcoded
# number). On failure, surface the autosplit remedy.
# ----------------------------------------------------------------------
CLAUDE_MD_STAGED=$(printf '%s\n' "$PENDING" | grep -c '^\.claude/CLAUDE\.md$' || true)
if [ "$CLAUDE_MD_STAGED" -gt 0 ]; then
  if ! bash "$PROJECT_DIR/scripts/check-claude-md-size.sh" >&2; then
    echo "[PRE-COMMIT GATE] .claude/CLAUDE.md exceeds the size budget." >&2
    echo "  REMEDY: bash scripts/claude-md-autosplit.sh   (moves '### CR-NN:' detail bodies to reference, then re-stage)" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "[PRE-COMMIT GATE] $ERRORS check(s) failed. Commit blocked." >&2
  exit 2
fi

exit 0

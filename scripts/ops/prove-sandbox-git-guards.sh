#!/usr/bin/env bash
# prove-sandbox-git-guards.sh — CR-72 live-fire proof for G29/CR-92 (Incident #166).
#
# THE PROPERTY: no test harness in this repo can write to the REAL repository when
# `GIT_DIR` is set in its environment. That state is NOT created by git for its hooks
# (measured — scripts/ops/probe-git-hook-env.sh: pre-commit/commit-msg get
# GIT_INDEX_FILE + GIT_PREFIX, pre-push gets GIT_PREFIX, and GIT_DIR is absent from all
# three). It arrives from a CALLER that sets it — a nested git invocation, a wrapper, a
# harness, a tool. `GIT_DIR` ALONE is the destructive shape, so it is what this proof
# injects; note that a hook-inherited GIT_INDEX_FILE redirects the index by itself and
# is a second, independent carrier of the same hazard.
#
# THE PROOF (four observables, recorded before and after, asserted UNCHANGED):
#     tracked count · staged count · core.bare · HEAD
#
# WHY THERE IS A NEGATIVE CONTROL: "all four unchanged" is also what you observe when
# the harness never ran at all — a vitest startup failure, a typo in a path, a suite
# that silently skipped. Those are observationally identical to a pass (THE BLIND-GATE
# LAW), so this script separately PROVES that GIT_DIR injection really does damage, by
# doing it to a throwaway victim repo. If the negative control does not go red, the
# whole run is meaningless and this script exits 2.
#
# The negative control NEVER points at the real repository (G25): it constructs its own
# sandbox and its own victim under mktemp, and GIT_DIR is only ever set to the victim.
#
# Usage:  bash scripts/ops/prove-sandbox-git-guards.sh [--list] [--dry-run]

set -uo pipefail

# --- G29/CR-92: NEUTRALISE THE CALLER'S GIT ENVIRONMENT - DO NOT REMOVE -------
# `git -C <dir>` DOES NOT SCOPE GIT. GIT_DIR outranks `-C` exactly as it outranks
# `cd` and `cwd:`, and is inherited from any CALLER that sets it — a nested git
# invocation, a wrapper, a harness, a tool. (Git does NOT hand GIT_DIR to the hooks
# it runs; measured, scripts/ops/probe-git-hook-env.sh. Hooks DO inherit
# GIT_INDEX_FILE, which redirects the index by itself.) This script addresses
# repositories BY PATH, so an inherited GIT_DIR makes every one of those reads
# answer about the CALLER's repo instead - silently, with a confident wrong value
# rather than an error. Incident #166.
# Inline, NOT sourced: this script runs without `set -e`, so a failed `source`
# would continue and leave it unprotected. Executed, never sourced, so `unset`
# here cannot mutate a caller's environment.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# ...and a machine-global `init.templateDir` pre-populates .git/hooks in EVERY `git init`,
# so a sandbox is NOT pristine just because it is new. GIT_TEMPLATE_DIR outranks the
# config; empty means "no template". Exported so child processes inherit it.
export GIT_TEMPLATE_DIR=""
# -----------------------------------------------------------------------------


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root"; exit 2; }

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'

# The harnesses under proof. Shell harnesses run directly; TS harnesses run via vitest.
SHELL_HARNESSES=(
  "scripts/tests/test_home_path_guard_tarball_mode.sh"
  "scripts/tests/test_leak_guard_ci_redaction.sh"
  "scripts/tests/test_install_hooks_context.sh"
  "scripts/tests/test_sync_public_target_guard.sh"
)
TS_HARNESSES=(
  "auto-learning-bounded-diff"
  "generalization-scanner-scripts-scope-drift-guard"
  "incident-coverage-scope"
  "plan-status-drift-guard"
  "leak-guard-commit-mode"
  "supabase-alias-leak-guard"
)

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --list)
      printf '%s\n' "${SHELL_HARNESSES[@]}"
      for t in "${TS_HARNESSES[@]}"; do echo "packages/core/src/__tests__/$t.test.ts"; done
      exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "FATAL: unknown argument '$a' (R-011: refusing to guess)"; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------------
# NEGATIVE CONTROL — prove GIT_DIR injection is real before trusting any "unchanged".
# --------------------------------------------------------------------------------
negative_control() {
  local tmp victim sandbox before after
  tmp="$(mktemp -d)" || return 2
  victim="$tmp/victim"; sandbox="$tmp/sandbox"
  mkdir -p "$victim" "$sandbox" || return 2

  ( cd "$victim" \
    && git init -q . \
    && git config user.email t@t.test && git config user.name t \
    && seq 1 20 | while read -r n; do echo "x" > "f$n.txt"; done \
    && git add -A && git commit -q -m base ) >/dev/null 2>&1 || { rm -rf "$tmp"; return 2; }

  before="$(git -C "$victim" ls-files | wc -l | tr -d ' ')"
  echo "only-me" > "$sandbox/lonely.txt"

  # The PRE-FIX shape, verbatim: cd into the sandbox and commit, with GIT_DIR inherited.
  ( export GIT_DIR="$victim/.git"
    cd "$sandbox" && git add -A && git commit -q -m "injected" ) >/dev/null 2>&1

  after="$(git -C "$victim" ls-files | wc -l | tr -d ' ')"
  rm -rf "$tmp"

  # The injection is REAL iff the victim's tracked set collapsed to the sandbox's file.
  [ "$before" -eq 20 ] && [ "$after" -lt "$before" ]
}

echo "=== NEGATIVE CONTROL: is GIT_DIR injection real? ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${YELLOW}DRY-RUN${NC} skipped"
else
  if negative_control; then
    echo "  ${GREEN}CONTROL RED${NC} — GIT_DIR injection demonstrably rewrites a victim repo."
    echo "  An 'unchanged' result below therefore means the guards held, not that nothing ran."
  else
    echo "  ${RED}CONTROL DID NOT FIRE${NC} — the injection could not be demonstrated."
    echo "  Every assertion below would be vacuous. Refusing to report a pass."
    exit 2
  fi
fi

# --------------------------------------------------------------------------------
# SNAPSHOT
# --------------------------------------------------------------------------------
snapshot() {
  printf 'tracked=%s staged=%s bare=%s head=%s' \
    "$(git ls-files | wc -l | tr -d ' ')" \
    "$(git diff --cached --name-only | wc -l | tr -d ' ')" \
    "$(git config --get core.bare 2>/dev/null || echo unset)" \
    "$(git rev-parse HEAD 2>/dev/null || echo none)"
}

BEFORE="$(snapshot)"
echo
echo "=== BEFORE ==="
echo "  $BEFORE"

if [ "$DRY_RUN" -eq 1 ]; then
  echo; echo "DRY-RUN: would run ${#SHELL_HARNESSES[@]} shell + ${#TS_HARNESSES[@]} TS harnesses with GIT_DIR set."
  exit 0
fi

# --------------------------------------------------------------------------------
# RUN EVERY HARNESS WITH GIT_DIR SET — the state a LEAKING CALLER creates. (Not a hook:
# git does not hand GIT_DIR to hooks — measured, scripts/ops/probe-git-hook-env.sh.)
# --------------------------------------------------------------------------------
REAL_GIT_DIR="$(git rev-parse --git-dir)"
case "$REAL_GIT_DIR" in
  /*) ;; *) REAL_GIT_DIR="$REPO_ROOT/$REAL_GIT_DIR" ;;
esac

RAN=0; FAILED_TO_RUN=0
echo
echo "=== RUNNING HARNESSES WITH GIT_DIR=$REAL_GIT_DIR ==="

for h in "${SHELL_HARNESSES[@]}"; do
  if [ ! -f "$h" ]; then
    echo "  ${RED}MISSING${NC} $h — cannot prove a harness that is not there"
    FAILED_TO_RUN=$((FAILED_TO_RUN + 1)); continue
  fi
  GIT_DIR="$REAL_GIT_DIR" bash "$h" >/dev/null 2>&1
  echo "  ran (exit $?) $h"
  RAN=$((RAN + 1))
done

for t in "${TS_HARNESSES[@]}"; do
  f="packages/core/src/__tests__/$t.test.ts"
  if [ ! -f "$f" ]; then
    echo "  ${RED}MISSING${NC} $f"
    FAILED_TO_RUN=$((FAILED_TO_RUN + 1)); continue
  fi
  ( cd packages/core && GIT_DIR="$REAL_GIT_DIR" npx vitest run "$t" ) >/dev/null 2>&1
  echo "  ran (exit $?) $f"
  RAN=$((RAN + 1))
done

# M1 — PROVE IT LOOKED. "0 harnesses run, 0 damage" must never read as a pass.
EXPECTED=$(( ${#SHELL_HARNESSES[@]} + ${#TS_HARNESSES[@]} ))
echo
echo "harnesses run: $RAN of $EXPECTED (missing: $FAILED_TO_RUN)"
if [ "$RAN" -eq 0 ] || [ "$FAILED_TO_RUN" -gt 0 ]; then
  echo "${RED}FAIL${NC}: not every harness was exercised — an 'unchanged' verdict would be blind."
  exit 2
fi

AFTER="$(snapshot)"
echo
echo "=== AFTER ==="
echo "  $AFTER"
echo

if [ "$BEFORE" = "$AFTER" ]; then
  echo "${GREEN}PASS${NC}: tracked / staged / core.bare / HEAD all UNCHANGED across $RAN harnesses"
  echo "      run with GIT_DIR set, with the injection proven live by the negative control."
  exit 0
fi

echo "${RED}FAIL${NC}: the real repository was mutated."
echo "  before: $BEFORE"
echo "  after:  $AFTER"
echo "  Recover with: git reset   (MIXED — never --hard; see Incident #166)"
exit 1

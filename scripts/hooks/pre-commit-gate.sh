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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Node version pre-flight (Plan 1.5.8 hardening — Gate 3 incident 2026-05-09).
# better-sqlite3 hard-binds to Node ABI; Node v26 lacks v8::PropertyCallbackInfo<T>::This,
# breaking native rebuild. Auto-prepend node@22 brew prefix to PATH if available so the
# rest of this gate runs under the project's pinned engines range (>=20 <26).
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
  if [ -n "$NODE_MAJOR" ] && { [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -ge 26 ]; }; then
    if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
      export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
      echo "[PRE-COMMIT GATE] Node v${NODE_MAJOR}.x incompatible with project engines; using /opt/homebrew/opt/node@22/bin/node for this gate." >&2
    elif [ -x /usr/local/opt/node@22/bin/node ]; then
      export PATH="/usr/local/opt/node@22/bin:$PATH"
      echo "[PRE-COMMIT GATE] Node v${NODE_MAJOR}.x incompatible with project engines; using /usr/local/opt/node@22/bin/node for this gate." >&2
    else
      echo "[PRE-COMMIT GATE] Node v${NODE_MAJOR}.x is incompatible with packages/core/package.json engines (\">=20.0.0 <26.0.0\")." >&2
      echo "  Fix: brew install node@22 (or use nvm: nvm use \$(cat .nvmrc))." >&2
      exit 2
    fi
  fi
fi

# Check if core packages have staged changes
CORE_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^packages/' || true)
WEBSITE_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^website/' || true)

ERRORS=0

# Type check core if core files are staged
# NOTE: pipeline exit-code masking bug fixed (Plan 1.5.8 aftermath): the prior
# `if ! cmd | tail -5` form checked tail's exit code, masking tsc/test failures.
if [ "$CORE_STAGED" -gt 0 ]; then
  cd "$PROJECT_DIR/packages/core"
  TSC_LOG=$(mktemp)
  if npx tsc --noEmit > "$TSC_LOG" 2>&1; then
    tail -5 "$TSC_LOG"
  else
    tail -10 "$TSC_LOG" >&2
    echo "[PRE-COMMIT GATE] TypeScript errors in packages/core. Fix before committing." >&2
    ERRORS=$((ERRORS + 1))
  fi
  rm -f "$TSC_LOG"
  cd "$PROJECT_DIR"
fi

# Type check website if website files are staged
if [ "$WEBSITE_STAGED" -gt 0 ]; then
  cd "$PROJECT_DIR/website"
  TSC_LOG=$(mktemp)
  if npx tsc --noEmit > "$TSC_LOG" 2>&1; then
    tail -5 "$TSC_LOG"
  else
    tail -10 "$TSC_LOG" >&2
    echo "[PRE-COMMIT GATE] TypeScript errors in website/. Fix before committing." >&2
    ERRORS=$((ERRORS + 1))
  fi
  rm -f "$TSC_LOG"
  cd "$PROJECT_DIR"
fi

# Run tests if any source files are staged
# NOTE: Pipeline exit-code masking bug fixed (Plan 1.5.8 / commit da8049a aftermath):
# previous form `if ! cd "$PROJECT_DIR" && npm test 2>&1 | tail -5` checked tail's exit
# code (always 0), masking npm test failures. Switched to set -o pipefail behavior:
# capture exit code in a temp file, then check it.
if [ "$CORE_STAGED" -gt 0 ]; then
  cd "$PROJECT_DIR"
  TEST_LOG=$(mktemp)
  if npm test > "$TEST_LOG" 2>&1; then
    tail -5 "$TEST_LOG"
  else
    tail -20 "$TEST_LOG" >&2
    echo "[PRE-COMMIT GATE] Tests failed. Fix before committing." >&2
    ERRORS=$((ERRORS + 1))
  fi
  rm -f "$TEST_LOG"
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
PLAN_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -E '^docs/plans/.+\.md$' || true)
SCRIPT_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -E '^scripts/massu-plan-(status-validator|commit-drift)\.sh$' || true)
if [ -n "$PLAN_STAGED" ] || [ -n "$SCRIPT_STAGED" ]; then
  STAGED_TMP=$(mktemp -d)
  trap 'rm -rf "$STAGED_TMP"' EXIT

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

if [ "$ERRORS" -gt 0 ]; then
  echo "[PRE-COMMIT GATE] $ERRORS check(s) failed. Commit blocked." >&2
  exit 2
fi

exit 0

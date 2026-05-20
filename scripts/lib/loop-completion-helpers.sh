#!/usr/bin/env bash
# scripts/lib/loop-completion-helpers.sh — helpers for the loop completion
# gate (CR-52). Sourced by:
#   - scripts/massu-loop-completion-gate.sh
#   - .claude/commands/massu-loop/references/loop-controller.md (Phase 0.5 record)
#
# Plan reference: plan-loop-multi-perspective-enforcement (3-layer enforcement
# of multi-perspective review evidence).

# ---------------------------------------------------------------------------
# Resolve repo root for portability (script may be sourced from any cwd).
# ---------------------------------------------------------------------------
if [ -z "${MASSU_REPO_ROOT:-}" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
    MASSU_REPO_ROOT="$(git rev-parse --show-toplevel)"
  else
    # Fallback: assume CWD is repo root.
    MASSU_REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  fi
fi
export MASSU_REPO_ROOT

# ---------------------------------------------------------------------------
# Source the plan-token regex SoT (PLAIN_PLAN_TOKEN_REGEX).
# ---------------------------------------------------------------------------
# shellcheck source=./plan-token-regex.sh
. "${MASSU_REPO_ROOT}/scripts/lib/plan-token-regex.sh"

# ---------------------------------------------------------------------------
# plan_token_strict_check <token>
#
# Returns 0 if <token> is a valid plain plan-token AND contains no newline
# or control characters. Returns non-zero (with stderr message) otherwise.
#
# Hardens against the security review HIGH-3 finding: `grep -qE "^pattern$"`
# anchors are LINE anchors, so a multi-line string like $'plan-foo\nplan-bar'
# passes single-anchor validation. This check additionally rejects any input
# containing characters outside the printable-ASCII set we care about.
# ---------------------------------------------------------------------------
plan_token_strict_check() {
  local token="$1"
  if [ -z "$token" ]; then
    echo "plan_token_strict_check: empty token" >&2
    return 1
  fi
  # Reject ANY newline / CR / null byte / tab. grep with -F + $'\n' literal.
  case "$token" in
    *$'\n'*|*$'\r'*|*$'\t'*|*' '*)
      echo "plan_token_strict_check: token contains whitespace or control char" >&2
      return 1
      ;;
  esac
  if ! printf '%s' "$token" | grep -qE "${PLAIN_PLAN_TOKEN_REGEX}"; then
    echo "plan_token_strict_check: token '${token}' does not match ${PLAIN_PLAN_TOKEN_REGEX}" >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# loop_start_record <plan-token>
#
# Writes a JSON record { plan_token, started_at_iso } to
# .claude/loop-state/loop-start-<plan-token>.json so the completion gate
# can filter agent-result files by mtime >= started_at_iso.
#
# Idempotent — overwrites any prior start-time for the same plan-token (a
# new loop run for the same plan supersedes the previous record).
# ---------------------------------------------------------------------------
loop_start_record() {
  local plan_token="$1"
  if [ -z "$plan_token" ]; then
    echo "loop_start_record: missing plan-token argument" >&2
    return 2
  fi
  if ! plan_token_strict_check "$plan_token"; then
    return 2
  fi

  local state_dir="${MASSU_REPO_ROOT}/.claude/loop-state"
  mkdir -p "$state_dir"

  local iso
  iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local out="${state_dir}/loop-start-${plan_token}.json"
  printf '{"plan_token":"%s","started_at_iso":"%s"}\n' "$plan_token" "$iso" > "$out"
  echo "$iso"
}

# ---------------------------------------------------------------------------
# loop_start_read <plan-token>
#
# Echoes the started_at_iso for the given plan-token. Returns non-zero if
# the start file is missing.
# ---------------------------------------------------------------------------
loop_start_read() {
  local plan_token="$1"
  if [ -z "$plan_token" ]; then
    echo "loop_start_read: missing plan-token argument" >&2
    return 2
  fi
  local f="${MASSU_REPO_ROOT}/.claude/loop-state/loop-start-${plan_token}.json"
  if [ ! -f "$f" ]; then
    return 1
  fi
  # Plain text extract — avoid jq dep here. The record is a single-line JSON.
  sed -n 's/.*"started_at_iso":"\([^"]*\)".*/\1/p' "$f"
}

# ---------------------------------------------------------------------------
# loop_token_from_plan_path <plan-file-path>
#
# Extracts the `**Plan Token**:` value from a plan markdown file and validates
# it against PLAIN_PLAN_TOKEN_REGEX. Echoes the bare token (e.g. plan-foo-bar).
# Returns non-zero if the plan file is missing, lacks a Plan Token line, or
# the token fails validation.
# ---------------------------------------------------------------------------
loop_token_from_plan_path() {
  local plan_path="$1"
  if [ -z "$plan_path" ]; then
    echo "loop_token_from_plan_path: missing plan-file-path argument" >&2
    return 2
  fi
  if [ ! -f "$plan_path" ]; then
    echo "loop_token_from_plan_path: plan file not found: $plan_path" >&2
    return 1
  fi
  # Extract the first **Plan Token**: line value. Accepts both backtick-wrapped
  # and bare values. Examples:
  #   **Plan Token**: `plan-foo-bar`
  #   **Plan Token**: plan-foo-bar
  local token
  token="$(grep -m1 -E '^\*\*Plan Token\*\*:' "$plan_path" \
    | sed -E 's/^\*\*Plan Token\*\*:[[:space:]]*`?([^`[:space:]]+)`?.*/\1/')"
  if [ -z "$token" ]; then
    echo "loop_token_from_plan_path: no **Plan Token**: line in $plan_path" >&2
    return 1
  fi
  if ! plan_token_strict_check "$token"; then
    return 1
  fi
  echo "$token"
}

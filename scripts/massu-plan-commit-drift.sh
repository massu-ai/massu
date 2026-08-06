#!/usr/bin/env bash
#
# massu-plan-commit-drift.sh - Commit-link Drift Scanner
#
# Plan 1.5.8 / Plan 2026-05-09-stale-plan-status-drift-guard P1-002:
# Scans `git log --since=$MASSU_DRIFT_SINCE` for commit subjects matching
# (feat|fix|chore|docs)(plan-<token>); for each match, looks up the plan
# by token and FAILS if Status is in the non-shipped enum (DRAFT,
# IN PROGRESS). Allowlisted external tokens (cross-repo plans living in
# a sister repository) WARN instead of FAIL.
#
# Exit 0 = no drift, Exit 1 = drift detected.
#
# Usage:
#   bash scripts/massu-plan-commit-drift.sh [--json] [--help]
#
# Env overrides:
#   MASSU_PLAN_DIR        - override default docs/plans/ glob root
#   MASSU_DRIFT_SINCE     - override default 2026-04-01 git-log floor
#   MASSU_PLAN_EXTRA_DIR  - additional plan-source dir merged into corpus

set -uo pipefail

# --- G29/CR-92: NEUTRALISE THE CALLER'S GIT ENVIRONMENT - DO NOT REMOVE -------
# `git -C <dir>` DOES NOT SCOPE GIT. GIT_DIR outranks `-C`, and is inherited from any
# CALLER that sets it — a nested git invocation, a wrapper, a harness, a tool. (Git does
# NOT hand GIT_DIR to the hooks it runs; measured, scripts/ops/probe-git-hook-env.sh.
# Hooks DO inherit GIT_INDEX_FILE, which redirects the index by itself.)
# DRIFT_REPO is overridable (MASSU_DRIFT_REPO), and that
# override exists precisely so this can adjudicate ANOTHER repo - which is exactly
# the case an inherited GIT_DIR breaks, silently reporting on the caller's repo
# instead. Incident #166. Executed, never sourced, so `unset` cannot leak upward.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# ...and a machine-global `init.templateDir` pre-populates .git/hooks in EVERY `git init`,
# so a sandbox is NOT pristine just because it is new. GIT_TEMPLATE_DIR outranks the
# config; empty means "no template". Exported so child processes inherit it.
export GIT_TEMPLATE_DIR=""
# -----------------------------------------------------------------------------


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source the shared plan-token regex SoT (plan-1.9.0-plan-token-aware-changelog-batcher P-A-002).
# Provides PLAN_TOKEN_REGEX + extract_plan_tokens_from_range().
# shellcheck source=lib/plan-token-regex.sh
source "$REPO_ROOT/scripts/lib/plan-token-regex.sh"
PLAN_DIR="${MASSU_PLAN_DIR:-$REPO_ROOT/docs/plans}"
EXTRA_DIR="${MASSU_PLAN_EXTRA_DIR:-}"
SINCE="${MASSU_DRIFT_SINCE:-2026-04-01}"
# MASSU_DRIFT_REPO overrides the git repo for the `git log` source — used
# by tests that want to inject synthetic commits without touching the real
# repo's history. Defaults to REPO_ROOT (the live history).
DRIFT_REPO="${MASSU_DRIFT_REPO:-$REPO_ROOT}"
ALLOWLIST_FILE="${MASSU_DRIFT_ALLOWLIST:-$REPO_ROOT/scripts/massu-plan-external-tokens.txt}"

JSON_MODE=0
for arg in "$@"; do
  case "$arg" in
    --json)
      JSON_MODE=1
      ;;
    --help|-h)
      cat <<EOF
massu-plan-commit-drift.sh - Commit-link Drift Scanner

Scans git log --since=<SINCE> for commit subjects matching
(feat|fix|chore|docs)(plan-<token>) and FAILS if any plan referenced
by such a commit still has Status in the non-shipped enum (DRAFT or
IN PROGRESS).

Misses against the corpus that hit the external-token allowlist
(scripts/massu-plan-external-tokens.txt) WARN rather than FAIL — these
are cross-repo plans (sister repositories) intentionally outside this corpus.

Exit 0 = no drift, Exit 1 = drift detected.

Usage:
  bash scripts/massu-plan-commit-drift.sh [--json]

Env:
  MASSU_PLAN_DIR         Override default docs/plans/ glob root.
  MASSU_DRIFT_SINCE      Override default 2026-04-01 git-log floor.
  MASSU_PLAN_EXTRA_DIR   Additional plan-source dir merged into corpus.
  MASSU_DRIFT_REPO       Override the git repo whose log is scanned
                         (test-only — defaults to REPO_ROOT).
  MASSU_DRIFT_ALLOWLIST  Override the external-token allowlist path.
EOF
      exit 0
      ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

VIOLATIONS=0
WARNINGS=0
JSON_RECORDS=()

if [ "$JSON_MODE" = "1" ]; then
  RED=""; GREEN=""; YELLOW=""; NC=""
fi

pass_msg() { [ "$JSON_MODE" = "1" ] || echo -e "  ${GREEN}PASS${NC}: $1"; }
fail_msg() { [ "$JSON_MODE" = "1" ] || echo -e "  ${RED}FAIL${NC}: $1"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn_msg() { [ "$JSON_MODE" = "1" ] || echo -e "  ${YELLOW}WARN${NC}: $1"; WARNINGS=$((WARNINGS + 1)); }

json_record() {
  local sha="$1" token="$2" path="$3" level="$4" msg="$5"
  local esc
  esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  JSON_RECORDS+=("{\"sha\":\"$sha\",\"token\":\"$token\",\"path\":\"$path\",\"level\":\"$level\",\"message\":\"$esc\"}")
  if [ "$level" = "FAIL" ]; then
    VIOLATIONS=$((VIOLATIONS + 1))
  elif [ "$level" = "WARN" ]; then
    WARNINGS=$((WARNINGS + 1))
  fi
}

# Source the validator's parser functions.
MASSU_VALIDATOR_PARSER_ONLY=1 \
  source "$REPO_ROOT/scripts/massu-plan-status-validator.sh"

# Build the plan-token map: token -> file path.
TOKEN_KEYS=()
TOKEN_FILES=()
TOKEN_STATUSES=()

ingest_plan_dir() {
  local dir="$1"
  [ -z "$dir" ] && return 0
  [ -d "$dir" ] || return 0
  shopt -s nullglob
  local files=("$dir"/*.md)
  shopt -u nullglob
  for f in "${files[@]}"; do
    local rel="${f#"$REPO_ROOT/"}"
    local status_raw status_canon
    status_raw=$(massu_extract_status_line "$f")
    status_canon=$(massu_status_canonical "$status_raw") || status_canon="UNKNOWN"
    while IFS= read -r tok; do
      [ -z "$tok" ] && continue
      TOKEN_KEYS+=("$tok")
      TOKEN_FILES+=("$rel")
      TOKEN_STATUSES+=("$status_canon")
    done < <(massu_extract_plan_tokens "$f")
  done
}

ingest_plan_dir "$PLAN_DIR"
ingest_plan_dir "$EXTRA_DIR"

token_lookup() {
  # echo: "<file>|<status>" if found, empty otherwise
  local needle="$1"
  local i
  for i in "${!TOKEN_KEYS[@]}"; do
    if [ "${TOKEN_KEYS[$i]}" = "$needle" ]; then
      echo "${TOKEN_FILES[$i]}|${TOKEN_STATUSES[$i]}"
      return 0
    fi
  done
  return 1
}

# Load allowlist (fnmatch-style glob per line; # = comment).
ALLOW_PATTERNS=()
if [ -f "$ALLOWLIST_FILE" ]; then
  while IFS= read -r line; do
    # Strip leading/trailing whitespace.
    trimmed=$(printf '%s' "$line" | LC_ALL=C sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    [ -z "$trimmed" ] && continue
    case "$trimmed" in
      \#*) continue ;;
    esac
    ALLOW_PATTERNS+=("$trimmed")
  done < "$ALLOWLIST_FILE"
fi

token_in_allowlist() {
  local needle="$1"
  local pat
  for pat in "${ALLOW_PATTERNS[@]}"; do
    # shellcheck disable=SC2053  # intentional glob pattern match
    if [[ "$needle" == $pat ]]; then
      return 0
    fi
  done
  return 1
}

[ "$JSON_MODE" = "1" ] || echo "=== Massu Plan Commit Drift Scanner ==="
[ "$JSON_MODE" = "1" ] || echo "Plan dir: $PLAN_DIR"
[ "$JSON_MODE" = "1" ] || echo "Since:    $SINCE"
[ "$JSON_MODE" = "1" ] || echo ""

# Pull the commit log. If git fails (no .git dir, etc.), no-op cleanly.
COMMITS=$(git -C "$DRIFT_REPO" log --since="$SINCE" --pretty=format:"%H%x09%s" 2>/dev/null || true)

if [ -z "$COMMITS" ]; then
  if [ "$JSON_MODE" = "1" ]; then
    echo "{\"summary\":{\"total_commits\":0,\"violations\":0,\"warnings\":0},\"records\":[]}"
  else
    warn_msg "No commits returned from git log --since=$SINCE"
    echo ""
    echo "=== Plan Commit Drift Summary ==="
    echo -e "${GREEN}PASS${NC}: 0 violation(s), 1 warning(s)"
  fi
  exit 0
fi

# Iterate commits. Each line: <SHA>\t<subject>
TOTAL_COMMITS=0
TOTAL_REFS=0
while IFS=$'\t' read -r sha subject; do
  [ -z "${sha:-}" ] && continue
  TOTAL_COMMITS=$((TOTAL_COMMITS + 1))
  # Extract every (feat|fix|chore|docs)(plan-<token>) slug from subject.
  # A subject might match multiple times (e.g., revert chains).
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    # match looks like "feat(plan-1.5.8-foo)"; extract just the token.
    token=$(printf '%s' "$match" | LC_ALL=C sed -E 's/^(feat|fix|chore|docs)\(//; s/\)$//')
    [ -z "$token" ] && continue
    TOTAL_REFS=$((TOTAL_REFS + 1))

    short_sha="${sha:0:7}"
    if hit=$(token_lookup "$token"); then
      file="${hit%%|*}"
      status="${hit##*|}"
      case "$status" in
        DRAFT|'IN PROGRESS')
          msg="commit $short_sha references plan-$token ($file) but Status=$status. Refresh Status to SHIPPED with the citing SHA."
          if [ "$JSON_MODE" = "1" ]; then
            json_record "$short_sha" "$token" "$file" "FAIL" "$msg"
          else
            fail_msg "$msg"
          fi
          ;;
        SHIPPED|IMPLEMENTED|COMPLETE|APPROVED|SUPERSEDED|'HISTORICAL DRAFT')
          # PASS — no per-commit chatter to keep output readable.
          :
          ;;
        UNKNOWN)
          msg="commit $short_sha references plan-$token ($file) but plan has unknown/missing Status — fix the plan's Status header"
          if [ "$JSON_MODE" = "1" ]; then
            json_record "$short_sha" "$token" "$file" "FAIL" "$msg"
          else
            fail_msg "$msg"
          fi
          ;;
        *)
          # Defensive — should never hit
          msg="commit $short_sha references plan-$token ($file) with unhandled Status=$status"
          if [ "$JSON_MODE" = "1" ]; then
            json_record "$short_sha" "$token" "$file" "FAIL" "$msg"
          else
            fail_msg "$msg"
          fi
          ;;
      esac
    else
      # MISS against corpus.
      if token_in_allowlist "$token"; then
        msg="commit $short_sha references external plan-$token (allowlisted as cross-repo)"
        if [ "$JSON_MODE" = "1" ]; then
          json_record "$short_sha" "$token" "" "WARN" "$msg"
        else
          warn_msg "$msg"
        fi
      else
        msg="commit $short_sha references plan-$token but no plan in corpus declares this token (and not in $ALLOWLIST_FILE)"
        if [ "$JSON_MODE" = "1" ]; then
          json_record "$short_sha" "$token" "" "FAIL" "$msg"
        else
          fail_msg "$msg"
        fi
      fi
    fi
  done < <(printf '%s' "$subject" | LC_ALL=C grep -oE "$PLAN_TOKEN_REGEX" || true)
done <<< "$COMMITS"

# Summary
if [ "$JSON_MODE" = "1" ]; then
  records_joined=""
  if [ "${#JSON_RECORDS[@]}" -gt 0 ]; then
    records_joined=$(printf '%s,' "${JSON_RECORDS[@]}")
    records_joined=${records_joined%,}
  fi
  printf '{"summary":{"total_commits":%d,"plan_refs":%d,"violations":%d,"warnings":%d},"records":[%s]}\n' \
    "$TOTAL_COMMITS" "$TOTAL_REFS" "$VIOLATIONS" "$WARNINGS" "$records_joined"
else
  echo ""
  echo "=== Plan Commit Drift Summary ==="
  echo "Commits scanned: $TOTAL_COMMITS"
  echo "Plan refs found: $TOTAL_REFS"
  if [ "$VIOLATIONS" -gt 0 ]; then
    echo -e "${RED}FAIL${NC}: $VIOLATIONS violation(s), $WARNINGS warning(s)"
    exit 1
  else
    echo -e "${GREEN}PASS${NC}: 0 violation(s), $WARNINGS warning(s)"
    exit 0
  fi
fi

if [ "$VIOLATIONS" -gt 0 ]; then
  exit 1
fi
exit 0

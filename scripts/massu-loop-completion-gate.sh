#!/usr/bin/env bash
# scripts/massu-loop-completion-gate.sh — L2 gate (CR-52). Asserts that the
# Phase 1.5 multi-perspective review actually wrote evidence to
# .massu/agent-results/ for the current plan-token before the loop can
# declare completion.
#
# Plan reference: plan-loop-multi-perspective-enforcement.
#
# Exit codes:
#   0 — PASS: >=1 valid evidence file exists for plan-token since loop start.
#   1 — FAIL: zero valid evidence files (either none found, or none with
#       mtime >= loop start when applicable).
#   2 — FAIL: input validation (missing / malformed plan-token argument).
#   3 — FAIL: candidate files exist but none match plan_token AND no
#       legacy-named files have mtime >= loop_start.
#
# Bypass: MASSU_SKIP_COMPLETION_GATE=1 forces exit 0 with stderr audit-trail.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root (mirrors loop-completion-helpers.sh).
# ---------------------------------------------------------------------------
if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
fi
cd "$REPO_ROOT"

# shellcheck source=./lib/plan-token-regex.sh
. "${REPO_ROOT}/scripts/lib/plan-token-regex.sh"
# shellcheck source=./lib/loop-completion-helpers.sh
. "${REPO_ROOT}/scripts/lib/loop-completion-helpers.sh"

# ---------------------------------------------------------------------------
# Argument validation (CR-52 exit code 2).
# ---------------------------------------------------------------------------
PLAN_TOKEN="${1:-}"

if [ -z "$PLAN_TOKEN" ]; then
  echo "massu-loop-completion-gate.sh: missing <plan-token> argument" >&2
  echo "Usage: $0 <plan-token>" >&2
  echo "Example: $0 plan-loop-multi-perspective-enforcement" >&2
  exit 2
fi

# Strict check (rejects newlines/whitespace/control chars; uses plain regex).
# Sourced from scripts/lib/loop-completion-helpers.sh (Phase 1.5 security
# review HIGH-3 fix).
if ! plan_token_strict_check "$PLAN_TOKEN"; then
  exit 2
fi

# ---------------------------------------------------------------------------
# Bypass (mirrors CR-48 pattern — audit-trail logged + durable persist).
# ---------------------------------------------------------------------------
if [ "${MASSU_SKIP_COMPLETION_GATE:-0}" = "1" ]; then
  bypass_msg="WARN: completion-gate bypassed by env override (plan-token=${PLAN_TOKEN}, session-id=${CLAUDE_SESSION_ID:-unknown}, ts=$(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "$bypass_msg" >&2
  # Durable audit-trail (Phase 1.5 security review MED-4 fix): append to log file
  # so the bypass is reviewable after terminal close. Best-effort: failures don't
  # block exit (parent dir may be read-only in CI sandboxes).
  audit_log="${REPO_ROOT}/.claude/loop-state/bypass-audit.log"
  mkdir -p "$(dirname "$audit_log")" 2>/dev/null || true
  echo "$bypass_msg" >> "$audit_log" 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Loop-start timestamp (consumed by mtime filter on legacy-named files).
# Falls back to 24h ago when no loop-start record exists, with stderr WARN.
# ---------------------------------------------------------------------------
LOOP_START=""
if ! LOOP_START="$(loop_start_read "$PLAN_TOKEN" 2>/dev/null)" || [ -z "$LOOP_START" ]; then
  if [ "${MASSU_SKIP_LOOP_START_CHECK:-0}" = "1" ]; then
    echo "WARN: no loop-start record for ${PLAN_TOKEN}; MASSU_SKIP_LOOP_START_CHECK=1 — accepting all evidence regardless of mtime" >&2
    LOOP_START=""
  else
    # Default fallback: 24h ago. Filters out ancient unrelated agent-result files.
    if date -u -v-1d +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
      LOOP_START="$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)"          # BSD date
    else
      LOOP_START="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)"  # GNU date
    fi
    echo "WARN: no loop-start record for ${PLAN_TOKEN}; falling back to 24h-ago mtime filter (LOOP_START=${LOOP_START}). Bypass: MASSU_SKIP_LOOP_START_CHECK=1" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Portability: use stat-mtime comparison (works on BSD and GNU). `find -newermt`
# is unreliable cross-platform (BSD `/usr/bin/find` rejects the `Z` suffix in
# ISO-8601-Z timestamps; bfs accepts it; GNU find accepts it). Stat-mtime is
# uniform.
# ---------------------------------------------------------------------------
LOOP_START_EPOCH=0
if [ -n "$LOOP_START" ]; then
  if date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LOOP_START" +%s >/dev/null 2>&1; then
    LOOP_START_EPOCH="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LOOP_START" +%s)"   # BSD
  elif date -d "$LOOP_START" +%s >/dev/null 2>&1; then
    LOOP_START_EPOCH="$(date -d "$LOOP_START" +%s)"                            # GNU
  else
    echo "WARN: LOOP_START='${LOOP_START}' not parseable by date; treating as epoch 0 (accept-all)" >&2
    LOOP_START_EPOCH=0
  fi
fi

# ---------------------------------------------------------------------------
# Scan .massu/agent-results/*.json for evidence.
# ---------------------------------------------------------------------------
RESULTS_DIR="${REPO_ROOT}/.massu/agent-results"

if [ ! -d "$RESULTS_DIR" ]; then
  echo "FAIL: ${RESULTS_DIR} does not exist — no agent-result files written for ${PLAN_TOKEN}" >&2
  exit 1
fi

VALID_REVIEWER_TYPES_REGEX='^(security|architecture|pattern|ux)$'

# jq is REQUIRED for body validation (Phase 1.5 security review HIGH-1 + HIGH-2
# fix). The previous grep/sed fallback could be exploited:
#   - sed returns FIRST match, jq returns LAST → divergence on duplicate keys.
#   - sed accepts non-JSON files containing a `"plan_token":"..."` substring.
# A jq dependency is acceptable: jq ships with macOS / Homebrew / apt and is
# already required by the changelog generator + pre-push hooks.
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required by the completion gate but is not installed. Install via 'brew install jq' (macOS) or 'apt-get install -y jq' (Linux). Bypass for non-jq envs: MASSU_SKIP_COMPLETION_GATE=1" >&2
  exit 1
fi

# Validate that a candidate JSON file:
#   - is parseable as JSON (jq -e)
#   - has plan_token EXACTLY equal to the gate's plan-token (jq selects the
#     last occurrence on duplicate keys, but jq -e . validates structure first
#     so duplicate-key files are still flagged as malformed by some jq builds;
#     in any case the body validation here is plan_token-exact-match)
#
# Returns 0 (file is valid evidence) or non-zero.
json_is_valid_evidence() {
  local file="$1"
  local expected_plan_token="$2"
  # Must parse as JSON.
  if ! jq -e . "$file" >/dev/null 2>&1; then
    return 1
  fi
  local body_token body_reviewer
  body_token="$(jq -r '.plan_token // ""' "$file" 2>/dev/null)"
  body_reviewer="$(jq -r '.reviewer_type // ""' "$file" 2>/dev/null)"
  if [ "$body_token" != "$expected_plan_token" ]; then
    return 2  # parses but plan_token mismatch
  fi
  if ! echo "$body_reviewer" | grep -qE "$VALID_REVIEWER_TYPES_REGEX"; then
    return 3  # plan_token matches but reviewer_type invalid
  fi
  return 0
}

# Light body-parse for LEGACY-named files: require jq-parseable JSON (no body
# field match — legacy bodies historically lack plan_token).
json_legacy_parses() {
  local file="$1"
  jq -e . "$file" >/dev/null 2>&1
}

# mtime comparison helpers.
file_mtime_epoch() {
  local file="$1"
  if stat -f %m "$file" >/dev/null 2>&1; then
    stat -f %m "$file"          # BSD
  else
    stat -c %Y "$file"          # GNU
  fi
}

file_mtime_newer_than_loop_start() {
  local file="$1"
  if [ -z "$LOOP_START" ] || [ "$LOOP_START_EPOCH" = "0" ]; then
    return 0  # No filter — accept.
  fi
  local mt
  mt="$(file_mtime_epoch "$file" 2>/dev/null || echo 0)"
  [ "$mt" -ge "$LOOP_START_EPOCH" ]
}

# Counters / signals.
VALID_NEW=0
VALID_LEGACY=0
SAW_NEW_NAMED_BUT_MISMATCHED=0

# Legacy-naming acceptance is GATED behind an env var (Phase 1.5 architecture
# review MED-F-ARCH-004 fix). Default: only NEW naming is accepted. Operators
# carrying forward old-style filenames must opt-in explicitly.
ACCEPT_LEGACY="${MASSU_ACCEPT_LEGACY_EVIDENCE:-0}"

# Enumerate candidate JSONs.
while IFS= read -r -d '' f; do
  fname="$(basename "$f")"

  # ---- (a) NEW convention: <plan-token>-post-impl-<reviewer-type>-*.json ----
  # Filename match is the cheap discriminator; body MUST validate via jq.
  if [ "${fname#*-post-impl-}" != "$fname" ]; then
    # Extract reviewer-type segment: <plan-token>-post-impl-<TYPE>-<iso>.json
    # Strip everything through "post-impl-", then strip from the next "-" onward.
    after_postimpl="${fname#*-post-impl-}"
    reviewer_type_in_name="${after_postimpl%%-*}"

    if echo "$reviewer_type_in_name" | grep -qE "$VALID_REVIEWER_TYPES_REGEX"; then
      # Capture function return without tripping `set -e`.
      rc=0
      json_is_valid_evidence "$f" "$PLAN_TOKEN" || rc=$?
      case "$rc" in
        0) VALID_NEW=$((VALID_NEW + 1)); continue ;;
        1) echo "WARN: malformed-JSON candidate file ${f} — skipping" >&2 ;;
        2|3) SAW_NEW_NAMED_BUT_MISMATCHED=1 ;;
      esac
    fi
  fi

  # ---- (b) LEGACY convention: *-{security,architecture,pattern,ux}.json ----
  # Filename match + mtime >= loop_start + valid JSON body. Body does NOT need
  # plan_token (legacy). Gated behind MASSU_ACCEPT_LEGACY_EVIDENCE=1 by default
  # OFF (Phase 1.5 architecture review MED-F-ARCH-004 fix).
  if [ "$ACCEPT_LEGACY" = "1" ]; then
    case "$fname" in
      *-security.json|*-architecture.json|*-pattern.json|*-ux.json)
        if file_mtime_newer_than_loop_start "$f"; then
          if json_legacy_parses "$f"; then
            echo "WARN: accepting legacy-named evidence file ${f} via MASSU_ACCEPT_LEGACY_EVIDENCE=1 (filename+mtime+parseable-JSON, no plan_token check). Upgrade reviewers to NEW naming convention: <plan-token>-post-impl-<reviewer-type>-<iso>.json" >&2
            VALID_LEGACY=$((VALID_LEGACY + 1))
            continue
          else
            echo "WARN: rejecting legacy-named candidate ${f} — not parseable as JSON (Phase 1.5 pattern review LOW-4 fix)" >&2
          fi
        fi
        ;;
    esac
  fi
done < <(find "$RESULTS_DIR" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null)

TOTAL_VALID=$((VALID_NEW + VALID_LEGACY))

# ---------------------------------------------------------------------------
# Decision.
# ---------------------------------------------------------------------------
if [ "$TOTAL_VALID" -ge 1 ]; then
  echo "PASS: ≥1 valid evidence file found (new=${VALID_NEW}, legacy=${VALID_LEGACY}) for ${PLAN_TOKEN}"
  exit 0
fi

if [ "$SAW_NEW_NAMED_BUT_MISMATCHED" = "1" ]; then
  echo "FAIL: candidate evidence files exist under <something>-post-impl-* but none match plan_token=${PLAN_TOKEN}; legacy-named files (if any) all predate loop_start=${LOOP_START}" >&2
  exit 3
fi

echo "FAIL: zero evidence files for ${PLAN_TOKEN} (loop_start=${LOOP_START:-<none>}). Spawn at least one named reviewer subagent (massu-security-reviewer / massu-architecture-reviewer / massu-pattern-reviewer / massu-ux-reviewer) and ensure each writes JSON to .massu/agent-results/${PLAN_TOKEN}-post-impl-<reviewer-type>-<iso>.json. Bypass: MASSU_SKIP_COMPLETION_GATE=1" >&2
exit 1

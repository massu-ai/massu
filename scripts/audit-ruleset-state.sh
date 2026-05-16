#!/usr/bin/env bash
# scripts/audit-ruleset-state.sh
#
# Layer 4 of plan-rulesets-as-code: diffs the live GitHub Ruleset state
# against the committed JSON at .github/rulesets/main-branch.json.
# Exits 0 on no drift, 1 on any drift.
#
# Invoked by:
#   - .github/workflows/branch-protection-audit.yml (daily cron, GitHub-side)
#   - Operator (local, with GH_TOKEN exported)
#
# Reference: docs/plans/2026-05-15-rulesets-as-code.md §3 Layer 4

set -euo pipefail

RULESET_FILE="${RULESET_FILE:-.github/rulesets/main-branch.json}"
# In GitHub Actions, github.repository is the repo path; locally pass --repo or
# set GITHUB_REPOSITORY explicitly (gh CLI also honors `gh repo set-default`).
REPO="${GITHUB_REPOSITORY:-${GH_REPO:-}}"

if [ -z "$REPO" ]; then
  # Fall back to gh's currently configured repo (e.g., for local runs).
  if command -v gh >/dev/null 2>&1; then
    REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
  fi
fi

if [ -z "$REPO" ]; then
  echo "::error::Could not determine repo (set GITHUB_REPOSITORY or GH_REPO, or run with gh's default repo set)"
  exit 1
fi

if [ ! -f "$RULESET_FILE" ]; then
  echo "::error::$RULESET_FILE does not exist"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required but not installed"
  exit 1
fi

RULESET_NAME=$(jq -r '.name' "$RULESET_FILE")
if [ -z "$RULESET_NAME" ] || [ "$RULESET_NAME" = "null" ]; then
  echo "::error::$RULESET_FILE missing .name"
  exit 1
fi

echo "Auditing ruleset '$RULESET_NAME' on $REPO"

LIVE=$(mktemp)
COMMITTED=$(mktemp)
LIVE_NORM=$(mktemp)
COMMITTED_NORM=$(mktemp)
trap 'rm -f "$LIVE" "$COMMITTED" "$LIVE_NORM" "$COMMITTED_NORM"' EXIT INT TERM

# Fetch live ruleset by name. RULESET_NAME passed via jq --arg (NOT shell-
# interpolated into the filter) to remove the jq-injection class
# (security-review MED-1). Two-step gh api | jq pipeline because
# `gh api --jq` does not accept --arg.
RULESET_ID=$(gh api "repos/$REPO/rulesets" \
  | jq --arg name "$RULESET_NAME" -r '.[] | select(.name==$name) | .id' || true)

if [ -z "$RULESET_ID" ]; then
  echo "::error::No live ruleset named '$RULESET_NAME' on $REPO. Run apply-ruleset.yml to create."
  exit 1
fi

# Fetch the full ruleset detail (the list endpoint omits `rules`).
gh api "repos/$REPO/rulesets/$RULESET_ID" > "$LIVE"
cp "$RULESET_FILE" "$COMMITTED"

# Normalize both sides:
#   - Strip server-only fields that legitimately differ between API response
#     and committed JSON. Stripped at ANY nesting depth via recursive jq.
#     Includes:
#       - top-level: id, node_id, _links, created_at, updated_at,
#         source_type, source, current_user_can_bypass, links, enforcement_actor
#       - nested in rules[*]: rule_id, _links, ruleset_id, ruleset_source_type
#         (the rules[*] keys appeared in GitHub's API circa 2024-2025; safe to
#         strip even if a given response omits them)
#   - Recursively sort keys.
# DO NOT strip actor_id / bypass_mode / actor_type — those ARE part of the
# request body and must match the committed JSON.
SERVER_ONLY_FIELDS='["id","node_id","_links","links","created_at","updated_at","source_type","source","current_user_can_bypass","enforcement_actor","rule_id","ruleset_id","ruleset_source_type"]'

jq --argjson drop "$SERVER_ONLY_FIELDS" '
  def strip_keys($drop):
    if type == "object" then
      with_entries(select(.key as $k | ($drop | index($k)) | not))
      | with_entries(.value |= strip_keys($drop))
    elif type == "array" then
      map(strip_keys($drop))
    else
      .
    end;
  strip_keys($drop)
' "$LIVE" | jq --sort-keys . > "$LIVE_NORM"

jq --argjson drop "$SERVER_ONLY_FIELDS" '
  def strip_keys($drop):
    if type == "object" then
      with_entries(select(.key as $k | ($drop | index($k)) | not))
      | with_entries(.value |= strip_keys($drop))
    elif type == "array" then
      map(strip_keys($drop))
    else
      .
    end;
  strip_keys($drop)
' "$COMMITTED" | jq --sort-keys . > "$COMMITTED_NORM"

if diff -u "$COMMITTED_NORM" "$LIVE_NORM"; then
  echo "PASS: live ruleset matches committed JSON ($RULESET_FILE)"
  exit 0
else
  echo ""
  echo "::error::DRIFT DETECTED — live ruleset state on $REPO does not match $RULESET_FILE"
  echo "::error::Diff above shows <committed >live"
  echo "::error::Either revert the UI-side edit OR commit the change to $RULESET_FILE and let apply-ruleset.yml reconcile"
  exit 1
fi

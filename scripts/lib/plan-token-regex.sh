#!/usr/bin/env bash
# scripts/lib/plan-token-regex.sh — single source of truth for the plan-token
# commit-subject regex.
#
# Used by:
#   - scripts/massu-plan-commit-drift.sh (commit-drift scanner, sourced via P-A-002)
#   - scripts/massu-changelog-coverage.sh (pre-tag changelog gate)
#   - packages/core/src/changelog-generator.ts (release-boundary generator, via TS shim)
#
# Plan reference: plan-1.9.0-plan-token-aware-changelog-batcher (CR-46 consolidation —
# eliminates N+1 parser drift).
#
# Source this file from any bash script that needs to extract plan-tokens from
# `git log --pretty=format:%s` output. It exports `PLAN_TOKEN_REGEX` and
# `extract_plan_tokens_from_range`.

# Plan-token regex. Matches Conventional-Commits-style subject prefix
# `<type>(plan-<token>)` where:
#   <type>  ∈ {feat, fix, chore, docs}
#   <token> ∈ [a-z0-9._-]+
#
# This regex MUST stay aligned with the live regex in
# scripts/massu-plan-commit-drift.sh:260 (which still uses the same pattern via
# `LC_ALL=C grep -oE` for backwards compatibility).
#
# IMPORTANT: This is the BRE-friendly form (uses parentheses for grouping which
# `grep -E` and `awk` honor). Do NOT add `^` here — callers anchor as needed.
export PLAN_TOKEN_REGEX='(feat|fix|chore|docs)\(plan-[a-z0-9._-]+\)'

# Plain plan-token regex — the bare `plan-<slug>` form (no surrounding type-paren
# wrapper). Used for plan-file `**Plan Token**:` line extraction and for CLI args
# accepted by scripts/massu-loop-completion-gate.sh.
#
# Plan reference: plan-loop-multi-perspective-enforcement (CR-46 consolidation —
# the gate script and helpers source THIS file rather than redefining their own
# pattern). Note: this is the gate-context regex; commit-subject contexts still
# use PLAN_TOKEN_REGEX above. The two serve different parsing surfaces.
#
# Consumers:
#   - scripts/massu-loop-completion-gate.sh (CLI arg validation)
#   - scripts/lib/loop-completion-helpers.sh:loop_token_from_plan_path
#
# Hardening (Phase 1.5 security review HIGH-3, LOW-5):
#   - First char after `plan-` MUST be [a-z0-9] (rejects `plan-.`, `plan-..`).
#   - Last char MUST be [a-z0-9] (rejects `plan-foo.`, trailing separators).
#   - Inner chars allow [a-z0-9._-] for compatibility with existing tokens.
#   - The grep -E `^...$` anchors are line-anchored — callers MUST validate
#     "no newline characters" separately when the token comes from untrusted
#     input. See plan_token_strict_check() in loop-completion-helpers.sh.
export PLAIN_PLAN_TOKEN_REGEX='^plan-[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'

# extract_plan_tokens_from_range <git-range>
#
# Reads commit subjects in the given git range and emits unique plan-tokens
# (one per line, sorted, deduplicated). The leading `plan-` prefix is INCLUDED
# in the output (matches downstream consumers that expect e.g. `plan-1.9.0-...`).
#
# Usage:
#   tokens=$(extract_plan_tokens_from_range "v1.8.0..HEAD")
#   tokens=$(extract_plan_tokens_from_range "$(git describe --tags --abbrev=0)..HEAD")
#
# Returns 0 even when no tokens are found (empty stdout is the empty-set signal).
extract_plan_tokens_from_range() {
  local range="$1"
  if [ -z "$range" ]; then
    echo "extract_plan_tokens_from_range: missing git-range argument" >&2
    return 2
  fi
  # %s prints the subject line for each commit.
  # `grep -oE` extracts the full `<type>(plan-<token>)` match.
  # `sed` strips `<type>(` prefix and `)` suffix, leaving `plan-<token>`.
  # `sort -u` deduplicates.
  LC_ALL=C git log "$range" --pretty=format:'%s' 2>/dev/null \
    | LC_ALL=C grep -oE "$PLAN_TOKEN_REGEX" \
    | LC_ALL=C sed -E 's/^(feat|fix|chore|docs)\(//; s/\)$//' \
    | LC_ALL=C sort -u
}

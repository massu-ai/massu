#!/usr/bin/env bash
# massu-public-leak-guard — public-repo leak enforcer (path + content scan).
#
# Purpose: this is the PUBLIC repo (github.com/massu-ai/massu, visibility=PUBLIC).
# Per the manifest at scripts/PUBLIC_MANIFEST.md in the internal repo
# (massu-internal; a copy is embedded below for portability), only specific paths are allowed
# to be committed. Any commit touching paths OUTSIDE the allowlist is REJECTED
# with an explanatory error message. Layered with content scans for trade-
# secret markers, internal doc cross-references, and customer-name leaks.
#
# Modes (set via env var MASSU_LEAK_GUARD_MODE — default `staged`):
#   staged → scan only staged files (git diff --cached) and the diff-additions.
#            Used by the pre-commit hook AND by the per-commit CI loop in
#            .github/workflows/leak-guard.yml — both want "what is this
#            commit ADDING".
#   tree   → scan ALL tracked files (git ls-files) against the FULL file
#            content. Used by .github/workflows/leak-guard-retro.yml to
#            catch HISTORICAL leaks that pre-date the per-commit gate.
#            Closes the gap discovered 2026-05-07 when the pre-commit gate
#            was found to silently grandfather pre-existing tree state.
#
# History:
#   2026-05-06 c3ba48a — initial pre-commit allowlist enforcer.
#   2026-05-06 cdd74b6 — 6-layer enterprise leak defense (CI, content scan,
#                        auto-install, CLAUDE.md banner).
#   2026-05-07          — dual-mode refactor (staged|tree). The full-tree
#                        retro mode catches the failure class that the
#                        per-commit-only gate was unable to detect:
#                        historical content already in the tree.
#
# Bypass: --no-verify will skip this. The CI workflows on the same script
# CANNOT be bypassed without admin override of branch protection.
#
# Update path: when the manifest changes, sync the ALLOWED_PATTERNS,
# DENIED_PATTERNS, and CONTENT_PATTERNS below. Future improvement: read
# the patterns directly from PUBLIC_MANIFEST.md (requires the public repo
# to know where the internal repo lives, which it shouldn't).

set -euo pipefail

MODE="${MASSU_LEAK_GUARD_MODE:-staged}"
case "$MODE" in
  staged|tree) ;;
  commit)
    # Per-commit scan mode for CI workflows (`.github/workflows/leak-guard.yml`).
    # Requires MASSU_LEAK_GUARD_SHA to identify the commit. File list =
    # `git diff-tree $SHA~1 $SHA --diff-filter=ACMR`; content reader =
    # `git show $SHA:$path`. Replaces the prior staged-mode CI invocation
    # which had a HEAD-comparison bug (see synthetic-leak-test PR
    # massu-ai/massu#2 / runs 25621197800 false-PASS vs 25621197769 +
    # 25621197780 correct FAIL). Added 2026-05-10.
    if [ -z "${MASSU_LEAK_GUARD_SHA:-}" ]; then
      echo "ERROR: MASSU_LEAK_GUARD_MODE=commit requires MASSU_LEAK_GUARD_SHA" >&2
      exit 2
    fi
    ;;
  *) echo "ERROR: invalid MASSU_LEAK_GUARD_MODE=$MODE (expected 'staged', 'tree', or 'commit')" >&2; exit 2 ;;
esac

# Per PUBLIC_MANIFEST.md sections "Directories", "Root Files", ".public Variant",
# ".claude Files". Each entry is a regex matching git diff path output.
ALLOWED_PATTERNS=(
  # Directories (full sync)
  '^packages/core/'
  '^packages/adapter-rails/'
  '^packages/adapter-spring/'
  # P-E-025 follow-on: @massu/types is now a public npm package; sync-public.sh
  # PUBLIC_DIRS includes it. ALLOWED_PATTERNS must match.
  '^packages/types/'
  # P-DG-001 (plan-stage-d-medium-sweep): custom ESLint rule lives in repo-root
  # eslint-rules/ and is sync'd to public via sync-public.sh PUBLIC_DIRS.
  '^eslint-rules/'
  '^examples/'
  '^scripts/'
  '^docs/getting-started/'
  '^docs/features/'
  '^docs/commands/'
  '^docs/guides/'
  '^docs/hooks/'
  '^docs/reference/'
  # Root files
  '^package-lock\.json$'
  '^package\.json$'
  '^massu\.config\.yaml$'
  '^CHANGELOG\.md$'
  '^LICENSE$'
  '^CLA\.md$'
  '^CONTRIBUTING\.md$'
  '^README\.md$'
  '^\.gitignore$'
  # .claude — settings + hooks (compiled). Plus CLAUDE.md (the synced
  # destination of CLAUDE.public.md, per manifest). NOT
  # .claude/commands/ (those are sync'd from internal too but the
  # manifest enumerates each public command — we don't allow free-form
  # additions to .claude/commands/ via this hook).
  '^\.claude/settings\.json$'
  '^\.claude/hooks/'
  '^\.claude/CLAUDE\.md$'
  '^\.claude/commands/'
  # CI (when added)
  '^\.github/workflows/'
  # Rulesets (plan-rulesets-as-code P-A-002 / P-C-005 — main-branch.json
  # synced from internal main-branch.public.json via sync-public.sh
  # `.public.<ext>` rename pattern).
  '^\.github/rulesets/'
)

# Explicitly DENIED — these are the paths that leaked. Belt-and-suspenders.
DENIED_PATTERNS=(
  '^docs/internal/'
  '^docs/strategy/'
  '^docs/security/'
  '^docs/plans/'
  '^docs/reports/'
  '^docs/incidents/'
  '^docs/TRADE-SECRET'
  '^reports/'
  '^website/'
  '^\.vercel/'
  '^docker-compose\.yml$'
  '^Dockerfile$'
  '^package\.public\.json$'
  '^README\.public\.md$'
  '^\.gitignore\.public$'
  '^\.claude/CLAUDE\.public\.md$'
  '^\.claude/commands/massu-internal-'
  '^\.github/workflows/sync-check\.yml$'
)

# ----- mode-dependent file-list discovery -----
get_file_list() {
  case "$MODE" in
    staged)
      git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true
      ;;
    commit)
      # Files added/modified/renamed in $SHA vs its parent. Handles root commit
      # via empty-tree fallback (4b825dc... is the SHA of the empty tree).
      local parent
      parent=$(git rev-parse "$MASSU_LEAK_GUARD_SHA^" 2>/dev/null || echo "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
      git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r "$parent" "$MASSU_LEAK_GUARD_SHA" 2>/dev/null || true
      ;;
    tree)
      git ls-files 2>/dev/null || true
      ;;
  esac
}

# ----- mode-dependent content reader -----
# In staged mode: the full content of the file as it exists in the index
# (about-to-be-committed state). In tree mode: the full current file contents.
#
# Why full content not just added lines: we want to catch a content trigger
# regardless of whether it was just-added or was already present in a file
# being modified for an unrelated reason. The previous implementation
# `git diff --cached <path> | grep '^+'` had a subtle bug — when the CI
# workflow at `.github/workflows/leak-guard.yml` set GIT_INDEX_FILE to a
# specific commit's tree via `git read-tree $sha`, `git diff --cached` then
# compared that index against HEAD (which actions/checkout@v4 set to the
# PR merge commit, equal to $sha). The diff was empty → the grep matched
# nothing → false PASS on PR #2 (synthetic-leak-test 2026-05-09; runs
# 25621197800 PASS vs 25621197769/25621197780 FAIL on the same trigger).
# Using `git show :$path` reads from the index directly without HEAD
# comparison, so the reader returns actual content regardless of CI vs
# local-pre-commit context.
#
# `|| true` suffix on each branch prevents non-zero exit codes (grep
# no-match, missing file) from tripping `set -e` and silently killing the
# scan mid-loop on empty files (e.g. an empty Python __init__.py).
get_file_content() {
  local path="$1"
  case "$MODE" in
    staged)
      git show ":$path" 2>/dev/null || true
      ;;
    commit)
      git show "$MASSU_LEAK_GUARD_SHA:$path" 2>/dev/null || true
      ;;
    tree)
      cat "$path" 2>/dev/null || true
      ;;
  esac
}

FILE_LIST=$(get_file_list)
if [ -z "$FILE_LIST" ]; then
  exit 0
fi

violations=()
denied_violations=()

while IFS= read -r path; do
  [ -z "$path" ] && continue

  # Check denied first (more specific signal)
  for pat in "${DENIED_PATTERNS[@]}"; do
    if [[ "$path" =~ $pat ]]; then
      denied_violations+=("$path  (matched DENIED pattern: $pat)")
      continue 2
    fi
  done

  # Then check allowed
  matched=0
  for pat in "${ALLOWED_PATTERNS[@]}"; do
    if [[ "$path" =~ $pat ]]; then
      matched=1
      break
    fi
  done

  if [ "$matched" -eq 0 ]; then
    violations+=("$path  (not in allowlist)")
  fi
done <<< "$FILE_LIST"

# ============================================================
# Content-based scan
# ============================================================
#
# Path-based allowlist catches "wrong directory" leaks. Content scan
# catches the harder case: a legitimate path (e.g. packages/core/src/foo.ts)
# accidentally containing a trade-secret comment, customer name, internal
# project codename, etc.
#
# CONTENT_PATTERNS + CONTENT_SCAN_SELF_REFERENCE_FILES_PUBLIC_REPO are
# sourced from scripts/lib/leak-patterns.sh (plan-public-content-leak-guard
# CR-49 / P-A-001 + P-A-002) — single source of truth shared with
# scripts/massu-website-content-leak-guard.sh. Adding a new pattern or
# allowlist entry: edit scripts/lib/leak-patterns.sh, not this file.

source "$(dirname "$0")/lib/leak-patterns.sh"

# CONTENT_SCAN_SELF_REFERENCE_FILES_PUBLIC_REPO is sourced from
# scripts/lib/leak-patterns.sh above (plan-public-content-leak-guard
# P-A-002). To add a new self-reference allowlist entry, edit that file.

is_self_reference_file() {
  local path="$1"
  for self in "${CONTENT_SCAN_SELF_REFERENCE_FILES_PUBLIC_REPO[@]}"; do
    if [ "$path" = "$self" ]; then
      return 0
    fi
  done
  return 1
}

content_violations=()
while IFS= read -r path; do
  [ -z "$path" ] && continue
  # Skip self-reference files (the guard script itself, the CI workflows,
  # and CLAUDE.md all need to enumerate the patterns).
  if is_self_reference_file "$path"; then
    continue
  fi
  # Only scan text files. In tree mode, the file must exist on disk; in
  # staged mode, fall back gracefully if the staged path lacks a working-
  # tree counterpart (e.g. mid-rebase).
  if [ -e "$path" ]; then
    # here-string capture, not `file … | grep -q` (broken-pipe-race-free under pipefail; incident 2026-07-16).
    file_type_desc="$(file "$path" 2>/dev/null)"
    if ! grep -qE 'text|empty' <<<"$file_type_desc"; then
      continue
    fi
  fi
  content=$(get_file_content "$path")
  pat_idx=0
  for pat in "${CONTENT_PATTERNS[@]}"; do
    pat_idx=$((pat_idx + 1))
    # -n so we can report a LOCATION instead of the matched text (see below).
    matches=$(echo "$content" | grep -nEi "$pat" | grep -vE 'leak-guard-allow:' || true)
    if [ -n "$matches" ]; then
      if [ -n "${GITHUB_ACTIONS:-}" ]; then
        # ─── P7-1: in public CI, the detector must not republish what it detects ───
        # This guard runs in leak-guard.yml, leak-guard-retro.yml and
        # leak-guard-scheduled.yml, whose logs are world-readable on a public
        # repo. Two of those run `tree` mode over EVERY tracked file, so a hit
        # used to dump up to 100 characters of the matching line — plus the
        # pattern that found it — into a public log. A leak detector that
        # publishes the leak on detection converts a private finding into a
        # public one at the exact moment it fires, and the retro/scheduled
        # workflows do it unattended.
        #
        # A maintainer with repo access can reproduce the full context locally
        # by running this script without GITHUB_ACTIONS set; nothing is lost
        # except the broadcast.
        first_line_no="${matches%%:*}"
        content_violations+=("$path:${first_line_no}  (signature CP-$(printf '%02d' "$pat_idx"))  [content redacted in CI — P7-1]")
      else
        # Local/maintainer context: the matched text is the whole point.
        first_line=$(echo "$matches" | head -1 | cut -c1-100)
        content_violations+=("$path  (matched: $pat)  -> ${first_line}")
      fi
    fi
  done
done <<< "$FILE_LIST"

if [ ${#denied_violations[@]} -gt 0 ] || [ ${#violations[@]} -gt 0 ] || [ ${#content_violations[@]} -gt 0 ]; then
  echo ""
  echo "============================================================" >&2
  echo "  BLOCKED: massu public repo leak guard ($MODE mode)" >&2
  echo "============================================================" >&2
  echo "" >&2
  echo "  This is the PUBLIC repo (github.com/massu-ai/massu)." >&2
  if [ "$MODE" = "staged" ]; then
    echo "  The following staged paths are not allowed to be public:" >&2
  else
    echo "  Historical tree state contains paths/content not allowed in public:" >&2
  fi
  echo "" >&2

  if [ ${#denied_violations[@]} -gt 0 ]; then
    echo "  EXPLICITLY DENIED (these paths exist for internal-only purposes):" >&2
    for v in "${denied_violations[@]}"; do
      echo "    - $v" >&2
    done
    echo "" >&2
  fi

  if [ ${#violations[@]} -gt 0 ]; then
    echo "  NOT IN ALLOWLIST (per PUBLIC_MANIFEST.md):" >&2
    for v in "${violations[@]}"; do
      echo "    - $v" >&2
    done
    echo "" >&2
  fi

  if [ ${#content_violations[@]} -gt 0 ]; then
    echo "  CONTENT SCAN MATCHED (path is allowed but content contains" >&2
    echo "  a leak-pattern marker — TRADE-SECRET / CONFIDENTIAL / etc.):" >&2
    for v in "${content_violations[@]}"; do
      echo "    - $v" >&2
    done
    echo "" >&2
    echo "  To intentionally allow a content match (e.g. a code comment" >&2
    echo "  legitimately referencing the word \"confidential\" in" >&2
    echo "  documentation), add this trailer to the same line:" >&2
    echo "    # leak-guard-allow: <one-sentence justification>" >&2
    echo "" >&2
  fi

  echo "  What to do:" >&2
  echo "    1. If this work belongs in the INTERNAL repo, commit it" >&2
  echo "       in your internal massu-internal checkout instead of here." >&2
  echo "    2. If this work belongs in PUBLIC and the path should be" >&2
  echo "       allowed, update PUBLIC_MANIFEST.md and the allowlist in" >&2
  echo "       scripts/massu-public-leak-guard.sh together — they MUST" >&2
  echo "       stay in sync." >&2
  echo "    3. Bypassing this with --no-verify is a security incident." >&2
  echo "       Do not." >&2
  echo "" >&2
  echo "  History context: this guard was added 2026-05-06 after a" >&2
  echo "  9-day leak of docs/internal/ + reports/gap-analysis/ to the" >&2
  echo "  public repo (commit 9548ca3 onward, purged 2026-05-06). The" >&2
  echo "  full-tree retro mode was added 2026-05-07 to close the" >&2
  echo "  historical-content gap discovered after the initial pre-commit" >&2
  echo "  gate let pre-guard commits persist undetected." >&2
  echo "============================================================" >&2
  echo "" >&2
  exit 1
fi

exit 0

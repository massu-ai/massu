#!/usr/bin/env bash
# massu-public-leak-guard — public-repo leak enforcer (path + content scan).
#
# Purpose: this is the PUBLIC repo (github.com/massu-ai/massu, visibility=PUBLIC).
# Per the manifest at /Users/operator/massu-internal/scripts/PUBLIC_MANIFEST.md
# (and a copy embedded below for portability), only specific paths are allowed
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
  '^packages/adapter-phoenix/'
  '^packages/adapter-aspnet/'
  '^packages/adapter-spring/'
  '^packages/adapter-go-chi/'
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
# Each pattern below is ERE-compatible. To add a new denied pattern,
# append a line. Patterns are case-insensitive (egrep -i). False
# positives can be silenced by inserting a `# leak-guard-allow: <reason>`
# comment on the same line as the match.

CONTENT_PATTERNS=(
  # Internal project markers
  'TRADE[ -]?SECRET'
  'CONFIDENTIAL'
  'INTERNAL[ -]?ONLY'
  'NOT[ -]FOR[ -]PUBLIC'
  'DO[ -]NOT[ -]SHIP'
  'PROPRIETARY'
  # Internal-doc references the manifest forbids
  'docs/internal/'
  'docs/strategy/'
  'docs/security/'
  'docs/incidents/'
  'reports/gap-analysis/'
  # Internal-only command prefix
  'massu-internal-'
  # User-machine paths (a leaked /Users/operator/... discloses the
  # contributor username + local layout)
  '/Users/operator/'
  # Customer / downstream-consumer name leaks. `example-project` is a private
  # trading project that was the original test bed for many massu
  # features — its name should NEVER appear in public source. Word-
  # boundary anchors avoid false positives like "hedged" or "hedgehog".
  '\bhedge\b'
  '\bexample_svc\b'
  '\bexample-svc\b'
  '\bexample-api\b'
)

# Files that DEFINE or DOCUMENT the leak-guard patterns themselves —
# these legitimately need to mention the strings without triggering.
# Adding paths here is a structural choice, not an escape hatch — these
# are the files whose JOB it is to enumerate the patterns. Any other
# legitimate-looking content match should use the per-line
# `# leak-guard-allow:` trailer instead.
CONTENT_SCAN_SELF_REFERENCE_FILES=(
  # Guard infrastructure — these enumerate the patterns by definition.
  'scripts/massu-public-leak-guard.sh'
  'scripts/install-hooks.sh'
  '.github/workflows/leak-guard.yml'
  '.github/workflows/leak-guard-retro.yml'
  '.github/workflows/leak-guard-source-of-truth.yml'
  '.github/workflows/leak-guard-scheduled.yml'
  '.claude/CLAUDE.md'
  # Workflow / command boundary documentation — their JOB is to point
  # users at private workflows when public ones don't apply, OR to
  # document a user-side path convention (e.g. reports/gap-analysis/
  # where the user saves THEIR own gap reports, not where massu-
  # internal stores them).
  'docs/features/workflow-commands.mdx'
  '.claude/commands/massu-gap-enhancement-analyzer.md'
  '.claude/commands/massu-refactor.md'
  'packages/core/commands/massu-gap-enhancement-analyzer.md'
  'packages/core/commands/massu-refactor.md'
  # Code whose contract IS the user-side path (the incident-pipeline
  # hook fires on writes to the user's docs/incidents/ directory; that
  # path is part of the public API, not an internal secret).
  'packages/core/src/hooks/incident-pipeline.ts'
  # Internal-command-aware scanners — their comments enumerate
  # known internal command filenames as part of their pattern catalog.
  'scripts/massu-generalization-scanner.sh'
  'scripts/massu-security-scanner.sh'
  # Release documentation — CHANGELOG.md legitimately enumerates the
  # `massu-internal-*` exclusion convention as part of release notes
  # describing what slash commands are shipped publicly. Public-facing
  # documentation MUST be able to disclose the public/internal split.
  # (plan-1.7.0-cohesive-cleanup P-A-005)
  'CHANGELOG.md'
  # CLI Reference doc legitimately enumerates the `massu-internal-`
  # exclusion convention as part of explaining the 59 external slash
  # commands ship publicly and internal ones are operator-only.
  'docs/reference/cli-reference.mdx'
  # Leak-guard test fixtures + their test file — these intentionally
  # contain the trigger patterns to validate the guard catches them.
  # Adding them here lets the public-sync verifier accept the test
  # corpus while preserving real-content blocking.
  # (plan-leak-guard-range-mode-verify Stage B+C fixtures)
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-leak.md'
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-mixed.md'
  'packages/core/src/__tests__/fixtures/leak-guard-commit-mode/expected-clean.md'
  'packages/core/src/__tests__/leak-guard-commit-mode.test.ts'
)

is_self_reference_file() {
  local path="$1"
  for self in "${CONTENT_SCAN_SELF_REFERENCE_FILES[@]}"; do
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
    if ! file "$path" 2>/dev/null | grep -qE 'text|empty'; then
      continue
    fi
  fi
  content=$(get_file_content "$path")
  for pat in "${CONTENT_PATTERNS[@]}"; do
    matches=$(echo "$content" | grep -Ei "$pat" | grep -vE 'leak-guard-allow:' || true)
    if [ -n "$matches" ]; then
      first_line=$(echo "$matches" | head -1 | cut -c1-100)
      content_violations+=("$path  (matched: $pat)  -> ${first_line}")
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
  echo "       at /Users/operator/massu-internal/ instead of here." >&2
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

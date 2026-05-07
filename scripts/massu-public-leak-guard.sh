#!/usr/bin/env bash
# massu-public-leak-guard — pre-commit allowlist enforcer.
#
# Purpose: this is the PUBLIC repo (github.com/massu-ai/massu, visibility=PUBLIC).
# Per the manifest at /Users/operator/massu-internal/scripts/PUBLIC_MANIFEST.md
# (and a copy embedded below for portability), only specific paths are allowed
# to be committed. Any commit touching paths OUTSIDE the allowlist is REJECTED
# with an explanatory error message.
#
# History: created 2026-05-06 in response to a 9-day leak of internal-only
# specs/audits (commit 9548ca3 etc.) that committed `docs/internal/` and
# `reports/` directly to the public repo, bypassing the documented
# internal-first sync model. The manifest was policy without enforcement;
# this script makes it enforcement.
#
# Bypass: --no-verify will skip this. Don't.
#
# Update path: when the manifest changes, sync the ALLOWED_PREFIXES below.
# Future improvement: read directly from the manifest file (requires the
# public repo to know where the internal repo lives, which it shouldn't).

set -euo pipefail

# Per PUBLIC_MANIFEST.md sections "Directories", "Root Files", ".public Variant",
# ".claude Files". Each entry is a regex matching git diff path output.
ALLOWED_PATTERNS=(
  # Directories (full sync)
  '^packages/core/'
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

# Get list of staged files (added/modified/renamed; not deletions).
STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
if [ -z "$STAGED" ]; then
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
done <<< "$STAGED"

# ============================================================
# Content-based scan — Layer 5 of the enterprise leak defense
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
)

# Files that DEFINE or DOCUMENT the leak-guard patterns themselves —
# these legitimately need to mention the strings without triggering.
# Adding paths here is a structural choice, not an escape hatch — these
# are the files whose JOB it is to enumerate the patterns. Any other
# legitimate-looking content match should use the per-line
# `# leak-guard-allow:` trailer instead.
CONTENT_SCAN_SELF_REFERENCE_FILES=(
  'scripts/massu-public-leak-guard.sh'
  'scripts/install-hooks.sh'
  '.github/workflows/leak-guard.yml'
  '.claude/CLAUDE.md'
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
  # Skip self-reference files (the guard script itself, the CI workflow,
  # and CLAUDE.md all need to enumerate the patterns).
  if is_self_reference_file "$path"; then
    continue
  fi
  # Only scan text files we just staged.
  if ! file "$path" 2>/dev/null | grep -qE 'text|empty'; then
    continue
  fi
  for pat in "${CONTENT_PATTERNS[@]}"; do
    # Look for the pattern in the staged version (not working tree)
    matches=$(git diff --cached "$path" | grep -E '^\+' | grep -Ei "$pat" | grep -vE 'leak-guard-allow:' || true)
    if [ -n "$matches" ]; then
      first_line=$(echo "$matches" | head -1 | cut -c1-100)
      content_violations+=("$path  (matched: $pat)  -> ${first_line}")
    fi
  done
done <<< "$STAGED"

if [ ${#denied_violations[@]} -gt 0 ] || [ ${#violations[@]} -gt 0 ] || [ ${#content_violations[@]} -gt 0 ]; then
  echo ""
  echo "============================================================" >&2
  echo "  BLOCKED: massu public repo leak guard" >&2
  echo "============================================================" >&2
  echo "" >&2
  echo "  This is the PUBLIC repo (github.com/massu-ai/massu)." >&2
  echo "  The following staged paths are not allowed to be public:" >&2
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
  echo "  public repo (commit 9548ca3 onward, purged 2026-05-06)." >&2
  echo "============================================================" >&2
  echo "" >&2
  exit 1
fi

exit 0

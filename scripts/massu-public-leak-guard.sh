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
  # .claude (settings + hooks only — NOT commands)
  '^\.claude/settings\.json$'
  '^\.claude/hooks/'
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

if [ ${#denied_violations[@]} -gt 0 ] || [ ${#violations[@]} -gt 0 ]; then
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

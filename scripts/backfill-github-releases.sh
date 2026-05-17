#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.

# P-H031 (plan-stage-c-high-batch / 1.10.4): backfill missing GitHub
# Releases on `massu-ai/massu` (public repo). Pre-1.10.4 the public repo
# only had v0.1.0 / v0.1.1 GitHub Releases from 2026-02-24, despite git
# tags going through v1.10.3. This script extracts the CHANGELOG.md
# section per tag and creates the GitHub Release entry, skipping ones
# that already exist.
#
# Idempotent: re-runnable; existing releases are skipped via gh exit code.
# Run from anywhere; locates the public repo at ../massu/.
#
# Usage:
#   bash scripts/backfill-github-releases.sh [--dry-run]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_REPO_DIR="$REPO_ROOT/../massu"
CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"
GH_REPO="massu-ai/massu"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

if [ ! -d "$PUBLIC_REPO_DIR/.git" ]; then
  echo "Error: public repo not found at $PUBLIC_REPO_DIR" >&2
  exit 1
fi

if [ ! -f "$CHANGELOG_FILE" ]; then
  echo "Error: CHANGELOG.md not found at $CHANGELOG_FILE" >&2
  exit 1
fi

cd "$PUBLIC_REPO_DIR"
TAGS=$(git tag -l 'v1.*' | sort -V)
cd "$REPO_ROOT"

EXISTING=$(gh release list -R "$GH_REPO" --limit 200 --json tagName -q '.[].tagName' 2>/dev/null || echo "")

CREATED=0
SKIPPED=0
FAILED=0

for TAG in $TAGS; do
  if echo "$EXISTING" | grep -qx "$TAG"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  VERSION="${TAG#v}"

  BODY=$(awk -v ver="$VERSION" '
    BEGIN { in_section = 0 }
    /^## \[/ {
      if (in_section) { exit }
      if ($0 ~ "^## \\[" ver "\\]") { in_section = 1; next }
      next
    }
    in_section { print }
  ' "$CHANGELOG_FILE")

  if [ -z "$BODY" ]; then
    BODY="Release $VERSION — see [CHANGELOG.md](https://github.com/$GH_REPO/blob/main/CHANGELOG.md) for details."
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[DRY RUN] Would create $TAG ($(echo "$BODY" | wc -l) body lines)"
    continue
  fi

  if gh release create "$TAG" \
       --repo "$GH_REPO" \
       --title "$TAG" \
       --notes "$BODY" \
       --verify-tag >/dev/null 2>&1; then
    CREATED=$((CREATED + 1))
    echo "  ✓ Created $TAG"
  else
    FAILED=$((FAILED + 1))
    echo "  ✗ Failed to create $TAG"
  fi
done

echo ""
echo "Summary: $CREATED created, $SKIPPED already existed, $FAILED failed"

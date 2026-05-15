#!/usr/bin/env bash
#
# massu-changelog-coverage.sh — Pre-tag gate for CHANGELOG completeness.
#
# Plan ref: plan-1.9.0-plan-token-aware-changelog-batcher Phase D P-D-001.
#
# Logic:
#   (a) Read packages/core/package.json version (X.Y.Z)
#   (b) Read last git tag (vA.B.C via `git describe --tags --abbrev=0`)
#   (c) If X.Y.Z matches A.B.C → no release in progress → exit 0 silently
#       (this lets the gate run on EVERY pre-push without firing on non-release pushes)
#   (d) ELSE (version > last tag = release pending): verify CHANGELOG.md has
#       `## [X.Y.Z] - YYYY-MM-DD` heading at top
#   (e) Extract plan-tokens from commit subjects since last tag (via shared
#       scripts/lib/plan-token-regex.sh SoT)
#   (f) Parse CHANGELOG entry body and verify every token appears
#   (g) Exit 0 on clean, exit 1 with one `gap: <token>` per missing token
#
# Usage:
#   bash scripts/massu-changelog-coverage.sh
#
# Exit codes:
#   0 = clean (or no release in progress)
#   1 = missing CHANGELOG entry, or plan-tokens missing from entry body

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/plan-token-regex.sh
source "$REPO_ROOT/scripts/lib/plan-token-regex.sh"

PKG="$REPO_ROOT/packages/core/package.json"
CHANGELOG="$REPO_ROOT/CHANGELOG.md"

if [ ! -f "$PKG" ]; then
  echo "massu-changelog-coverage: packages/core/package.json not found" >&2
  exit 2
fi
if [ ! -f "$CHANGELOG" ]; then
  echo "massu-changelog-coverage: CHANGELOG.md not found" >&2
  exit 2
fi

# (a) current version
VERSION="$(LC_ALL=C grep -m 1 '"version"' "$PKG" | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/')"
if [ -z "$VERSION" ]; then
  echo "massu-changelog-coverage: failed to parse packages/core/package.json#version" >&2
  exit 2
fi

# (b) last tag — handle bare repo / missing tags gracefully
LAST_TAG="$(cd "$REPO_ROOT" && git describe --tags --abbrev=0 2>/dev/null || true)"
LAST_TAG_VERSION="${LAST_TAG#v}"

# (c) version-drift skip — no release in progress
if [ -n "$LAST_TAG_VERSION" ] && [ "$VERSION" = "$LAST_TAG_VERSION" ]; then
  echo "[skip] no version drift since v${LAST_TAG_VERSION} (package.json#version unchanged)" >&2
  exit 0
fi

# Release in progress — verify CHANGELOG entry
EXPECTED_HEADING="## \\[$VERSION\\] - "
if ! LC_ALL=C grep -qE "^${EXPECTED_HEADING}[0-9]{4}-[0-9]{2}-[0-9]{2}" "$CHANGELOG"; then
  echo "massu-changelog-coverage: FAIL — packages/core/package.json#version is ${VERSION} but CHANGELOG.md has no '## [${VERSION}] - YYYY-MM-DD' heading at top" >&2
  exit 1
fi

# Verify the matching entry is the TOP entry (newest first per Keep-a-Changelog)
FIRST_VERSION="$(LC_ALL=C grep -m 1 -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" | sed -E 's/^## \[([^]]+)\]/\1/')"
if [ "$FIRST_VERSION" != "$VERSION" ]; then
  echo "massu-changelog-coverage: FAIL — top CHANGELOG entry is [${FIRST_VERSION}] but package.json#version is ${VERSION}" >&2
  exit 1
fi

# (e) Extract plan-tokens from commit range
RANGE=""
if [ -n "$LAST_TAG" ]; then
  RANGE="${LAST_TAG}..HEAD"
else
  RANGE="HEAD"
fi

TOKENS="$(cd "$REPO_ROOT" && extract_plan_tokens_from_range "$RANGE" || true)"

if [ -z "$TOKENS" ]; then
  echo "[ok] no plan-tokens in commit range ${RANGE} — entry [${VERSION}] present" >&2
  exit 0
fi

# (f) Extract latest CHANGELOG entry body
ENTRY_BODY="$(LC_ALL=C awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" { flag = 1; next }
  flag && /^## \[/ { flag = 0 }
  flag { print }
' "$CHANGELOG")"

if [ -z "$ENTRY_BODY" ]; then
  echo "massu-changelog-coverage: FAIL — could not extract entry body for [${VERSION}]" >&2
  exit 1
fi

# Extract PRIOR entry body for documented-divergence exemption: a plan-token
# whose post-tag chore commits land in v<prev>..HEAD range but the plan itself
# shipped in the prior release is by-design and should not block the new release.
PRIOR_ENTRY_BODY="$(LC_ALL=C awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" { skip = 1; next }
  skip && /^## \[/ { skip = 0; flag = 1; next }
  flag && /^## \[/ { flag = 0 }
  flag { print }
' "$CHANGELOG")"

# (g) check coverage
GAPS=0
while IFS= read -r token; do
  [ -z "$token" ] && continue
  if ! printf '%s' "$ENTRY_BODY" | LC_ALL=C grep -qF "$token"; then
    # Documented-divergence check: if the token IS in the PRIOR entry body,
    # this is a post-tag chore commit for the prior release — not a gap.
    if printf '%s' "$PRIOR_ENTRY_BODY" | LC_ALL=C grep -qF "$token"; then
      echo "[exempt] $token (already documented in prior CHANGELOG entry — post-tag chore commits for prior release)" >&2
      continue
    fi
    echo "gap: $token" >&2
    GAPS=$((GAPS + 1))
  fi
done <<< "$TOKENS"

if [ "$GAPS" -gt 0 ]; then
  echo "massu-changelog-coverage: FAIL — ${GAPS} plan-token(s) referenced in commit range but not in CHANGELOG entry [${VERSION}] (and not exempted via prior-entry reference)" >&2
  exit 1
fi

echo "[pass] CHANGELOG entry [${VERSION}] references all $(printf '%s' "$TOKENS" | LC_ALL=C wc -l | tr -d ' ') plan-token(s) in range ${RANGE}" >&2
exit 0

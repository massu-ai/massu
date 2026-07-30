#!/usr/bin/env bash
# scripts/massu-website-content-leak-guard.sh — leak-guard for files
# under website/content/** that ship publicly to https://massu.ai via
# the Vercel deploy (NOT covered by the public-REPO leak-guard at
# scripts/massu-public-leak-guard.sh which only scans paths going to
# github.com/massu-ai/massu).
#
# Plan reference: docs/plans/2026-05-11-public-content-leak-guard.md
# Plan Token: plan-public-content-leak-guard
# CR: CR-49 (Public Website Content MUST Pass Leak-Guard)
# VR: VR-PUBLIC-CONTENT
#
# Usage: bash scripts/massu-website-content-leak-guard.sh
#   Exit 0 = no leaks found (PASS)
#   Exit 1 = at least one forbidden pattern detected
#
# Allowlist mechanisms:
#   1. File-level exemption: add path to
#      scripts/lib/leak-patterns.sh:CONTENT_SCAN_SELF_REFERENCE_FILES_WEBSITE_CONTENT
#      AND mirror in website/src/data/leak-guard-exempt.ts (drift-guard test enforces).
#   2. Per-line trailer: append `<!-- leak-guard-allow: <reason> -->`
#      (HTML comment, invisible in MDX render) or `{/* leak-guard-allow:
#      <reason> */}` (JSX/MDX comment, also invisible) or
#      `# leak-guard-allow:` (bash-style — NOT RECOMMENDED for MDX since
#      it renders as visible page text).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Graceful skip when website/content/ scope is absent (e.g. invoked in
# the public repo via rsync sync of scripts/, or in a pre-init internal
# tree). Per P-A-003 G3 fix: exit 0 (PASS) is correct — no scope = no
# leak risk to assert.
if [ ! -d "$REPO_ROOT/website/content" ]; then
  echo "SKIP: website/content/ scope not present (public-repo or pre-init tree)"
  # fail-open-approved: scope absence, not check failure. website/ is never
  # synced to the public mirror, so in that context the directory legitimately
  # does not exist and there is no content to assert about. Note this is NOT a
  # licence for C5 generally — the Vercel deploy path is gated separately.
  exit 0
fi

# Source the shared pattern catalog. CONTENT_PATTERNS + RAW_SHA_PATTERN +
# CONTENT_SCAN_SELF_REFERENCE_FILES_WEBSITE_CONTENT come from this file.
# shellcheck source=lib/leak-patterns.sh
source "$SCRIPT_DIR/lib/leak-patterns.sh"

is_website_exempt() {
  local path="$1"
  for exempt in "${CONTENT_SCAN_SELF_REFERENCE_FILES_WEBSITE_CONTENT[@]}"; do
    if [ "$path" = "$exempt" ]; then
      return 0
    fi
  done
  return 1
}

# Enumerate every MDX file under website/content/. Use `while read` for
# portable compatibility with macOS bash 3.2 (which lacks `mapfile`).
mdx_files=()
while IFS= read -r mdx_path; do
  [ -z "$mdx_path" ] && continue
  mdx_files+=("$mdx_path")
done < <(find "$REPO_ROOT/website/content" -type f -name '*.mdx' | sed "s|^$REPO_ROOT/||" | sort)

violations=()

for path in "${mdx_files[@]}"; do
  [ -z "$path" ] && continue

  # Skip files in the website-content self-reference allowlist.
  if is_website_exempt "$path"; then
    continue
  fi

  abs_path="$REPO_ROOT/$path"
  [ -f "$abs_path" ] || continue

  content=$(cat "$abs_path")

  # CONTENT_PATTERNS check (shared with public-repo guard).
  for pat in "${CONTENT_PATTERNS[@]}"; do
    matches=$(echo "$content" | grep -niE "$pat" | grep -vE 'leak-guard-allow:' || true)
    if [ -n "$matches" ]; then
      first_match=$(echo "$matches" | head -1 | cut -c1-160)
      violations+=("$path  (matched: $pat)  -> ${first_match}")
    fi
  done

  # Raw-SHA pattern check (website-content only).
  sha_matches=$(echo "$content" | grep -niE "$RAW_SHA_PATTERN" | grep -vE 'leak-guard-allow:' || true)
  if [ -n "$sha_matches" ]; then
    first_match=$(echo "$sha_matches" | head -1 | cut -c1-160)
    violations+=("$path  (matched: RAW_SHA_PATTERN $RAW_SHA_PATTERN)  -> ${first_match}")
  fi
done

if [ ${#violations[@]} -gt 0 ]; then
  echo "FAIL: ${#violations[@]} leak-guard violation(s) detected in website/content/:" >&2
  for v in "${violations[@]}"; do
    echo "  - $v" >&2
  done
  echo "" >&2
  echo "Remediation:" >&2
  echo "  1. Remove the offending content (preferred) — internal references should not appear in public website MDX." >&2
  echo "  2. If the reference is legitimately public-safe (e.g. enumerating internal-vs-public command split), add the file path to BOTH:" >&2
  echo "       - website/src/data/leak-guard-exempt.ts (WEBSITE_CONTENT_LEAK_GUARD_EXEMPT)" >&2
  echo "       - scripts/lib/leak-patterns.sh (CONTENT_SCAN_SELF_REFERENCE_FILES_WEBSITE_CONTENT)" >&2
  echo "     (P-C-002 drift-guard test enforces both arrays stay in sync.)" >&2
  echo "  3. For a single-line legitimate match, add a trailer on the same line:" >&2
  echo "       <!-- leak-guard-allow: <reason> -->  (preferred, invisible in MDX render)" >&2
  echo "       {/* leak-guard-allow: <reason> */}  (also invisible)" >&2
  exit 1
fi

echo "PASS: 0 leaks in ${#mdx_files[@]} website/content/ MDX files"
exit 0

#!/usr/bin/env bash
# CR-72 real-tree mutation test for the CR-64 release-integrity gate.
# Attacks the REAL scripts/release-integrity-check.mjs end-to-end with LIVE npm data by
# pointing it (via the MASSU_RELEASE_INTEGRITY_PKG_PATH test seam) at a temp package.json:
#   1. version = a KNOWN-PUBLISHED value with no matching HEAD tag  -> gate MUST exit 1 (RED)
#   2. version = a definitely-UNPUBLISHED value                     -> gate MUST exit 0 (GREEN, proves it opens)
# Never touches the tracked package.json. Requires network (mirrors how the gate runs).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/release-integrity-check.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PUBLISHED_VER="1.15.0"   # long-published; will not match HEAD -> defect shape
UNPUBLISHED_VER="99.99.99-mutationtest"

fail() { echo "MUTATION TEST FAIL: $1" >&2; exit 1; }

# --- Case 1: planted defect (published version, no matching tag@HEAD) must go RED ---
printf '{"name":"@massu/core","version":"%s"}\n' "$PUBLISHED_VER" > "$TMP/package.json"
set +e
MASSU_RELEASE_INTEGRITY_PKG_PATH="$TMP/package.json" node "$GATE" >/dev/null 2>&1
code_red=$?
set -e
[ "$code_red" -eq 1 ] || fail "planted published-version defect did NOT go RED (got exit $code_red, expected 1) — gate is DEAD"
echo "  [1/2] planted defect (published $PUBLISHED_VER, no tag) -> RED (exit 1) ✓"

# --- Case 2: unpublished version must go GREEN (prove the gate OPENS on a genuine pass) ---
printf '{"name":"@massu/core","version":"%s"}\n' "$UNPUBLISHED_VER" > "$TMP/package.json"
set +e
MASSU_RELEASE_INTEGRITY_PKG_PATH="$TMP/package.json" node "$GATE" >/dev/null 2>&1
code_green=$?
set -e
[ "$code_green" -eq 0 ] || fail "unpublished version did NOT pass (got exit $code_green, expected 0) — gate is a brick"
echo "  [2/2] unpublished $UNPUBLISHED_VER -> GREEN (exit 0) ✓"

echo "MUTATION TEST PASS: CR-64 gate goes RED on a published-version reuse and GREEN on a fresh version."

#!/usr/bin/env bash
# Publish @massu/core and PROVE it arrived — the destination, not the exit code.
#
# WHY THIS EXISTS
# ---------------
# `npm publish` exiting 0 is not evidence a consumer can get the fix (CR-67: success is
# not a receipt). The 2.5.1 release was the case in point: the fix was landed, correct,
# and unpublished for a week while every consumer on the machine ran the pre-fix build,
# and nothing anywhere said so. So this asserts the END STATE twice — the registry's
# reported version, and the CONTENTS OF THE TARBALL npm would actually serve.
#
# It also refuses to publish an artifact it cannot verify. The defect being shipped here
# is a payload silently dropped for having the wrong shape, and "built without the fix"
# looks exactly like "built with it" from the outside — so the dist is grepped with a
# POSITIVE CONTROL before anything leaves this machine (M1: prove the sweep could read).
#
# Idempotent: an already-published version is a reported no-op, never an error.
#
# Usage:
#   scripts/ops/publish-and-verify-release.sh --dry-run     # default; changes nothing
#   scripts/ops/publish-and-verify-release.sh --publish
#   scripts/ops/publish-and-verify-release.sh --verify-only # check a published version
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "  ${GREEN}ok${NC}   %s\n" "$1"; }
bad()  { printf "  ${RED}FAIL${NC} %s\n" "$1"; }
info() { printf "  %s\n" "$1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
PKG_DIR="$REPO_ROOT/packages/core"

MODE="dry-run"
for a in "$@"; do
  case "$a" in
    --publish)     MODE="publish" ;;
    --verify-only) MODE="verify-only" ;;
    --dry-run)     MODE="dry-run" ;;
    *) echo "unknown argument: $a (expected --publish | --dry-run | --verify-only)"; exit 2 ;;
  esac
done

VERSION="$(node -p "require('$PKG_DIR/package.json').version")" || exit 2
[ -n "$VERSION" ] || { bad "could not read the version — refusing to act"; exit 2; }
echo "=== @massu/core ${VERSION} — mode: ${MODE} ==="
echo

# ── 1. Is it already there? Idempotence, and the not-a-guess check ────────────
PUBLISHED="$(npm view @massu/core version 2>/dev/null || true)"
[ -n "$PUBLISHED" ] || { bad "registry unreachable or returned nothing — refusing to guess"; exit 2; }
info "registry latest : $PUBLISHED"
info "local version   : $VERSION"

THIS_PUBLISHED=no
npm view "@massu/core@${VERSION}" version >/dev/null 2>&1 && THIS_PUBLISHED=yes
info "already published: $THIS_PUBLISHED"
echo

if [ "$THIS_PUBLISHED" = yes ] && [ "$MODE" = "publish" ]; then
  ok "${VERSION} is already on the registry — nothing to do (idempotent no-op)"
  MODE="verify-only"
fi

# ── 2. The artifact must carry the fix, proven with a positive control ────────
# A grep that returns 0 because it read nothing is indistinguishable from a grep that
# read everything and found nothing. The controls make the denominator real.
verify_dist() {
  local dir="$1" label="$2" rc=0
  local n; n="$(ls "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  info "$label: $n file(s) scanned"
  if [ "$n" -eq 0 ]; then bad "$label: scanned ZERO files — blind, not clean"; return 1; fi

  local c1 c2
  c1="$(grep -l 'function' "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  c2="$(grep -l 'process'  "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  info "$label: [control] function=$c1/$n  process=$c2/$n"
  if [ "$c1" -eq 0 ] || [ "$c2" -eq 0 ]; then
    bad "$label: positive control matched NOTHING — the sweep cannot read these files"
    return 1
  fi

  local f1 f2 f3 old
  f1="$(grep -l 'hookSpecificOutput' "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  f2="$(grep -l 'additionalContext'  "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  f3="$(grep -l 'hookEventName'      "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  old="$(grep -l 'JSON.stringify({ message' "$dir"/*.js 2>/dev/null | wc -l | tr -d ' ')"
  info "$label: hookSpecificOutput=$f1  additionalContext=$f2  hookEventName=$f3  old-shape=$old"

  [ "$f1" -gt 0 ] || { bad "$label: hookSpecificOutput ABSENT — this build does not carry the fix"; rc=1; }
  [ "$f2" -gt 0 ] || { bad "$label: additionalContext ABSENT — this build does not carry the fix"; rc=1; }
  [ "$f3" -gt 0 ] || { bad "$label: hookEventName ABSENT — a payload without it is DROPPED SILENTLY"; rc=1; }
  [ "$old" -eq 0 ] || { bad "$label: $old file(s) still emit the old {message} shape"; rc=1; }
  [ "$rc" -eq 0 ] && ok "$label carries the fix"
  return "$rc"
}

if [ "$MODE" != "verify-only" ]; then
  echo "--- local artifact ---"
  verify_dist "$PKG_DIR/dist/hooks" "local dist/hooks" || {
    bad "refusing to publish an artifact that does not carry the fix. Run the build first:"
    info "  npm run build:types && npm run build:adapters && (cd packages/core && npm run build && npm run build:hooks)"
    exit 1
  }
  echo
fi

# ── 3. Publish ────────────────────────────────────────────────────────────────
if [ "$MODE" = "dry-run" ]; then
  echo "--- DRY RUN — nothing was published ---"
  info "re-run with --publish to release ${VERSION}"
  exit 0
fi

if [ "$MODE" = "publish" ]; then
  WHO="$(npm whoami 2>/dev/null || true)"
  if [ -z "$WHO" ]; then
    bad "not authenticated to npm (\`npm whoami\` failed)."
    info "A token in ~/.npmrc can be PRESENT and INVALID — that is what blocked 2.5.1."
    info "Re-authenticate, then re-run this script:   npm login"
    exit 2
  fi
  ok "authenticated as $WHO"
  echo "--- publishing ---"
  # Exit status is captured on its own line, never through a pipe (CR-69) — and it is
  # not trusted either way; the END STATE below is the verdict.
  ( cd "$PKG_DIR" && npm publish --access public )
  PUBLISH_RC=$?
  info "npm publish exited $PUBLISH_RC (recorded, NOT the verdict)"
  echo
fi

# ── 4. THE VERDICT — the destination, not the exit code ───────────────────────
echo "--- verifying AT THE DESTINATION ---"
FAILED=0

# NOT-YET-VISIBLE IS NOT NOT-PUBLISHED (fixed 2026-08-10, after this script reported a
# FALSE FAIL on a successful 2.5.1 publish). npm's registry is read-after-write eventually
# consistent, so a `sleep 2` then a single read makes "the CDN has not caught up" and "the
# publish did not land" produce the same verdict — and the reassuring-looking one is the
# WRONG one here: a spurious FAIL on a release tool invites a re-publish or a panic.
#
# A fixed sleep is also a constant about the outside world, i.e. an unprobed claim (CR-68).
# Replaced with a DEADLINE-bounded poll: it reports how long it waited, and only calls the
# version absent after the deadline actually expires.
DEADLINE_SECS="${MASSU_PUBLISH_VERIFY_DEADLINE_SECS:-90}"
POLL_SECS=3
WAITED=0
NOW=""
while :; do
  NOW="$(npm view @massu/core version 2>/dev/null || true)"
  [ "$NOW" = "$VERSION" ] && break
  [ "$WAITED" -ge "$DEADLINE_SECS" ] && break
  sleep "$POLL_SECS"
  WAITED=$((WAITED + POLL_SECS))
done

if [ "$NOW" = "$VERSION" ]; then
  ok "npm view @massu/core version -> $NOW (visible after ${WAITED}s)"
else
  bad "npm view reports '$NOW', expected '$VERSION' after ${WAITED}s (deadline ${DEADLINE_SECS}s)"
  info "the registry genuinely does not serve $VERSION — this is not propagation lag"
  FAILED=1
fi

TARBALL_DIR="$(mktemp -d -t massu-release-verify-XXXXXX)" || exit 2
trap 'rm -rf "${TARBALL_DIR:?}"' EXIT
( cd "$TARBALL_DIR" && npm pack "@massu/core@${VERSION}" >/dev/null 2>&1 )
TGZ="$(ls "$TARBALL_DIR"/*.tgz 2>/dev/null | head -1)"
if [ -z "$TGZ" ]; then
  bad "could not fetch the published tarball — cannot verify what consumers receive"
  FAILED=1
else
  ok "fetched $(basename "$TGZ")"
  ( cd "$TARBALL_DIR" && tar xzf "$TGZ" )
  if [ -d "$TARBALL_DIR/package/dist/hooks" ]; then
    verify_dist "$TARBALL_DIR/package/dist/hooks" "PUBLISHED tarball dist/hooks" || FAILED=1
  else
    bad "the published tarball has no dist/hooks — consumers get no hooks at all"
    FAILED=1
  fi
  CL="$TARBALL_DIR/package/CHANGELOG.md"
  if [ -f "$CL" ]; then
    info "tarball CHANGELOG first entry: $(grep -m1 '^## \[' "$CL")"
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}RESULT: PASS${NC} — ${VERSION} is live and the published tarball carries the fix."
  exit 0
fi
echo -e "${RED}RESULT: FAIL${NC} — the registry does not yet serve a correct ${VERSION}."
exit 1

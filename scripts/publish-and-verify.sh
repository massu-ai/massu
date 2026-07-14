#!/usr/bin/env bash
# Publish @massu/core and then VERIFY WHAT THE REGISTRY ACTUALLY SERVES BACK.
#
# The publish is only half of it. "npm publish exited 0" is a claim about a command, not about the
# world. This script re-DOWNLOADS the tarball from the registry and scans it, and re-reads
# `npm owner ls`, because the only evidence that counts is what a stranger can actually fetch.
#
# USAGE:  bash scripts/publish-and-verify.sh          (no arguments — no code to type)
#
# ── WHY THIS SCRIPT ALLOCATES A PSEUDO-TERMINAL ──────────────────────────────────────────────
#
# This account's 2FA is `auth-and-writes` backed by a PASSKEY (Touch ID / Apple password). There
# IS NO 6-DIGIT CODE. Any instruction of the form "enter the code from your authenticator app" is
# not merely inconvenient here — it asks for something that does not exist.
#
# npm only offers the browser/passkey (webauthn) flow when it believes it has an interactive
# terminal. Run from a non-TTY context — a script, CI, an agent's shell — it cannot start that
# flow, so it falls back to demanding a TOTP code and dies with `npm error code EOTP`, publishing
# nothing. The failure LOOKS like "you didn't give me your 2FA code", which sends you hunting for
# a code that will never exist. The actual cause is the missing TTY.
#
# `script -q /dev/null <cmd>` hands npm a pseudo-terminal, so it takes the passkey path: it prints
# an auth URL and polls the registry while waiting. We grep that URL out of the stream and `open`
# it, so the browser comes up on its own. The human taps Touch ID once. That is the whole cost —
# and 2FA stays fully intact, which a stored automation token (the other way to solve this) would
# not: that would be a credential on disk with permanent publish rights, i.e. trading the account's
# second factor for convenience. We keep the second factor.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$(pwd)"
SCANNER="$REPO/scripts/lib/private_content_scan.py"
LOG="$(mktemp)"

VERSION="$(python3 -c "import json;print(json.load(open('$REPO/packages/core/package.json'))['version'])")"

echo "════════════════════════════════════════════════════════════════"
echo " PUBLISH @massu/core $VERSION"
echo "════════════════════════════════════════════════════════════════"
echo " Your browser will open for npm's passkey login. Approve with Touch ID."
echo " (There is no 6-digit code — this account uses a passkey, not an authenticator app.)"
echo ""

cd "$REPO/packages/core" || exit 1

( script -q /dev/null npm publish --access public > "$LOG" 2>&1 ) &
NPM_PID=$!

# Surface the auth URL the moment npm emits it, and open it.
for _ in $(seq 1 180); do
  URL="$(grep -oE 'https://www\.npmjs\.com/auth/cli/[A-Za-z0-9._-]+' "$LOG" 2>/dev/null | head -1)"
  if [ -n "$URL" ]; then
    echo "  → opening browser for passkey approval…"
    open "$URL" 2>/dev/null || echo "  → open this manually: $URL"
    break
  fi
  kill -0 "$NPM_PID" 2>/dev/null || break
  sleep 1
done

wait "$NPM_PID"; PUB_RC=$?
sed -e 's/\r/\n/g' "$LOG" | grep -vE '^\s*$' | tail -25
rm -f "$LOG"

if [ "$PUB_RC" -ne 0 ]; then
  echo ""
  echo "PUBLISH FAILED. NOTHING WAS PUBLISHED."
  echo ""
  echo "  If the error is EOTP, the passkey approval did not complete (the browser was closed,"
  echo "  or the auth link expired). Just re-run — a failed publish changes nothing."
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " VERIFY THE OUTCOME — what the registry serves back"
echo "════════════════════════════════════════════════════════════════"
sleep 5   # give the registry a moment to make the new version fetchable

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo ""
echo "── 1. latest version on the registry ──"
LATEST="$(npm view @massu/core version)"
echo "    $LATEST"

echo ""
echo "── 2. download the tarball the WORLD downloads, and scan it ──"
URL="$(npm view "@massu/core@$LATEST" dist.tarball)"
echo "    $URL"

# RETRY. The registry records the new version's metadata immediately, but the CDN can take several
# minutes to actually SERVE the tarball — a fresh publish 404s for a while (observed on 1.15.4,
# which is ~18 MB). A single curl here would report "FAILED to download" and look like a broken
# publish when the publish was fine.
for _ in $(seq 1 60); do
  curl -fsSL "$URL" -o "$TMP/pkg.tgz" 2>/dev/null && break
  sleep 20
done
if [ ! -s "$TMP/pkg.tgz" ]; then
  echo "    The registry has not served the tarball yet (still 404 after ~20 min)."
  echo "    The PUBLISH is fine — 'npm view' lists the version. Only the CDN is lagging."
  echo "    Re-run this check later, or let the daily Guardian watcher confirm it."
  exit 1
fi
tar xzf "$TMP/pkg.tgz" -C "$TMP"

# ANTI-VACUITY. Scanning an empty or missing directory returns "clean" — a green result that means
# nothing was looked at. That equivalence between "I found nothing" and "I looked at nothing" is
# the exact bug this entire boundary exists to kill; it must not be reintroduced in the script that
# verifies it. Demand a plausible file count before believing any verdict.
NFILES="$(find "$TMP/package" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo "    fetched $NFILES files (registry says $(npm view "@massu/core@$LATEST" dist.fileCount 2>/dev/null))"
if [ "$NFILES" -lt 100 ]; then
  echo "    REFUSING TO JUDGE: only $NFILES file(s) extracted. A scan of nothing is not a clean scan."
  exit 1
fi

python3 "$SCANNER" --root "$TMP/package"
SCAN_RC=$?

echo ""
echo "── 3. npm owner metadata (the channel that is not a file) ──"
npm owner ls @massu/core

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$SCAN_RC" -eq 0 ]; then
  echo " RESULT: the published tarball for $LATEST is CLEAN."
  echo ""
  echo " If 'npm owner ls' above still shows a personal address, the registry has not"
  echo " re-stamped it — check that the publish ran from the account whose email is"
  echo " hello@massu.ai (npm profile get email)."
else
  echo " RESULT: THE PUBLISHED TARBALL STILL CONTAINS PRIVATE CONTENT (scan exit $SCAN_RC)."
  echo " Do not stop here. The gate was bypassed or is wrong."
fi
echo "════════════════════════════════════════════════════════════════"

#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# Mark a range of published @massu/core releases deprecated on npm, then PROVE it: every
# version in the range must report the message, and every version outside it must not.
#
# Deprecation does not remove or block anything: `npm install` of a deprecated version still
# works and prints the message. It is undone by deprecating the same range with an empty
# message (`--undo`). Requires the npm account that owns @massu/core (npm may ask for a
# one-time password).
#
# usage:
#   scripts/ops/deprecate-releases.sh --preset <name> [--dry-run]   # a recorded decision
#   scripts/ops/deprecate-releases.sh --range ">=2.5.2 <2.5.6" --message "..." [--dry-run]
#   scripts/ops/deprecate-releases.sh --range ">=2.5.2 <2.5.6" --undo [--dry-run]
#   scripts/ops/deprecate-releases.sh --range ">=2.5.2 <2.5.6" --list
#
# A preset is a decision someone already made, kept beside this script so the command that
# carries it out stays one short line: scripts/ops/deprecations/<name>.preset sets RANGE and
# MESSAGE (not `.env`: the safety gate rightly treats any `*.env` path as a secrets file).
# First preset: 2.5.2-2.5.5, whose safety gate warned but did not block.
set -euo pipefail

PKG="@massu/core"
RANGE=""
MESSAGE=""
MODE="apply"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preset)
      P="$(dirname "$0")/deprecations/${2:?--preset needs a name}.preset"
      [ -f "$P" ] || { echo "FATAL: no preset '$2' ($P)" >&2; exit 2; }
      # shellcheck source=/dev/null
      . "$P"
      shift 2 ;;
    --range)   RANGE="${2:?--range needs a semver range}"; shift 2 ;;
    --message) MESSAGE="${2:?--message needs text}"; shift 2 ;;
    --undo)    MESSAGE=""; MODE="undo"; shift ;;
    --dry-run) DRY=1; shift ;;
    --list)    MODE="list"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "FATAL: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done
DRY="${DRY:-0}"

[ -n "$RANGE" ] || { echo "FATAL: --range is required" >&2; exit 2; }
if [ "$MODE" = "apply" ] && [ -z "$MESSAGE" ]; then
  echo "FATAL: --message is required (use --undo to clear a deprecation)" >&2; exit 2
fi

# The versions the range covers, from the registry — never typed in.
ALL_JSON="$(npm view "$PKG" versions --json)"
IN_RANGE="$(node -e '
  const semver = (() => { try { return require("semver"); } catch { return null; } })();
  const all = JSON.parse(process.argv[1]); const r = process.argv[2];
  if (!semver) { console.error("FATAL: the semver package is not resolvable"); process.exit(2); }
  for (const v of all) if (semver.satisfies(v, r, { includePrerelease: true })) console.log(v);
' "$ALL_JSON" "$RANGE")"
TOTAL="$(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$ALL_JSON")"
COUNT="$(printf '%s\n' "$IN_RANGE" | grep -c . || true)"
echo "  $PKG: $TOTAL published version(s); range \"$RANGE\" covers $COUNT:"
printf '%s\n' "$IN_RANGE" | sed 's/^/    /'
[ "$COUNT" -gt 0 ] || { echo "FATAL: the range matches no published version" >&2; exit 1; }

show_state() {
  local v d
  for v in $1; do
    d="$(npm view "$PKG@$v" deprecated 2>/dev/null || true)"
    printf '    %-8s %s\n' "$v" "${d:-(not deprecated)}"
  done
}

if [ "$MODE" = "list" ]; then
  show_state "$IN_RANGE"
  exit 0
fi

echo "  message: ${MESSAGE:-(empty — clears the deprecation)}"
if [ "$DRY" = 1 ]; then
  echo "  --dry-run: would run: npm deprecate \"$PKG@$RANGE\" \"$MESSAGE\""
  exit 0
fi

npm whoami >/dev/null 2>&1 || { echo "FATAL: not logged in to npm. Run: npm login" >&2; exit 1; }
npm deprecate "$PKG@$RANGE" "$MESSAGE"

# Assert the END STATE, per version. The registry can lag a write, so poll briefly.
LATEST="$(npm view "$PKG" dist-tags.latest)"
for _ in 1 2 3 4 5 6; do
  bad=0
  for v in $IN_RANGE; do
    d="$(npm view "$PKG@$v" deprecated 2>/dev/null || true)"
    if [ "$MODE" = "apply" ] && [ "$d" != "$MESSAGE" ]; then bad=1; fi
    if [ "$MODE" = "undo" ] && [ -n "$d" ]; then bad=1; fi
  done
  [ "$bad" -eq 0 ] && break
  sleep 10
done
latest_dep="$(npm view "$PKG@$LATEST" deprecated 2>/dev/null || true)"

echo "  end state:"
show_state "$IN_RANGE"
echo "    latest ($LATEST): ${latest_dep:-(not deprecated)}"
if [ "$bad" -ne 0 ]; then
  echo "RESULT: FAIL — the registry does not report the expected state for every version above." >&2
  exit 1
fi
if [ "$MODE" = "apply" ] && [ -n "$latest_dep" ]; then
  echo "RESULT: FAIL — the latest version ($LATEST) is deprecated too; the range is too wide." >&2
  exit 1
fi
echo "RESULT: PASS — $COUNT version(s) $([ "$MODE" = undo ] && echo cleared || echo deprecated); latest $LATEST is not."

#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# ANTI-VACUITY FOR THE B-004 LIVE-FIRE (plan-2026-08-11-hook-failure-signal-truthfulness).
#
# `live-fire-reality-gate-r3.sh` proves R-3 can fail. THIS proves the live-fire can fail —
# without it, a harness that quietly stopped asserting anything would report exactly what a
# healthy one reports. A regression test cannot find a false negative (CR-72).
#
# It plants, IN THE REAL `scripts/massu-reality-gate.sh`, each defect the live-fire claims
# to catch, and demands the live-fire go RED **for that proof's own declared reason** — not
# merely non-zero, which any broken harness achieves.
#
#   PLANT A  the verdict keys on the LIFETIME count again (the original defect).
#   PLANT B  an ABSENT log reports clean (the blind-gate value).
#   PLANT C  the verdict stops NAMING the offending rows (B-005a).
#
# PLANT C EARNED ITS KEEP ON FIRST RUN. The live-fire's naming assertion matched the bare
# planted timestamp, which ALSO appears in the M1 "newest ..." denominator note — so deleting
# row-naming outright left the assertion green. The proof was decoration and only a plant
# could show it. The assertion now pins timestamp AND hook to the row line.
#
# REQUIRES EXCLUSIVE ACCESS — DO NOT WIRE THIS INTO `npm test`.
# It MUTATES a tracked file in the real working tree. Several sessions routinely work this
# repo at once, so a concurrent run would both corrupt the sibling's tree and make this
# measurement lie (memory `concurrent-plant-makes-liveness-guards-lie`,
# `measurement-tools-need-exclusive-access`). Its home is the isolated CI anti-vacuity job
# and deliberate local invocation. The read-only companion live-fire is the one that belongs
# in the routine suite.
#
# Usage:  bash scripts/tests/prove-r3-live-fire-can-fail.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATE="$REPO_ROOT/scripts/massu-reality-gate.sh"
LF="$REPO_ROOT/scripts/tests/live-fire-reality-gate-r3.sh"

# G29: hook-reachable -- ASSERT the repository, scrub nothing. `--show-toplevel` cannot see
# a GIT_DIR leak (it returns the CWD); only --absolute-git-dir can.
ACTUAL_GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"
if [ "$ACTUAL_GIT_DIR" != "$REPO_ROOT/.git" ]; then
  echo "FATAL: git resolves to '$ACTUAL_GIT_DIR', expected '$REPO_ROOT/.git'." >&2
  exit 1
fi
for f in "$GATE" "$LF"; do
  [ -f "$f" ] || { echo "FATAL: missing $f" >&2; exit 2; }
done

# The plant target must be clean, or "restored byte-identically" would silently mean
# "reverted someone else's uncommitted edit" (CR-70: never discard uncommitted work).
if ! git -C "$REPO_ROOT" diff --quiet -- scripts/massu-reality-gate.sh; then
  echo "FATAL: scripts/massu-reality-gate.sh has uncommitted changes." >&2
  echo "       Refusing to plant: restoring would destroy them." >&2
  exit 2
fi

BAK="$(mktemp -t r3gate-backup-XXXXXX)"
: "${BAK:?mktemp returned an empty path}"
SHA_BEFORE=$(shasum -a 256 "$GATE" | cut -d' ' -f1)
cp "$GATE" "$BAK"

restore () { cp "$BAK" "$GATE"; }
# A named function, not a compound trap literal: a shell metacharacter beside a destructive
# token inside one string is the G25/CR-88 shape, and the write gate refuses it on sight.
cleanup () {
  restore
  [ -n "${BAK:-}" ] && rm -f "$BAK"
}
trap cleanup EXIT

fail=0
PASSED=0; FAILED=0
ok ()  { PASSED=$((PASSED+1)); printf '  \033[0;32mok\033[0m   %s\n' "$1"; }
bad () { FAILED=$((FAILED+1)); printf '  \033[0;31mBAD\033[0m  %s\n' "$1"; fail=1; }

echo "==============================================="
echo " ANTI-VACUITY — can the R-3 live-fire FAIL?"
echo "==============================================="
echo "gate sha256 before: $SHA_BEFORE"

# $1 = label, $2 = expected BAD substring from the live-fire, $3 = perl expression
plant () {
  local label="$1" expect="$2" expr="$3"
  echo
  echo "=== PLANT: $label"
  restore
  perl -pi -e "$expr" "$GATE"
  if cmp -s "$GATE" "$BAK"; then
    bad "plant did not change the file — the mutation is inert, so this proves nothing"
    return
  fi
  local out rc=0
  out=$(bash "$LF" 2>&1) || rc=$?
  local clean; clean=$(printf '%s\n' "$out" | sed $'s/\033\\[[0-9;]*m//g')
  if [ "$rc" -eq 0 ]; then
    bad "live-fire still PASSED with the defect planted (exit 0) — VACUOUS"
  else
    ok "live-fire went RED (exit $rc)"
  fi
  if grep -qF "$expect" <<<"$clean"; then
    ok "red for its OWN declared reason: $expect"
  else
    bad "red, but NOT for the declared reason. Expected: $expect"
    grep -E "^  (BAD|OK) " <<<"$clean" | head -20
  fi
}

plant "verdict keys on lifetime count, not the window" \
      "expected PASS on an out-of-window backlog" \
      's/if \[ "\$nwin" -eq 0 \]; then/if [ "\$scanned" -eq 0 ]; then/'

plant "absent log reports clean" \
      "an absent log reported a PASS" \
      's/^(\s*)skip "R-3 hooks \(no hook-failure log at \$log, and no corroborating.*$/$1pass "no hook failures recorded"/'

plant "verdict no longer names the in-window rows" \
      "did not name the planted row" \
      's/^  printf .%s. "\$out" \| awk -F.*ROW.*$/  :/'

# --- restore, and PROVE the restore ----------------------------------------------------
restore
SHA_AFTER=$(shasum -a 256 "$GATE" | cut -d' ' -f1)
echo
echo "gate sha256 after restore: $SHA_AFTER"
[ "$SHA_BEFORE" = "$SHA_AFTER" ] && ok "real gate restored BYTE-IDENTICALLY" \
                                 || bad "gate NOT restored — the tree is dirty"

# Negative control (CR-49B): if the live-fire were red for some ambient reason, every plant
# above would "pass" for the wrong reason. It must be GREEN on the restored tree.
echo
echo "=== negative control: the live-fire must PASS again on the restored tree"
if bash "$LF" >/dev/null 2>&1; then
  ok "live-fire green on the restored gate — the reds above were caused by the plants"
else
  bad "live-fire RED on the restored gate; every plant verdict above is uninterpretable"
fi

echo
echo "==============================================="
echo "passed: $PASSED failed: $FAILED"
if [ "$fail" -ne 0 ]; then
  echo " ANTI-VACUITY: FAILED"
  echo "==============================================="
  exit 1
fi
echo " ANTI-VACUITY: ALL PLANTS CAUGHT"
echo "==============================================="
exit 0

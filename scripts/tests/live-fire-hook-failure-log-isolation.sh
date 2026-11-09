#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# A-004 — CR-72 LIVE-FIRE FOR THE F2 HOOK-FAILURE-LOG ISOLATION.
#
# Two independent claims, each attacked IN THE REAL TREE and each required to go RED for
# its OWN declared reason:
#
#   PROOF 1  remove the `setupFiles` declaration from the real vitest.config.ts
#            -> hook-failure-log-isolation.test.ts must FAIL, naming setupFiles.
#
#   PROOF 2  make a test aim the seam back at the repo and record a real hook failure
#            -> the run must FAIL from `hook-log-untouched`'s teardown.
#
# PROOF 2 is the one that matters, and it is the reason this script exists rather than a
# fixture. The byte-identity check lives in a vitest `globalSetup` teardown. If vitest
# swallowed a throw from teardown, that check would be DECORATION: it would print its
# denominator, observe the change, raise — and the suite would still exit 0. Nothing short
# of doing it for real distinguishes those two worlds.
#
# NEGATIVE CONTROL (G17/CR-77, and CR-49(B)): PROOF 2 asserts the log's sha256 ACTUALLY
# CHANGED while planted. Without that, "the guard fired" and "the plant never ran" look
# identical, and a broken plant would certify the guard.
#
# The evidence log is snapshotted before anything runs and restored byte-identically after,
# proven by sha256. It is never truncated or deleted (CR-66, plan §7).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE="$REPO_ROOT/packages/core"
LOG="$REPO_ROOT/.massu/hook-failures.jsonl"
CFG="$CORE/vitest.config.ts"
GUARD="src/__tests__/hook-failure-log-isolation.test.ts"

# G29: hook-reachable — ASSERT the repository, scrub nothing. `--show-toplevel` cannot see
# a GIT_DIR leak (it returns the CWD); only --absolute-git-dir can.
ACTUAL_GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"
if [ "$ACTUAL_GIT_DIR" != "$REPO_ROOT/.git" ]; then
  echo "FATAL: git resolves to '$ACTUAL_GIT_DIR', expected '$REPO_ROOT/.git'." >&2
  exit 1
fi

WORK="$(mktemp -d -t hook-log-livefire-XXXXXX)"
PLANTED_TEST="$CORE/src/__tests__/zz-live-fire-hook-log-plant.test.ts"
CFG_BACKUP="$WORK/vitest.config.ts.orig"
LOG_BACKUP="$WORK/hook-failures.jsonl.orig"

fail=0
# Declared BEFORE the trap is installed: `restore` reads it, and an early exit between the
# trap and the seeding block would otherwise hit an unset variable under `set -u`.
LOG_SEEDED=0
restore() {
  [ -f "$CFG_BACKUP" ] && cp "$CFG_BACKUP" "$CFG"
  rm -f "$PLANTED_TEST"
  # A log this script SEEDED must end absent; one it found must end byte-identical. The
  # unconditional `cp` restored the seeded backup too, so it resurrected the synthetic log
  # AFTER the body had removed it — the RESTORE proof printed "removed" while the file was
  # back on disk. The trap runs last, so it has to be the one that knows the difference.
  if [ "$LOG_SEEDED" -eq 1 ]; then
    rm -f "$LOG"
  elif [ -f "$LOG_BACKUP" ]; then
    cp "$LOG_BACKUP" "$LOG"
  fi
}
cleanup() { restore; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

[ -f "$CFG" ] || { echo "FATAL: $CFG not found" >&2; exit 1; }
cp "$CFG" "$CFG_BACKUP"

# SEED A SYNTHETIC LOG WHERE NONE EXISTS, RATHER THAN REPORTING THE PROOF UNRUNNABLE.
#
# `.massu/hook-failures.jsonl` is created LAZILY, by a hook actually failing. A fresh checkout
# therefore never has one — so on CI, PROOF 2 hit `SKIP-AS-FAILURE` and this gate was RED on
# every run it has ever had, with no action able to green it. That is a gate with no legal
# ordering, and a permanently-red gate stops being read (CR-72).
#
# The property PROOF 2 tests — "a test that writes to the evidence log makes the RUN fail" —
# does not care WHOSE rows are in the log, only that the guard is watching the path. So where
# the log is absent we create one, exercise the proof against it, and restore ABSENCE at the
# end. Where it is present (the operator's machine: 11k+ real rows) we never seed, never
# delete, and still assert byte-identity — that path is unchanged.
LOG_PRESENT=0
if [ -f "$LOG" ]; then
  LOG_PRESENT=1
  cp "$LOG" "$LOG_BACKUP"
  BASE_SHA="$(sha_of "$LOG")"
  BASE_ROWS="$(wc -l < "$LOG" | tr -d ' ')"
else
  mkdir -p "$(dirname "$LOG")"
  # Two rows in the real shape, clearly marked synthetic so nothing mistakes them for
  # evidence of an actual hook failure on this machine.
  printf '%s\n' \
    '{"hook":"live-fire-synthetic","error":"seeded by live-fire-hook-failure-log-isolation.sh","at":"1970-01-01T00:00:00.000Z"}' \
    '{"hook":"live-fire-synthetic","error":"removed again by the RESTORE proof below","at":"1970-01-01T00:00:01.000Z"}' \
    > "$LOG"
  LOG_PRESENT=1
  LOG_SEEDED=1
  cp "$LOG" "$LOG_BACKUP"
  BASE_SHA="$(sha_of "$LOG")"
  BASE_ROWS="$(wc -l < "$LOG" | tr -d ' ')"
fi

echo "== A-004 live-fire: hook-failure-log isolation =="
echo "   evidence log : $LOG"
echo "   baseline     : $BASE_ROWS rows, sha256:${BASE_SHA:0:16}"
echo ""

# ── PROOF 1 ────────────────────────────────────────────────────────────────────────────
echo "-- PROOF 1: remove the setupFiles declaration; the guard must go RED naming it --"
# Delete only the setupFiles line, leaving globalSetup in place, so the failure is
# attributable to ONE removal rather than to the config being broken generally.
grep -v "setup/hook-failure-isolation.ts" "$CFG_BACKUP" > "$CFG"

if grep -q "setup/hook-failure-isolation.ts" "$CFG"; then
  echo "   FAIL  plant did not apply — setupFiles line still present. A defeat test that"
  echo "         cannot plant its defect is vacuous."
  fail=1
else
  set +e
  P1_OUT="$(cd "$CORE" && npx vitest run "$GUARD" 2>&1)"
  P1_RC=$?
  set -e
  if [ "$P1_RC" -eq 0 ]; then
    echo "   FAIL  guard stayed GREEN with setupFiles removed. It is not a guard."
    fail=1
  elif printf '%s' "$P1_OUT" | grep -q "no longer lists src/__tests__/setup/hook-failure-isolation.ts"; then
    echo "   OK    went RED for its OWN declared reason (named the missing setupFiles entry)."
  else
    echo "   FAIL  went RED, but NOT for its declared reason — so this proves nothing about"
    echo "         the property. Output tail:"
    printf '%s\n' "$P1_OUT" | tail -15 | sed 's/^/         /'
    fail=1
  fi
fi
cp "$CFG_BACKUP" "$CFG"
echo ""

# ── PROOF 2 ────────────────────────────────────────────────────────────────────────────
echo "-- PROOF 2: a test writes to the REAL evidence log; the RUN must fail --"
if [ "$LOG_PRESENT" -eq 0 ]; then
  # A per-item precondition failure reports and still exits non-zero (G26/CR-89): a proof
  # that did not run is never a pass.
  echo "   SKIP-AS-FAILURE  the evidence log does not exist on this machine, so the"
  echo "                    byte-identity path cannot be exercised here."
  fail=1
else
  cat > "$PLANTED_TEST" <<'TS'
// TEMPORARY live-fire plant (scripts/tests/live-fire-hook-failure-log-isolation.sh).
// Reproduces the F2 defect exactly: a test that reaches recordHookFailure() with the seam
// pointing back into the repo, appending to the operator's live evidence log.
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { recordHookFailure } from '../hooks/lib/hook-failure-signal.ts';

function repoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'massu.config.yaml'))) return d;
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  throw new Error('repo root not found');
}

describe('LIVE-FIRE PLANT — writes the real evidence log', () => {
  it('appends one row to .massu/hook-failures.jsonl', () => {
    process.env.MASSU_HOOK_FAILURE_LOG = join(repoRoot(), '.massu', 'hook-failures.jsonl');
    expect(recordHookFailure('live-fire-plant', new Error('AV-PLANT-F2'))).toBe(true);
  });
});
TS

  set +e
  P2_OUT="$(cd "$CORE" && npx vitest run src/__tests__/zz-live-fire-hook-log-plant.test.ts 2>&1)"
  P2_RC=$?
  set -e

  DIRTY_SHA="$(sha_of "$LOG")"
  DIRTY_ROWS="$(wc -l < "$LOG" | tr -d ' ')"

  # NEGATIVE CONTROL FIRST. If the log did not change, the plant never ran, and whatever
  # the run's exit code says proves nothing about the guard.
  if [ "$DIRTY_SHA" = "$BASE_SHA" ]; then
    echo "   FAIL  NEGATIVE CONTROL: the log is unchanged ($DIRTY_ROWS rows), so the plant"
    echo "         never wrote. The verdict below would be meaningless."
    fail=1
  else
    echo "   ok    negative control: log moved $BASE_ROWS -> $DIRTY_ROWS rows (the plant is real)"
    if [ "$P2_RC" -eq 0 ]; then
      echo "   FAIL  THE RUN EXITED 0 while a test wrote to the evidence log."
      echo "         The byte-identity check is DECORATION — vitest swallowed the teardown throw."
      fail=1
    elif printf '%s' "$P2_OUT" | grep -q "A TEST WROTE TO THE OPERATOR'S LIVE HOOK-FAILURE LOG"; then
      echo "   OK    run failed (exit $P2_RC) with the guard's OWN message. The check is real."
    else
      echo "   FAIL  run failed (exit $P2_RC) but WITHOUT the guard's message — it may have"
      echo "         failed for an unrelated reason. Output tail:"
      printf '%s\n' "$P2_OUT" | tail -15 | sed 's/^/         /'
      fail=1
    fi
  fi

  rm -f "$PLANTED_TEST"
  cp "$LOG_BACKUP" "$LOG"
fi
echo ""

# ── RESTORE PROOF ──────────────────────────────────────────────────────────────────────
echo "-- RESTORE: the tree and the evidence log must be byte-identical --"
CFG_SHA_NOW="$(sha_of "$CFG")"
CFG_SHA_ORIG="$(sha_of "$CFG_BACKUP")"
if [ "$CFG_SHA_NOW" = "$CFG_SHA_ORIG" ]; then
  echo "   OK    vitest.config.ts sha256 unchanged"
else
  echo "   FAIL  vitest.config.ts DIFFERS after restore ($CFG_SHA_ORIG -> $CFG_SHA_NOW)"
  fail=1
fi

if [ "$LOG_PRESENT" -eq 1 ]; then
  FINAL_SHA="$(sha_of "$LOG")"
  FINAL_ROWS="$(wc -l < "$LOG" | tr -d ' ')"
  if [ "$FINAL_SHA" = "$BASE_SHA" ]; then
    echo "   OK    evidence log restored byte-identically ($FINAL_ROWS rows, sha256:${FINAL_SHA:0:16})"
  else
    echo "   FAIL  EVIDENCE LOG NOT RESTORED. expected sha256:$BASE_SHA got sha256:$FINAL_SHA"
    echo "         A copy of the original is at: $LOG_BACKUP (this script's tmpdir)"
    fail=1
  fi
fi

# A log this script CREATED must not outlive it: the machine ends as it started, with no
# evidence log. Asserted, not assumed — leaving a synthetic log behind would make the next
# run's "byte-identical" check compare against this run's fiction, and would plant two fake
# rows in the very file R-3 corroborates hook health from.
if [ "$LOG_SEEDED" -eq 1 ]; then
  rm -f "$LOG"
  if [ -e "$LOG" ]; then
    echo "   FAIL  seeded evidence log still present at $LOG — absence NOT restored"
    fail=1
  else
    echo "   OK    seeded evidence log removed; the machine is absent-again as it started"
  fi
fi

if [ -f "$PLANTED_TEST" ]; then
  echo "   FAIL  planted test file still present at $PLANTED_TEST"
  fail=1
else
  echo "   OK    planted test removed"
fi

echo ""
if [ "$fail" = "0" ]; then
  echo "RESULT: PASS — both claims went RED for their own declared reasons, the plants were"
  echo "        proven real by negative control, and the tree restored byte-identically."
  exit 0
fi
echo "RESULT: FAIL"
exit 1

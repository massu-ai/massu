#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# D-4 — CR-72 LIVE-FIRE FOR THE WATCHER-LIVENESS CANARY
# (plan-2026-08-12-watch-daemon-silent-dead-watcher).
#
# The canary exists because `chokidar.watch()` can return a watcher that emits `ready`,
# emits no `error`, and then delivers NOTHING for its entire lifetime (measured: 8/60
# under load against 0/60 for polling). A canary for that defect has TWO ways to be
# worthless, and both look like a healthy gate from the outside:
#
#   it never fires   -> the silent-dead watcher ships undetected, exactly as before.
#   it always fires  -> a permanent-reconcile bug wearing a guard's costume; the daemon
#                       refreshes the user's project forever on its own heartbeat.
#
# So BOTH directions are proven here, in the REAL tree, against the REAL daemon:
#
#   PROOF 1  healthy daemon -> the canary must STAY QUIET while the watcher demonstrably
#            delivers. (CR-72: prove the gate OPENS. A brick gets disabled.)
#   PROOF 2  plant the defect in the real packages/core/src/watch/daemon.ts -- rebind the
#            watcher's 'all' handler to an event chokidar never emits, so delivery stops
#            while `ready` still fires and no error is raised -- and demand the canary go
#            RED for its OWN declared reason, reconcile, and then rebuild the watcher.
#
# NEGATIVE CONTROL (CR-49(B), G17/CR-77): PROOF 1 refuses to score itself unless the
# watcher is INDEPENDENTLY PROVEN ALIVE in that same run (a real source write reached
# quiescence with no dead verdict). Without it, "the canary correctly stayed quiet" and
# "the watcher was dead and the canary is broken" are indistinguishable.
#
# ON THE RETRY IN PROOF 1 -- this is NOT retry-until-green. The defect under study is a
# per-instance watcher death with a measured ~13% rate under load, so a given daemon start
# may legitimately produce a DEAD watcher. That makes the run's PRECONDITION unmet, not the
# assertion false. Each attempt re-establishes the precondition from scratch and the
# assertion is scored exactly once, on the first attempt that has a provably live watcher.
# Exhausting the attempts is reported as INCONCLUSIVE and exits NON-ZERO (G26/CR-89: a
# proof that did not run is never a pass).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE="$REPO_ROOT/packages/core"
DAEMON="$CORE/src/watch/daemon.ts"
DRIVER_REL="src/__tests__/zz-live-fire-watch-canary-driver.test.ts"
DRIVER="$CORE/$DRIVER_REL"

# G29: hook-reachable -- ASSERT the repository, scrub nothing. `--show-toplevel` cannot see
# a GIT_DIR leak (it returns the CWD); only --absolute-git-dir can.
ACTUAL_GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)"
if [ "$ACTUAL_GIT_DIR" != "$REPO_ROOT/.git" ]; then
  echo "FATAL: git resolves to '$ACTUAL_GIT_DIR', expected '$REPO_ROOT/.git'." >&2
  exit 1
fi

WORK="$(mktemp -d -t watch-canary-livefire-XXXXXX)"
DAEMON_BACKUP="$WORK/daemon.ts.orig"

fail=0
restore() {
  [ -f "$DAEMON_BACKUP" ] && cp "$DAEMON_BACKUP" "$DAEMON"
  rm -f "$DRIVER"
}
cleanup() { restore; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

[ -f "$DAEMON" ] || { echo "FATAL: $DAEMON not found" >&2; exit 1; }
cp "$DAEMON" "$DAEMON_BACKUP"
BASE_SHA="$(sha_of "$DAEMON")"

echo "== D-4 live-fire: watcher-liveness canary =="
echo "   daemon   : ${DAEMON#"$REPO_ROOT"/}"
echo "   baseline : sha256:${BASE_SHA:0:16}"
echo ""

# ── THE DRIVER ─────────────────────────────────────────────────────────────────────────
# Deliberately assertion-free: it OBSERVES the real daemon and prints one machine-readable
# line. All RED/GREEN adjudication lives in this script, so a vitest exit code cannot be
# mistaken for a verdict about the canary.
write_driver() {
  cat > "$DRIVER" <<'TS'
// TEMPORARY live-fire driver (scripts/tests/live-fire-watch-canary.sh). Observes the REAL
// daemon and reports; it asserts nothing, so the shell script owns the verdict.
import { describe, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { startDaemon } from '../watch/daemon.ts';
import { CANARY_DEAD_LOG, CANARY_REBUILD_LOG } from '../watch/canary.ts';
import { resetConfig } from '../config.ts';

const OUT_PATH = process.env.MASSU_LIVEFIRE_OUT ?? '';

describe('LIVE-FIRE DRIVER — watcher liveness canary', () => {
  it('observes the real daemon', async () => {
    if (!OUT_PATH) throw new Error('MASSU_LIVEFIRE_OUT not set — the driver has nowhere to report');
    const prevCwd = process.cwd();
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-canary-livefire-'));
    writeFileSync(
      resolve(dir, 'massu.config.yaml'),
      [
        'schema_version: 1', 'project:', '  name: t', '  root: auto',
        'paths:', '  source: src', 'framework:', '  type: typescript',
        'watch:', '  debounce_ms: 200', '  storm_threshold: 1000',
        '  deep_storm_threshold: 10000', '  hard_timeout_ms: 60000', '',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(resolve(dir, 'src'), { recursive: true });
    process.chdir(dir);
    resetConfig();

    let fired = 0;
    const stderr: string[] = [];
    const handle = await startDaemon(dir, {
      onQuiescent: () => { fired++; return Promise.resolve(); },
      writeStderr: (s) => { stderr.push(s); },
      tickIntervalMs: 500,
    });

    // Let the startup refresh settle (chokidar emits addDir:src after ready even with
    // ignoreInitial -- pre-existing, reproduced with the canary absent entirely).
    const settleBy = Date.now() + 2_000;
    while (Date.now() < settleBy && fired === 0) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    const baseline = fired;
    const deadBefore = stderr.join('').split(CANARY_DEAD_LOG).length - 1;

    // One real source write, then observe. The window must clear SEVERAL
    // CANARY_MIN_GRACE_MS periods: a verdict is only reached once an arm is older
    // than the grace floor, so two consecutive dead verdicts (the rebuild
    // threshold) cost at least 2x that plus the tick granularity.
    writeFileSync(resolve(dir, 'src', 'live-fire.ts'), `export const x = ${Date.now()};\n`, 'utf-8');
    const deadline = Date.now() + 14_000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    const all = stderr.join('');
    const deadLogs = all.split(CANARY_DEAD_LOG).length - 1 - deadBefore;
    const rebuildLogs = all.split(CANARY_REBUILD_LOG).length - 1;
    // Reported through a FILE, not console.log: vitest does not surface driver
    // stdout here, and an adjudicator that cannot read its own measurement would
    // score every run the same way whether or not the daemon ran at all.
    writeFileSync(
      resolve(String(OUT_PATH)),
      `LIVEFIRE_RESULT deadLogs=${deadLogs} rebuildLogs=${rebuildLogs} ` +
      `firedDelta=${fired - baseline} baseline=${baseline}\n`,
      'utf-8',
    );

    await handle.stop();
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
  }, 90_000);
});
TS
}

RESULT_FILE="$WORK/livefire-result.txt"
run_driver() {
  rm -f "$RESULT_FILE"
  set +e
  DRIVER_OUT="$(cd "$CORE" && MASSU_LIVEFIRE_OUT="$RESULT_FILE" npx vitest run "$DRIVER_REL" 2>&1)"
  DRIVER_RC=$?
  set -e
  RESULT_LINE=""
  [ -f "$RESULT_FILE" ] && RESULT_LINE="$(grep -m1 'LIVEFIRE_RESULT' "$RESULT_FILE" || true)"
}

field() { printf '%s' "$RESULT_LINE" | sed -E "s/.*$1=([0-9-]+).*/\1/"; }

# ── PROOF 1 ────────────────────────────────────────────────────────────────────────────
echo "-- PROOF 1: healthy daemon; the canary must stay QUIET while delivery is proven --"
write_driver
P1_SCORED=0
for attempt in 1 2 3; do
  run_driver
  if [ -z "$RESULT_LINE" ]; then
    echo "   FAIL  the driver produced no LIVEFIRE_RESULT line (vitest exit $DRIVER_RC)."
    printf '%s\n' "$DRIVER_OUT" | tail -15 | sed 's/^/         /'
    fail=1
    P1_SCORED=1
    break
  fi
  D1="$(field deadLogs)"; F1="$(field firedDelta)"
  if [ "$D1" -eq 0 ] && [ "$F1" -ge 1 ]; then
    # Precondition met: the watcher DELIVERED (firedDelta>=1 with no dead verdict), so it
    # was demonstrably alive, and the canary stayed quiet. That is the OPEN direction.
    echo "   OK    attempt $attempt: watcher proven alive (firedDelta=$F1) and the canary"
    echo "         raised no dead verdict. The gate OPENS on a healthy daemon."
    P1_SCORED=1
    break
  elif [ "$D1" -eq 0 ] && [ "$F1" -eq 0 ]; then
    echo "   FAIL  attempt $attempt: nothing was delivered AND the canary raised nothing."
    echo "         A dead watcher went undetected — that is the defect this canary exists for."
    fail=1
    P1_SCORED=1
    break
  else
    # PRINT THE DISCRIMINATING FIELDS, not just the one that failed the predicate.
    # This branch used to report deadLogs alone, which cannot distinguish the two stories
    # that produce it: (a) the watcher died and the daemon RECOVERED — firedDelta>=1, the
    # canary working exactly as designed — from (b) the watcher died and nothing was ever
    # delivered. CI hit this branch 3/3 on 2026-08-12 and the log could not tell them apart,
    # so the failure was undiagnosable from its own output (G24: fix the instrument).
    R1="$(field rebuildLogs)"
    echo "   ..    attempt $attempt: watcher was DEAD this run (deadLogs=$D1 rebuildLogs=$R1"
    echo "         firedDelta=$F1) — precondition unmet for the OPEN direction, which requires"
    echo "         deadLogs=0. firedDelta>=1 here means the daemon DETECTED and RECOVERED;"
    echo "         firedDelta=0 means nothing was ever delivered. Re-establishing with a"
    echo "         fresh daemon."
  fi
done
if [ "$P1_SCORED" -eq 0 ]; then
  echo "   FAIL  INCONCLUSIVE: no attempt produced a provably-live watcher, so the OPEN"
  echo "         direction was never scored. A proof that did not run is not a pass."
  fail=1
fi
echo ""

# ── PROOF 2 ────────────────────────────────────────────────────────────────────────────
echo "-- PROOF 2: plant a silently-dead watcher; the canary must go RED for its own reason --"
# The plant reproduces the measured defect rather than approximating it: the watcher is
# constructed, 'ready' still fires, no 'error' is raised, and not one event is ever
# delivered -- because the 'all' handler is bound to an event chokidar never emits.
BIND_COUNT="$(grep -c "w.on('all'" "$DAEMON_BACKUP" || true)"
if [ "$BIND_COUNT" != "1" ]; then
  echo "   FAIL  expected exactly 1 \`w.on('all'\` binding in the daemon, found $BIND_COUNT."
  echo "         The plant's anchor has moved; this proof would be vacuous (G18)."
  fail=1
else
  sed "s/w\.on('all'/w.on('__AV_CANARY_PLANT_never__'/" "$DAEMON_BACKUP" > "$DAEMON"
  if grep -q "w.on('all'" "$DAEMON"; then
    echo "   FAIL  plant did not apply — the 'all' binding is still present. A defeat test"
    echo "         that cannot plant its defect is vacuous."
    fail=1
  else
    write_driver
    run_driver
    if [ -z "$RESULT_LINE" ]; then
      echo "   FAIL  the driver produced no LIVEFIRE_RESULT line (vitest exit $DRIVER_RC)."
      printf '%s\n' "$DRIVER_OUT" | tail -15 | sed 's/^/         /'
      fail=1
    else
      D2="$(field deadLogs)"; R2="$(field rebuildLogs)"; F2="$(field firedDelta)"
      echo "   ..    planted run: deadLogs=$D2 rebuildLogs=$R2 firedDelta=$F2"
      if [ "$D2" -lt 1 ]; then
        echo "   FAIL  the canary stayed QUIET against a watcher that delivered nothing."
        echo "         It is not a guard."
        fail=1
      else
        echo "   OK    went RED for its OWN declared reason (canary not echoed)."
        if [ "$F2" -lt 1 ]; then
          echo "   FAIL  the canary fired but NO reconciliation ran — detection without"
          echo "         recovery leaves the user silently stale anyway."
          fail=1
        else
          echo "   OK    reconciliation ran despite zero delivery (firedDelta=$F2) — recovery."
        fi
        if [ "$R2" -lt 1 ]; then
          echo "   FAIL  the watcher was never REBUILT (D-3). Reconciling forever against a"
          echo "         watcher that will never work again is not a fix."
          fail=1
        else
          echo "   OK    the watcher was rebuilt after consecutive dead intervals (D-3)."
        fi
      fi
    fi
  fi
fi
cp "$DAEMON_BACKUP" "$DAEMON"
rm -f "$DRIVER"
echo ""

# ── RESTORE PROOF ──────────────────────────────────────────────────────────────────────
echo "-- RESTORE: the tree must be byte-identical --"
FINAL_SHA="$(sha_of "$DAEMON")"
if [ "$FINAL_SHA" = "$BASE_SHA" ]; then
  echo "   OK    daemon.ts sha256 unchanged (${FINAL_SHA:0:16})"
else
  echo "   FAIL  daemon.ts DIFFERS after restore ($BASE_SHA -> $FINAL_SHA)"
  echo "         A copy of the original is at: $DAEMON_BACKUP (this script's tmpdir)"
  fail=1
fi
if [ -f "$DRIVER" ]; then
  echo "   FAIL  planted driver still present at $DRIVER"
  fail=1
else
  echo "   OK    planted driver removed"
fi

echo ""
if [ "$fail" = "0" ]; then
  echo "RESULT: PASS — the canary stayed quiet on a provably-live watcher, went RED for its"
  echo "        own declared reason against a planted silently-dead one, recovered and"
  echo "        rebuilt, and the tree restored byte-identically."
  exit 0
fi
echo "RESULT: FAIL"
exit 1

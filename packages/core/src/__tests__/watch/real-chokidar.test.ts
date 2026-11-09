// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Iter-6 coverage gap: every prior watch test uses `noWatcher: true` so the
 * chokidar bootstrap is bypassed. This file exercises the actual chokidar
 * watcher end-to-end against a tmpdir + real fs writes, asserting that:
 *
 *   1. A real `fs.writeFile` event is observed and queued via `pushEvent`
 *   2. The quiescence FSM still fires `onQuiescent` after the debounce window
 *   3. `stop()` cleanly closes the chokidar instance
 *
 * Uses a short debounce_ms so the test stays under a second of real wall
 * clock — no fake timers (chokidar's own fs.watch / FSEvents fires on real
 * time, not vitest's controllable clock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { startDaemon, STACK_RELEVANT_EVENTS } from '../../watch/daemon.ts';
import { CANARY_DEAD_LOG, CANARY_FILE_REL } from '../../watch/canary.ts';
import { resetConfig } from '../../config.ts';

function setupRepo(dir: string, debounceMs: number): void {
  writeFileSync(
    resolve(dir, 'massu.config.yaml'),
    [
      'schema_version: 1',
      'project:',
      '  name: t',
      '  root: auto',
      'paths:',
      '  source: src',
      'framework:',
      '  type: typescript',
      'watch:',
      `  debounce_ms: ${debounceMs}`,
      '  storm_threshold: 1000',
      '  deep_storm_threshold: 10000',
      '  hard_timeout_ms: 60000',
      '',
    ].join('\n'),
    'utf-8',
  );
  mkdirSync(resolve(dir, 'src'), { recursive: true });
}

describe('watch/daemon real-chokidar end-to-end', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(resolve(tmpdir(), 'massu-real-chokidar-'));
    setupRepo(dir, 200); // 200ms debounce keeps the test fast
    process.chdir(dir);
    resetConfig();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
  });

  it('fires onQuiescent for a real write even if FSEvents never delivers (recovery)', async () => {
    // THIS TEST ASSERTS RECOVERY, NOT DELIVERY — and that distinction is the
    // whole point (plan-2026-08-12-watch-daemon-silent-dead-watcher, D-5).
    //
    // History, every step measured rather than reasoned about:
    //
    //   1. It was `setTimeout(1_000)` then `expect(fired)` — a wall-clock budget,
    //      asserting a property of the MACHINE rather than of the code (G27/CR-90).
    //      Replaced by a bounded poll on the condition. That repair was correct.
    //   2. It flaked anyway, ~1 full-suite run in 12 while passing in isolation.
    //      The comment left by repair (1) was the strongest pull toward the wrong
    //      diagnosis — "the previous fix was insufficient, widen it" — and widening
    //      would have made the flake rarer and the gate weaker. A trace showed the
    //      truth instead:
    //
    //          watch() called globs=[…] cwd=/var/folders/…/massu-real-chokidar-IexIxr
    //          chokidar ready                      <- readiness had ALREADY fired, +51ms
    //          (no further lines)                  <- the write at +250ms, never delivered
    //
    //      `pushEvent` was never called at all. Interleaved A/B under one load window:
    //      fsevents 8/60 DEAD (ready, no error, no events) against polling 0/60,
    //      Fisher's exact ~0.006. The watcher was not dropping events; it was DEAD.
    //
    // So the test no longer stakes its verdict on FSEvents delivering. The daemon now
    // carries a liveness canary: if the watcher does not echo the daemon's own sentinel
    // within a tick, it is declared dead and a reconciliation runs anyway. onQuiescent
    // therefore fires on EITHER path — delivery, or canary-driven recovery — which is
    // what makes this deterministic. A genuinely unwired daemon still fails, because
    // neither path produces a callback that was never hooked up.
    //
    // The tick is shortened so the canary resolves in test time rather than in two real
    // 10s production intervals.
    let fired = 0;
    const handle = await startDaemon(dir, {
      onQuiescent: () => {
        fired++;
        return Promise.resolve();
      },
      tickIntervalMs: 400,
      // No noWatcher — chokidar runs for real.
    });

    // Consume the STARTUP refresh before measuring anything. chokidar emits
    // `addDir: src` after `ready` even with `ignoreInitial: true` (pre-existing,
    // reproduced with the canary absent entirely), so a bare `fired >= 1` would
    // be satisfied by that artifact alone and would assert nothing about either
    // delivery or recovery — a vacuous test that could never fail.
    const settleBy = Date.now() + 2_500;
    while (Date.now() < settleBy && fired === 0) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    const baseline = fired;

    // Re-stimulate while polling: a single dropped delivery is retried, and the
    // canary covers the case where nothing is ever delivered. The write interval
    // stays above the 200ms debounce so quiescence can elapse BETWEEN writes
    // instead of being reset by each one. The deadline clears CANARY_MIN_GRACE_MS
    // with room to spare, so the recovery path has time to run when delivery
    // never happens at all.
    let writes = 0;
    const deadline = Date.now() + 10_000;
    while (fired === baseline && Date.now() < deadline) {
      writeFileSync(resolve(dir, 'src', 'real-event.ts'), `export const x = ${++writes};\n`, 'utf-8');
      await new Promise<void>((r) => setTimeout(r, 300));
    }

    expect(
      fired,
      `daemon never fired onQuiescent for ${writes} real write(s) inside src/ — ` +
        `neither chokidar delivery NOR the liveness canary's recovery path ran ` +
        `(dir=${dir}, cwd=${process.cwd()})`,
    ).toBeGreaterThan(baseline);

    await handle.stop();
  }, 20_000);

  it('never lets the canary refresh the project on its own heartbeat', async () => {
    // The canary writes a sentinel every tick. If those writes reached the
    // quiescence FSM the daemon would refresh the user's project forever on its
    // own heartbeat — a permanent-reconcile bug wearing a guard's costume.
    // Nothing else touches the tree here, so any refresh is the canary's fault.
    let fired = 0;
    const stderr: string[] = [];
    const handle = await startDaemon(dir, {
      onQuiescent: () => {
        fired++;
        return Promise.resolve();
      },
      writeStderr: (s) => {
        stderr.push(s);
      },
      tickIntervalMs: 150,
    });

    // Let the startup refresh settle first. chokidar emits `addDir: src` AFTER
    // `ready` even with `ignoreInitial: true`, so the daemon has always run one
    // refresh shortly after start. Measured to be pre-existing and unrelated to
    // the canary: an identical watch spec with the canary entry absent
    // altogether produces the same `AFTER_READY addDir:src`.
    const settleBy = Date.now() + 1_500;
    while (Date.now() < settleBy && fired === 0) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    const baseline = fired;

    // From here nothing but the canary and the daemon's own tick touch the tree.
    // Poll rather than sleep-then-assert (G27/CR-90), breaking early so a failure
    // reports promptly.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && fired === baseline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    // M1 denominator: if the canary never armed, `fired === baseline` is the
    // value a check that could not look also returns. The sentinel's existence
    // proves the stimulus whose non-effect is being asserted actually occurred.
    // (It is written ONCE per arm, and an arm awaiting its verdict is not
    // rewritten, so the token is deliberately stable — only presence is proof.)
    expect(
      existsSync(resolve(dir, CANARY_FILE_REL)),
      'the canary never armed, so a flat refresh count proves nothing',
    ).toBe(true);

    // A canary that (correctly) declares a genuinely dead watcher DOES reconcile,
    // and that refresh is the mechanism working, not the leak under test. Only
    // refreshes NOT accounted for by a dead verdict indict the filter.
    const deadVerdicts = stderr.join('').split(CANARY_DEAD_LOG).length - 1;
    expect(
      fired - deadVerdicts,
      'the canary drove a user-visible refresh — its own events (and the daemon ' +
        'tick\'s own .massu/watch-state.json writes) must be filtered out before ' +
        'they reach the quiescence FSM.\ndaemon stderr:\n' + stderr.join(''),
    ).toBe(baseline);

    await handle.stop();
  }, 15_000);

  it('does not arm the canary from the `ready` handler — the first arm is a TICK later', async () => {
    // THE DEFECT THIS PINS. Arming from inside `ready` wrote a sentinel the watcher
    // could not yet see: measured on Linux (Docker node:22, kernel 6.12.76), the first
    // arm was NEVER echoed while every later arm echoed in 1-2 ms, so the daemon
    // convicted a watcher that was demonstrably delivering (`firedDelta=2` in the same
    // run) and CI's anti-vacuity job went red on it. Pre-creating the sentinel file
    // first did NOT help (still 1 dead); arming one tick later did (0 dead) — so the
    // directory watch is not EFFECTIVE at `ready`, and `getWatched()` cannot stand in
    // for that (it lists the canary dir 26 ms after ready, while that arm is lost).
    //
    // The assertion is a DIFFERENTIAL on the same code path: a daemon whose tick will
    // not fire during the test must never arm, and a daemon with a short tick must.
    // Without the second half, "the sentinel is absent" and "chokidar never became
    // ready in this environment" are the same observation.
    const noTick = await startDaemon(dir, {
      onQuiescent: () => Promise.resolve(),
      tickIntervalMs: 60_000, // no tick will fire inside this test
    });
    let armedWithoutTick = false;
    const until = Date.now() + 1_500;
    while (Date.now() < until) {
      if (existsSync(resolve(dir, CANARY_FILE_REL))) {
        armedWithoutTick = true;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    await noTick.stop();
    rmSync(resolve(dir, CANARY_FILE_REL), { force: true });

    // POSITIVE CONTROL — the same daemon, same tree, tick short enough to fire.
    const ticking = await startDaemon(dir, {
      onQuiescent: () => Promise.resolve(),
      tickIntervalMs: 200,
    });
    let armedWithTick = false;
    const until2 = Date.now() + 5_000;
    while (Date.now() < until2) {
      if (existsSync(resolve(dir, CANARY_FILE_REL))) {
        armedWithTick = true;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    await ticking.stop();

    expect(
      armedWithTick,
      'the ticking daemon never armed the canary at all, so the no-tick daemon proving ' +
        'nothing was armed proves nothing about WHERE the arm comes from',
    ).toBe(true);
    expect(
      armedWithoutTick,
      'the canary was armed without a tick — `ready` is arming it again. That sentinel ' +
        'is written before the directory watch is effective, so it is never echoed and ' +
        'the daemon convicts a live watcher (measured on Linux/inotify).',
    ).toBe(false);
  }, 20_000);

  it('excludes directory events from the stack-relevant set', () => {
    // An allowlist, asserted explicitly so widening it is a deliberate edit
    // rather than a side effect. Directory events cannot change stack
    // detection — it reads file CONTENTS — and files inside a new directory
    // arrive as their own `add` events.
    expect([...STACK_RELEVANT_EVENTS].sort()).toEqual(['add', 'change', 'unlink']);
    expect(STACK_RELEVANT_EVENTS.has('addDir')).toBe(false);
    expect(STACK_RELEVANT_EVENTS.has('unlinkDir')).toBe(false);
  });

  it('does not refresh for a bare directory, but does for a file in it', async () => {
    // chokidar's initial-scan `addDir` emissions RACE the `ready` event, so
    // `ignoreInitial` does not reliably suppress them and the daemon ran a
    // phantom refresh at startup on a timing coin-flip. Measured: `src/**`
    // alone delivered `addDir: src` after ready; the same watch plus a
    // `package.json` entry delivered nothing.
    let fired = 0;
    const stderr: string[] = [];
    const handle = await startDaemon(dir, {
      onQuiescent: () => {
        fired++;
        return Promise.resolve();
      },
      writeStderr: (s) => {
        stderr.push(s);
      },
      tickIntervalMs: 400,
    });
    const deadCount = (): number => stderr.join('').split(CANARY_DEAD_LOG).length - 1;

    // No settle loop. Once directory events are filtered there is no startup
    // refresh left to absorb, so waiting for one only burns clock — and burning
    // clock is actively harmful here: CANARY_MIN_GRACE_MS runs from the ARM
    // (the first tick after `ready`), not from the start of the window below, so a settle loop
    // that times out pushes the measurement PAST the grace floor and lets a
    // liveness verdict land inside it. That is a real failure this test had.
    const baseline = fired;
    const deadBefore = deadCount();

    mkdirSync(resolve(dir, 'src', 'freshdir'), { recursive: true });
    const dirWindow = Date.now() + 1_200;
    while (Date.now() < dirWindow && fired === baseline) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    // A canary that (correctly) declares a dead watcher DOES reconcile, and that
    // refresh is the recovery mechanism working — not the directory event
    // leaking. Only refreshes NOT accounted for by a dead verdict indict the
    // filter. Belt AND braces: the window is short, and this subtraction makes
    // the assertion correct even when it is not short enough.
    const afterDir = fired - (deadCount() - deadBefore);

    // DENOMINATOR: a file in that same directory must drive a refresh. Without
    // this the assertion above also passes when nothing is being delivered at
    // all, which is the blind-gate value. (It proves the daemon's pipeline is
    // live end-to-end; on a genuinely dead watcher the canary's recovery path
    // supplies the refresh, so this cannot reintroduce the old flake.)
    let writes = 0;
    const firedAfterDir = fired;
    const fileDeadline = Date.now() + 10_000;
    while (fired === firedAfterDir && Date.now() < fileDeadline) {
      writeFileSync(
        resolve(dir, 'src', 'freshdir', 'inside.ts'),
        `export const y = ${++writes};\n`,
        'utf-8',
      );
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    expect(
      fired,
      `no refresh followed ${writes} file write(s) inside the new directory, so the ` +
        'directory assertion above proves nothing',
    ).toBeGreaterThan(firedAfterDir);

    expect(
      afterDir,
      'creating a bare directory drove a user-visible refresh — directory events ' +
        'cannot change stack detection and must not reach the quiescence FSM.\n' +
        'daemon stderr:\n' + stderr.join(''),
    ).toBe(baseline);

    await handle.stop();
  }, 30_000);

  it('stop() cleanly closes the real chokidar watcher', async () => {
    const handle = await startDaemon(dir, {
      onQuiescent: () => Promise.resolve(),
    });
    await new Promise<void>((r) => setTimeout(r, 200));
    // No assertion beyond "doesn't throw or hang".
    await handle.stop();
  }, 5_000);
});

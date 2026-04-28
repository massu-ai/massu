// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Layer C quiescence tests — drive the daemon synthetically (noWatcher: true)
 * with a controllable clock so we can assert exact debounce / storm timing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { startDaemon } from '../../watch/daemon.ts';
import { resetConfig } from '../../config.ts';

function makeFakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function setupRepo(dir: string, watchYaml: string): void {
  // minimal massu.config.yaml so getConfig() doesn't bail
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
      watchYaml,
      '',
    ].join('\n'),
    'utf-8',
  );
  mkdirSync(resolve(dir, 'src'), { recursive: true });
}

describe('watch/daemon quiescence', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(resolve(tmpdir(), 'massu-quiesce-'));
    setupRepo(dir, 'watch:\n  debounce_ms: 3000\n  storm_threshold: 50\n  deep_storm_threshold: 500');
    process.chdir(dir);
    resetConfig();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
    vi.useRealTimers();
  });

  it('normal burst of 30 changes -> exactly 1 refresh after 3s debounce', async () => {
    // Plan: "100 rapid changes -> 1 refresh after 3s debounce". We use 30
    // changes spread over 1.5s so the rate stays below the 50/sec storm
    // threshold (otherwise the algorithm correctly upshifts to 30s storm
    // wait — see the dedicated storm test below).
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    for (let i = 0; i < 30; i++) {
      handle.pushEvent(`src/file${i}.ts`);
      clock.advance(50); // 1.5s total at 20 ev/s (below 50/s threshold)
      await vi.advanceTimersByTimeAsync(50);
    }

    // Just under 3s debounce after the last event — no fire yet.
    clock.advance(2_800);
    await vi.advanceTimersByTimeAsync(2_800);
    expect(onQuiescent).not.toHaveBeenCalled();

    // Cross debounce window — exactly 1 fire.
    clock.advance(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('storm (>50 events in 1s) triggers 30s wait', async () => {
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    // 60 events in 500ms.
    for (let i = 0; i < 60; i++) {
      handle.pushEvent(`src/storm${i}.ts`);
      clock.advance(8);
      await vi.advanceTimersByTimeAsync(8);
    }

    // Cross 3s debounce — should NOT have fired (storm wait = 30s).
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(onQuiescent).not.toHaveBeenCalled();

    // Cross 30s storm window — fires once.
    clock.advance(28_000);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('hard-stops when .git/MERGE_HEAD exists', async () => {
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    mkdirSync(resolve(dir, '.git'), { recursive: true });
    writeFileSync(resolve(dir, '.git', 'MERGE_HEAD'), 'abc\n', 'utf-8');

    handle.pushEvent('src/foo.ts');
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);

    // The debounce timer fires fireRefresh, which short-circuits on git
    // mid-op. onQuiescent must NOT be called.
    expect(onQuiescent).not.toHaveBeenCalled();

    await handle.stop();
  });

  it('git-mid-op refresh re-arms debounce so it retries after merge ends (iter-3 third pass G3-iter3-E6)', async () => {
    // Without re-arming, a refresh during a merge/rebase would be lost
    // because (a) the debounce timer was consumed by the rejected attempt,
    // and (b) the user typically resolves conflicts in their editor — those
    // file events all fire DURING the git op. So once the op ends, no
    // event ever rearms the debounce. The fix in daemon.ts now schedules
    // a fresh debounce on the git-mid-op skip path.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    mkdirSync(resolve(dir, '.git'), { recursive: true });
    writeFileSync(resolve(dir, '.git', 'MERGE_HEAD'), 'abc\n', 'utf-8');

    handle.pushEvent('src/foo.ts');
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);
    // First fireRefresh fired and was rejected (git mid-op). It re-armed
    // a fresh 3s debounce. Confirm onQuiescent has not run yet.
    expect(onQuiescent).not.toHaveBeenCalled();

    // User finishes the merge — MERGE_HEAD is removed.
    rmSync(resolve(dir, '.git', 'MERGE_HEAD'), { force: true });

    // Cross the re-armed debounce window. Because the rejected fireRefresh
    // re-armed the timer, this time it succeeds.
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('flushNow() bypasses debounce and storm cooldown', async () => {
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    handle.pushEvent('src/bar.ts');
    expect(onQuiescent).not.toHaveBeenCalled();

    await handle.flushNow();
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('flushNow() actually bypasses an active storm cooldown (iter-3 third pass G3-iter3-E3)', async () => {
    // Plan §145: --apply-now must bypass quiescence (debounce AND storm).
    // The dedicated debounce-only test above doesn't drive the daemon into
    // a storm first. This test does: trigger a storm, confirm normal
    // refresh would still be 30s away, then assert flushNow fires
    // immediately and resets stormCooldownUntil.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    // 60 events in 500ms → storm → 30s cooldown.
    for (let i = 0; i < 60; i++) {
      handle.pushEvent(`src/storm${i}.ts`);
      clock.advance(8);
      await vi.advanceTimersByTimeAsync(8);
    }

    // Wait 5s — still well inside the 30s storm cooldown.
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onQuiescent).not.toHaveBeenCalled();

    // flushNow() must bypass the cooldown and fire NOW, not 25s from now.
    await handle.flushNow();
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    // After flushNow, post a fresh single event. Because flushNow zeroed
    // stormCooldownUntil, the next event should schedule a NORMAL 3s
    // debounce — NOT the leftover 30s storm window.
    onQuiescent.mockClear();
    handle.pushEvent('src/post-flush.ts');
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('forceReconciliation() runs onQuiescent (sleep/wake recovery)', async () => {
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    await handle.forceReconciliation();
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('hard-timeout fires even with sustained event stream', async () => {
    // Plan iter-3 G3-A6: hardTimeoutMs (5min) is a floor — even a
    // continuous event stream that keeps re-arming the debounce must
    // eventually fire. We override hard_timeout_ms to a smaller value
    // (10s) so the test is fast.
    setupRepo(
      dir,
      'watch:\n  debounce_ms: 3000\n  storm_threshold: 50\n  deep_storm_threshold: 500\n  hard_timeout_ms: 10000',
    );
    resetConfig();

    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    // Fire 1 event every 1s for 12 seconds — never enters storm (rate < 50/s)
    // and the 3s debounce is constantly re-armed. Without a hard-timeout
    // floor, onQuiescent would never run.
    for (let i = 0; i < 12; i++) {
      handle.pushEvent(`src/sustained${i}.ts`);
      clock.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
    }

    // The 13th event arrives AFTER the hard-timeout window — must trigger
    // an immediate refresh (delegated through pushEvent's hard-timeout
    // floor branch).
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('storm cooldown is NOT reset by events arriving inside the cooldown window', async () => {
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    // Burst of 60 in 500ms -> storm -> 30s cooldown.
    for (let i = 0; i < 60; i++) {
      handle.pushEvent(`src/x${i}.ts`);
      clock.advance(8);
      await vi.advanceTimersByTimeAsync(8);
    }

    // 5 seconds later, push another batch INSIDE the cooldown window.
    // This must not extend / reset the cooldown — the original 30s window
    // still applies.
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 5; i++) {
      handle.pushEvent(`src/y${i}.ts`);
      clock.advance(10);
      await vi.advanceTimersByTimeAsync(10);
    }

    // ~6s elapsed since storm start; still in 30s cooldown — no fire.
    clock.advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onQuiescent).not.toHaveBeenCalled();

    // Cross 30s -> exactly 1 fire.
    clock.advance(8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('tick-gap heuristic fires forceReconciliation when wall clock jumps (sleep/wake)', async () => {
    // The setInterval(tick, TICK_INTERVAL_MS=10s) is unref'd. With fake timers
    // we manually advance the wall clock between ticks to simulate a
    // suspend/resume gap > TICK_GAP_THRESHOLD_MS=30s.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    const onQuiescent = vi.fn().mockResolvedValue(undefined);
    const handle = startDaemon(dir, { onQuiescent, now: clock.now, noWatcher: true });

    // First tick at t=10s (clock unchanged) -> normal, no reconciliation.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onQuiescent).not.toHaveBeenCalled();

    // Simulate a sleep/wake gap: advance wall clock by 60s while the
    // setInterval fires its next tick. The tick handler sees the gap
    // (60s > 30s) and triggers forceReconciliation -> onQuiescent.
    clock.advance(60_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('overlapping fires are skipped when a refresh is still running', async () => {
    // Two flushNow calls back-to-back: the second must be skipped because
    // the first is still resolving. We force an artificial delay in
    // onQuiescent to keep the runningRefresh mutex held.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    let resolveFirst: () => void = () => {};
    const onQuiescent = vi.fn().mockImplementation(() => {
      return new Promise<void>((res) => { resolveFirst = res; });
    });
    const writes: string[] = [];
    const handle = startDaemon(dir, {
      onQuiescent,
      now: clock.now,
      noWatcher: true,
      writeStderr: (s: string) => { writes.push(s); },
    });

    const p1 = handle.flushNow();
    // Second call lands while first is still in-flight -> skipped
    // and observable via stderr.
    await handle.flushNow();
    expect(writes.some((s) => s.includes('refresh skipped'))).toBe(true);

    resolveFirst();
    await p1;
    expect(onQuiescent).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('refresh ERROR re-arms debounce so a transient runDetection failure does not strand the daemon (iter-5)', async () => {
    // Iter-5 audit found that fireRefresh's catch path persisted lastError
    // but did NOT re-arm the debounce. Mirrors the git-mid-op (G3-iter3-E6)
    // and lockfile-mid-write paths above — a one-shot transient (e.g.,
    // runDetection throws on a short fs blip) would silently strand the
    // daemon waiting for the next file event. The fix re-schedules the
    // debounce on the catch path.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    let callCount = 0;
    const onQuiescent = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('transient detection failure'));
      }
      return Promise.resolve();
    });
    const writes: string[] = [];
    const handle = startDaemon(dir, {
      onQuiescent,
      now: clock.now,
      noWatcher: true,
      writeStderr: (s: string) => { writes.push(s); },
    });

    handle.pushEvent('src/blip.ts');
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);

    // First refresh ran, threw, error logged, lastError persisted.
    expect(onQuiescent).toHaveBeenCalledTimes(1);
    expect(writes.some((s) => s.includes('refresh error'))).toBe(true);

    // The fix re-arms the debounce. Cross the new debounce window — the
    // re-armed timer fires and the second refresh succeeds. Note: NO new
    // pushEvent fires between the failure and this advance — exercising the
    // exact "no further events arrive after a transient error" scenario.
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(onQuiescent).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it('skipped refresh re-arms debounce so deferred refresh eventually fires (iter-2 correctness fix)', async () => {
    // Iter-2 found that "refresh skipped" was observability-only; if a
    // second refresh attempt landed while a first was in-flight, the
    // debounce timer would be consumed and the deferred refresh would be
    // silently lost until an unrelated event re-armed it. The fix
    // re-schedules the debounce so the second refresh definitely fires
    // after the first releases.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    let resolveFirst: () => void = () => {};
    let firstStarted = false;
    const onQuiescent = vi.fn().mockImplementation(() => {
      return new Promise<void>((res) => {
        firstStarted = true;
        resolveFirst = res;
      });
    });
    const writes: string[] = [];
    const handle = startDaemon(dir, {
      onQuiescent,
      now: clock.now,
      noWatcher: true,
      writeStderr: (s: string) => { writes.push(s); },
    });

    // Trigger first refresh; keep its onQuiescent unresolved.
    const p1 = handle.flushNow();
    expect(firstStarted).toBe(true);

    // Second flushNow lands while the first is still in-flight ->
    // skipped + re-arm debounce.
    await handle.flushNow();
    expect(writes.some((s) => s.includes('refresh skipped'))).toBe(true);

    // Now resolve the first refresh; its `finally` clears runningRefresh.
    resolveFirst();
    await p1;

    // Cross the debounce window — the re-armed timer fires and the
    // second (deferred) refresh actually runs.
    clock.advance(3_500);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(onQuiescent).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it('scheduleDebounce no-ops after stop() (iter-6: shutdown leak guard)', async () => {
    // If a refresh hits a re-arm path (transient error, lockfile mid-write)
    // DURING shutdown, the resulting scheduleDebounce call must NOT create a
    // new setTimeout — that would (a) leak a timer and (b) fire a refresh
    // against a torn-down state.
    vi.useFakeTimers();
    const clock = makeFakeClock();
    let callCount = 0;
    const onQuiescent = vi.fn().mockImplementation(() => {
      callCount++;
      // First refresh throws → re-arm path triggers.
      if (callCount === 1) return Promise.reject(new Error('transient'));
      return Promise.resolve();
    });
    const handle = startDaemon(dir, {
      onQuiescent,
      now: clock.now,
      noWatcher: true,
      writeStderr: () => {},
    });

    // Trigger first (failing) refresh + immediately call stop. The catch path
    // would normally re-arm the debounce — the iter-6 guard must suppress it.
    const p1 = handle.flushNow();
    const stopPromise = handle.stop();
    await p1;
    await stopPromise;

    // Advance well past any potential re-armed debounce window. If the guard
    // was missing, the second refresh would fire here.
    clock.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(1);
  });
});

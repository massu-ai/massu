// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu watch` daemon main loop.
 *
 * Combines Layer B (chokidar watcher + state persistence) and Layer C
 * (quiescence detector: debounce, storm detection, lockfile + git
 * mid-write hard-stops) into a single foreground process. The CLI
 * wrapper in commands/watch.ts spawns this under claude-bg so it's
 * registered for lifecycle reaping.
 */

import * as chokidar from 'chokidar';
import { resetConfig, getConfig } from '../config.ts';
import { gitMidOperation, lockfileMidWrite } from './lockfile-detector.ts';
import { deriveWatchGlobs } from './paths.ts';
import { updateState } from './state.ts';

export const STORM_WINDOW_MS = 1_000;
export const DEEP_STORM_WINDOW_MS = 10_000;
export const STORM_WAIT_MS = 30_000;
export const DEEP_STORM_WAIT_MS = 120_000;
export const TICK_INTERVAL_MS = 10_000;
export const TICK_GAP_THRESHOLD_MS = 30_000;

export interface DaemonHooks {
  /** Called after quiescence + hard-stops pass. Implementations refresh + install. */
  onQuiescent: () => Promise<void> | void;
  /** Optional override for current time, used in tests. */
  now?: () => number;
  /** Stderr writer. Defaults to process.stderr.write. */
  writeStderr?: (s: string) => void;
  /** When true, skip the chokidar setup (used by tests that drive events manually). */
  noWatcher?: boolean;
}

export interface DaemonHandle {
  /** Synthetic event ingest — used by tests; in prod, chokidar drives this. */
  pushEvent: (path: string) => void;
  /** Force the quiescence timer to fire NOW (for `--apply-now`). */
  flushNow: () => Promise<void>;
  /** Stop the watcher and clear timers. */
  stop: () => Promise<void>;
  /** Explicit reconciliation pass — used after sleep/wake gap. */
  forceReconciliation: () => Promise<void>;
}

interface QuiescenceContext {
  /** Pending event timestamps within the recent storm windows. */
  recent: number[];
  /** Pending refresh timer. */
  debounceTimer: NodeJS.Timeout | null;
  /** Hard-timeout (5 min) timer that fires even when events don't stop. */
  hardTimeoutAt: number | null;
  /** When in storm/deep-storm, do not schedule another refresh until this ts. */
  stormCooldownUntil: number;
  /** Last setInterval tick epoch — used by tick-gap heuristic. */
  lastTickAt: number;
  /** Set after a sleep/wake gap is detected, before the reconciliation runs. */
  reconciliationPending: boolean;
}

export interface DaemonConfig {
  projectRoot: string;
  debounceMs: number;
  stormThreshold: number;
  deepStormThreshold: number;
  hardTimeoutMs: number;
}

function readDaemonConfig(projectRoot: string): DaemonConfig {
  // resetConfig() is the caller's responsibility (we want to read the
  // freshest YAML after every refresh cycle).
  const cfg = getConfig();
  const w = (cfg.watch as Record<string, unknown> | undefined) ?? {};
  const num = (k: string, fallback: number): number => {
    const v = w[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    projectRoot,
    debounceMs: num('debounce_ms', 3_000),
    stormThreshold: num('storm_threshold', 50),
    deepStormThreshold: num('deep_storm_threshold', 500),
    hardTimeoutMs: num('hard_timeout_ms', 300_000),
  };
}

/**
 * Start the daemon. Returns a handle for graceful shutdown / test injection.
 *
 * In production: chokidar drives `pushEvent` via the file-watcher.
 * In tests: pass `noWatcher: true` and call `pushEvent` directly.
 */
export function startDaemon(projectRoot: string, hooks: DaemonHooks): DaemonHandle {
  const now = hooks.now ?? Date.now;
  const writeStderr = hooks.writeStderr ?? ((s: string) => { process.stderr.write(s); });

  const cfg = readDaemonConfig(projectRoot);
  const ctx: QuiescenceContext = {
    recent: [],
    debounceTimer: null,
    hardTimeoutAt: null,
    stormCooldownUntil: 0,
    lastTickAt: now(),
    reconciliationPending: false,
  };

  let watcher: chokidar.FSWatcher | null = null;
  let tickTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  // Mutex to prevent overlapping reruns of the quiescence callback.
  let runningRefresh = false;

  function clearDebounce(): void {
    if (ctx.debounceTimer) {
      clearTimeout(ctx.debounceTimer);
      ctx.debounceTimer = null;
    }
  }

  function pruneRecent(t: number): void {
    const cutoff = t - DEEP_STORM_WINDOW_MS;
    if (ctx.recent.length === 0 || ctx.recent[0] >= cutoff) return;
    // Single-pass filter beats repeated O(n) Array.shift() calls when many
    // events fall outside the window at once (iter-9 simplify finding E2).
    ctx.recent = ctx.recent.filter((x) => x >= cutoff);
  }

  function detectStorm(t: number): 'normal' | 'storm' | 'deep_storm' {
    pruneRecent(t);
    const lastSecond = ctx.recent.filter((x) => t - x <= STORM_WINDOW_MS).length;
    const lastTen = ctx.recent.length;
    if (lastTen > cfg.deepStormThreshold) return 'deep_storm';
    if (lastSecond > cfg.stormThreshold) return 'storm';
    return 'normal';
  }

  async function fireRefresh(): Promise<void> {
    if (runningRefresh) {
      // Observability: surface the skip so users investigating "why didn't a
      // refresh fire?" can see it in stderr instead of silent suppression.
      writeStderr('[massu] refresh skipped (previous refresh still running)\n');
      // Iter-2 correctness fix: don't drop the deferred refresh on the floor.
      // Re-arm the debounce so the watcher will retry after the current
      // refresh resolves. Without this, a fresh-event-burst arriving while a
      // previous refresh is in flight would consume the debounce timer and
      // never fire — file changes would be silently lost until the NEXT
      // unrelated event woke the daemon back up.
      scheduleDebounce(cfg.debounceMs);
      return;
    }
    runningRefresh = true;
    try {
      // Hard-stops (G3-A12 of plan + Layer C semantics):
      if (gitMidOperation(cfg.projectRoot)) {
        writeStderr('[massu] git operation in progress (.git/MERGE_HEAD or REBASE_HEAD); skipping refresh\n');
        // Iter-3 (third pass) G3-iter3-E6: re-arm the debounce so the
        // watcher will retry once the merge/rebase completes. Otherwise,
        // if zero file events fire AFTER the git operation finishes (e.g.,
        // user resolved conflicts inside the editor and the editor's
        // chokidar events all hit during the op), the refresh would never
        // re-trigger until an unrelated event woke the daemon.
        scheduleDebounce(cfg.debounceMs);
        return;
      }
      // Lockfile mid-write — defer one more debounce cycle.
      if (lockfileMidWrite(cfg.projectRoot, now())) {
        writeStderr('[massu] lockfile mid-write detected; deferring refresh by debounce\n');
        scheduleDebounce(cfg.debounceMs);
        return;
      }

      await hooks.onQuiescent();
      ctx.recent = [];
      ctx.hardTimeoutAt = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[massu] refresh error: ${msg}\n`);
      try {
        updateState(cfg.projectRoot, { lastError: msg });
      } catch {
        // best-effort
      }
      // Iter-5 correctness fix: re-arm the debounce so a transient error
      // (e.g., runDetection throws on a fs blip / NFS hiccup) does not
      // permanently strand the daemon waiting for the next file event.
      // Mirrors the git-mid-op (G3-iter3-E6) and lockfile-mid-write paths
      // above. Without this re-arm, a one-shot detection error during a
      // quiet period would silently suppress refreshes until a wholly
      // unrelated event re-armed the debounce timer.
      scheduleDebounce(cfg.debounceMs);
    } finally {
      runningRefresh = false;
    }
  }


  function scheduleDebounce(delayMs: number): void {
    // Iter-6 fix: do not schedule new refreshes after stop(). Otherwise an
    // in-flight refresh that hits a re-arm path (transient error, lockfile
    // mid-write, etc.) during shutdown would create a setTimeout that fires
    // AFTER the daemon was told to stop — leaking a timer and (worse) firing
    // a refresh against a torn-down state.
    if (stopped) return;
    clearDebounce();
    ctx.debounceTimer = setTimeout(() => {
      ctx.debounceTimer = null;
      void fireRefresh();
    }, delayMs);
  }

  function pushEvent(_path: string): void {
    if (stopped) return;
    const t = now();
    ctx.recent.push(t);

    // Hard-timeout: from the FIRST event in the current burst.
    if (ctx.hardTimeoutAt === null) {
      ctx.hardTimeoutAt = t + cfg.hardTimeoutMs;
    }

    // Already in storm cooldown — do not reschedule, just accumulate.
    if (t < ctx.stormCooldownUntil) return;

    const intensity = detectStorm(t);
    let delay = cfg.debounceMs;
    if (intensity === 'storm') {
      delay = STORM_WAIT_MS;
      ctx.stormCooldownUntil = t + STORM_WAIT_MS;
    } else if (intensity === 'deep_storm') {
      delay = DEEP_STORM_WAIT_MS;
      ctx.stormCooldownUntil = t + DEEP_STORM_WAIT_MS;
    }

    // Hard-timeout floor: if we've been debouncing past the budget, fire now.
    if (ctx.hardTimeoutAt !== null && t >= ctx.hardTimeoutAt) {
      clearDebounce();
      void fireRefresh();
      return;
    }

    scheduleDebounce(delay);
  }

  async function forceReconciliation(): Promise<void> {
    ctx.reconciliationPending = false;
    clearDebounce();
    await fireRefresh();
  }

  async function flushNow(): Promise<void> {
    clearDebounce();
    ctx.stormCooldownUntil = 0;
    await fireRefresh();
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearDebounce();
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    // Iter-6 SIGINT graceful-shutdown: ideally we would `await` an in-flight
    // fireRefresh here so SIGINT/SIGTERM doesn't cut a refresh mid-write.
    // However, three forces work in the OPPOSITE direction:
    //   1. Every file op the refresh issues is already atomic-rename-safe:
    //      `runConfigRefresh` writes `<path>.tmp` then `renameSync`;
    //      `installAll` writes `<path>.tmp` then `renameSync`; `updateState`
    //      uses `writeStateAtomic` (tmp + fsync + rename); `appendRefreshLog`
    //      is JSONL-append (partial trailing line tolerated by readers).
    //   2. If a refresh is interrupted partway through `installAll`, the next
    //      run completes the remainder — that's by design.
    //   3. The `installAll.lock` (proper-lockfile) ensures another caller
    //      arriving during a partial-completion can't race against the
    //      original writer's process.
    // Plus: a Promise-tracking implementation chained to fireRefresh adds
    // microtasks that interact poorly with vitest's `advanceTimersByTimeAsync`
    // in tests where mock `onQuiescent` returns a forever-pending promise
    // (the iter-2 deferred-fire test breaks). A polling implementation hangs
    // when fake timers freeze `Date.now()`. Both approaches were tried in
    // iter-6 and rejected.
    // Decision: rely on per-file atomic-rename + the install-lock. Document
    // the residual SIGINT semantics in the spec doc so users understand a
    // mid-refresh kill leaves a partially-applied .claude/ that the next
    // run completes. The `stopped` guard in `scheduleDebounce` and
    // `pushEvent` still prevents NEW refreshes from being scheduled after
    // shutdown, which is the leak-prevention concern that IS reachable.
  }

  function tick(): void {
    if (stopped) return;
    const t = now();
    const gap = t - ctx.lastTickAt;
    ctx.lastTickAt = t;
    try {
      updateState(cfg.projectRoot, { tickedAt: new Date(t).toISOString() });
    } catch {
      // best-effort — never let tick failure crash the daemon.
    }
    if (gap > TICK_GAP_THRESHOLD_MS && !ctx.reconciliationPending) {
      ctx.reconciliationPending = true;
      writeStderr(`[massu] tick gap detected (${gap}ms, likely sleep/wake); reconciling\n`);
      void forceReconciliation();
    }
  }

  if (!hooks.noWatcher) {
    const cfgYaml = getConfig();
    const globs = deriveWatchGlobs(cfgYaml);
    if (globs.usedFallback) {
      writeStderr(`[massu] watching default globs (paths.*_source unset): ${globs.watch.join(', ')}\n`);
    }
    watcher = chokidar.watch(globs.watch, {
      cwd: cfg.projectRoot,
      ignored: globs.ignore,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
    });
    watcher.on('all', (_event: string, path: string) => pushEvent(path));
    watcher.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[massu] chokidar error: ${msg}\n`);
      // Persist so `massu watch --status` surfaces it; never let a state
      // write throw out of the error handler (best-effort).
      try {
        updateState(cfg.projectRoot, { lastError: `chokidar: ${msg}` });
      } catch {
        // best-effort
      }
    });
  }

  // Reset cached config so Layer-B picks up watch.* tunables changed at runtime.
  resetConfig();

  // Persist startup state so refresh-log + status subcommands can read it.
  try {
    updateState(cfg.projectRoot, {
      daemonPid: process.pid,
      startedAt: new Date(now()).toISOString(),
      tickedAt: new Date(now()).toISOString(),
      lastError: null,
    });
  } catch {
    // best-effort
  }

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof tickTimer.unref === 'function') tickTimer.unref();

  return { pushEvent, flushNow, stop, forceReconciliation };
}

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
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { resetConfig, getConfig } from '../config.ts';
import {
  CANARY_DEAD_LOG,
  CANARY_DEAD_STRIKES_BEFORE_REBUILD,
  CANARY_REBUILD_LOG,
  CANARY_RECOVERED_LOG,
  CANARY_UNWRITABLE_LOG,
  canaryAwareIgnore,
  createWatcherCanary,
  type WatcherCanary,
} from './canary.ts';
import { gitMidOperation, lockfileMidWrite } from './lockfile-detector.ts';
import { deriveWatchGlobs, enforceWatchSurfaceCap, WatchSurfaceTooLargeError } from './paths.ts';
import { updateState } from './state.ts';

export const STORM_WINDOW_MS = 1_000;
export const DEEP_STORM_WINDOW_MS = 10_000;
export const STORM_WAIT_MS = 30_000;
export const DEEP_STORM_WAIT_MS = 120_000;
export const TICK_INTERVAL_MS = 10_000;
export const TICK_GAP_THRESHOLD_MS = 30_000;

/**
 * chokidar event types that can actually change stack detection.
 *
 * Detection reads file CONTENTS, so a directory appearing or disappearing
 * cannot alter its result — and the files inside one arrive as their own
 * `add`/`unlink` events, so nothing is lost by excluding the directory events.
 * Deliberately an ALLOWLIST: an event type nobody anticipated should not
 * silently acquire the power to refresh a user's project.
 */
export const STACK_RELEVANT_EVENTS = new Set(['add', 'change', 'unlink']);

export interface DaemonHooks {
  /** Called after quiescence + hard-stops pass. Implementations refresh + install. */
  onQuiescent: () => Promise<void> | void;
  /** Optional override for current time, used in tests. */
  now?: () => number;
  /** Stderr writer. Defaults to process.stderr.write. */
  writeStderr?: (s: string) => void;
  /** When true, skip the chokidar setup (used by tests that drive events manually). */
  noWatcher?: boolean;
  /**
   * Tick period override, defaulting to TICK_INTERVAL_MS. The watcher-liveness
   * canary resolves on the tick, so tests that need a liveness verdict without
   * waiting two real 10s intervals shorten this.
   */
  tickIntervalMs?: number;
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
export async function startDaemon(projectRoot: string, hooks: DaemonHooks): Promise<DaemonHandle> {
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

  // Watcher-liveness canary (plan-2026-08-12-watch-daemon-silent-dead-watcher,
  // D-2/D-3). Null when `noWatcher` is set — with no watcher there is nothing
  // whose liveness could be judged, and arming anyway would report DEAD every
  // tick for every test that drives pushEvent by hand.
  let canary: WatcherCanary | null = null;
  /** Captured at startup so a rebuild re-watches exactly the same surface. */
  let watchSpec: { watch: string[]; ignored: (string | ((p: string) => boolean))[] } | null = null;
  /** Mutex: a rebuild is in flight, so skip liveness judgements this tick. */
  let rebuilding = false;
  /**
   * Set by chokidar's `ready`. The canary is only armed after it, because a
   * watcher that has not finished its initial scan has not yet claimed to be
   * watching anything — arming earlier would manufacture a DEAD verdict on a
   * healthy watcher over any tree big enough for the scan to outlast a tick
   * (the surface-cap notes measure 30s+ on a 62K-file tree). `ready` is also
   * precisely the signal this defect abuses: it fires, and nothing follows.
   *
   * READY IS THE PERMISSION TO ARM, NOT THE MOMENT TO ARM. Measured on Linux
   * (Docker node:22, kernel 6.12.76, load 0.16/24): a sentinel written from
   * inside the `ready` handler is NEVER echoed, while every later arm is echoed
   * in 1-2 ms — so the daemon convicted a watcher that was demonstrably
   * delivering (`firedDelta=2` in the same run) and CI's anti-vacuity job went
   * red on it. Two candidate causes were separated by experiment, because they
   * need different fixes:
   *
   *   pre-create the sentinel file before `chokidar.watch()`  -> STILL 1 dead
   *   leave it absent, arm one tick later instead             -> 0 dead
   *
   * So it is not that the sentinel's `add` is lost for being a new file; the
   * directory watch is not yet EFFECTIVE when `ready` fires. `ready` fires SIX
   * times within 5 ms here and arming on every one of them still loses the
   * write, so "the last ready" is not the moment either. `getWatched()` cannot
   * stand in for it: it already lists `.massu/watch-canary` (with `liveness` in
   * it) 26 ms after ready, while that arm's write is being lost — chokidar's
   * bookkeeping tracks ATTACHED, and the property is EFFECTIVE.
   *
   * The arm therefore happens on the daemon's own tick, one interval later.
   * Nothing about the verdict logic changes: a watcher that delivers nothing
   * still fails to echo, still accrues the same streak, and is still rebuilt at
   * CANARY_DEAD_STRIKES_BEFORE_REBUILD. Detection is one tick later; the false
   * conviction is gone.
   */
  let watcherReady = false;

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
    if (canary) {
      canary.cleanup();
      canary = null;
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

  /**
   * Build a chokidar instance over the captured watch spec and wire its
   * handlers. Used at startup AND by the D-3 rebuild, so the two can never
   * drift into watching different surfaces.
   */
  function createWatcherInstance(): chokidar.FSWatcher {
    const spec = watchSpec;
    if (!spec) throw new Error('watch spec not derived before createWatcherInstance()');
    const w = chokidar.watch(spec.watch, {
      cwd: cfg.projectRoot,
      ignored: spec.ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
    });
    w.on('ready', () => {
      // Permission to arm, not the moment to arm — see `watcherReady` above for
      // the measurement. The first arm is issued by the next tick, by which time
      // the directory watch is effective.
      watcherReady = true;
    });
    w.on('all', (event: string, path: string) => {
      // The canary's own writes prove the watcher is delivering; they must
      // never reach the quiescence FSM, or the daemon would refresh the user's
      // project on its own heartbeat every tick.
      if (canary?.observe(path)) return;
      // Only FILE events can change stack detection. A bare directory cannot:
      // detection reads file CONTENTS, and files appearing inside a new
      // directory arrive as their own `add` events, so nothing is missed by
      // dropping `addDir`/`unlinkDir` here.
      //
      // This is not a cosmetic filter. `ignoreInitial: true` suppresses events
      // only until `ready`, and chokidar's initial-scan directory emissions
      // RACE that event — measured: watching `src/**` alone delivered
      // `addDir: src` (and every nested dir) AFTER ready, while the same watch
      // plus a `package.json` entry delivered nothing, because the longer scan
      // let ready win. So `massu watch` ran a phantom refresh at startup on a
      // timing coin-flip. Filtering by relevance is race-immune; filtering by
      // "did this directory pre-exist" would just be a patch on the race.
      if (!STACK_RELEVANT_EVENTS.has(event)) return;
      pushEvent(path);
    });
    w.on('error', (err: unknown) => {
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
    return w;
  }

  function armCanary(): void {
    if (!canary || stopped) return;
    if (canary.arm() === 'unwritable') {
      // An unwritable .massu/ is a DIFFERENT failure from a dead watcher, and
      // louder. Reporting it as "dead" would be the same predicate/property
      // confusion the canary exists to correct.
      writeStderr(
        `${CANARY_UNWRITABLE_LOG} (${canary.filePath}); watcher liveness is UNKNOWN for this interval\n`,
      );
    }
  }

  /** Powers of two drive the dead-watcher escalation backoff. */
  function isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
  }

  async function rebuildWatcher(): Promise<void> {
    if (rebuilding || stopped || !watchSpec) return;
    rebuilding = true;
    try {
      const old = watcher;
      watcher = null;
      if (old) {
        try {
          await old.close();
        } catch {
          // A close failure must not strand the daemon without a watcher.
        }
      }
      if (stopped) return;
      // The replacement instance is armed by the first tick AFTER its own
      // `ready`; arming here would race its initial scan and manufacture the
      // next dead verdict.
      watcherReady = false;
      watcher = createWatcherInstance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[massu] watcher rebuild FAILED: ${msg}\n`);
    } finally {
      rebuilding = false;
    }
  }

  /**
   * D-2/D-3: judge the watcher's liveness from its own canary echo, and escalate.
   *
   * Escalation is on POWERS OF TWO of the consecutive-dead streak (1, 2, 4, 8…)
   * rather than on every tick. A watcher that is permanently dead — fsevents
   * unavailable, say — would otherwise force a full refresh AND a watcher
   * rebuild every single tick forever, trading a silent-staleness bug for a
   * sustained-CPU bug. §3 of the plan rejects polling on exactly that ground,
   * and this path deserves the same treatment.
   */
  function checkWatcherLiveness(): void {
    if (!canary || !watcher || rebuilding || !watcherReady) return;
    const priorDead = canary.consecutiveDead;
    const verdict = canary.evaluate();

    if (verdict === 'dead') {
      const streak = canary.consecutiveDead;
      if (!isPowerOfTwo(streak)) return armCanary();
      writeStderr(
        `${CANARY_DEAD_LOG} after ${streak} consecutive interval(s): the watcher ` +
        `reported ready and emitted no error, but did not deliver its own canary ` +
        `write (${canary.filePath}). Treating it as DEAD and reconciling so changes ` +
        `are not silently missed.\n`,
      );
      try {
        updateState(cfg.projectRoot, {
          lastError: `watcher liveness canary not echoed for ${streak} consecutive interval(s)`,
        });
      } catch {
        // best-effort
      }
      void forceReconciliation();
      if (streak >= CANARY_DEAD_STRIKES_BEFORE_REBUILD) {
        writeStderr(`${CANARY_REBUILD_LOG} after ${streak} dead interval(s) (close + re-watch)\n`);
        void rebuildWatcher();
        // rebuildWatcher() intentionally leaves the canary unarmed for one
        // interval; arming here would race the new instance's initial scan.
        return;
      }
      return armCanary();
    }

    if (verdict === 'alive' && priorDead > 0) {
      writeStderr(`${CANARY_RECOVERED_LOG} after ${priorDead} dead interval(s)\n`);
      try {
        updateState(cfg.projectRoot, { lastError: null });
      } catch {
        // best-effort
      }
    }
    armCanary();
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
    // SUBSUMES the gap heuristic above rather than replacing it: a clock jump
    // remains one reason to reconcile, and a dead watcher becomes another.
    checkWatcherLiveness();
  }

  if (!hooks.noWatcher) {
    const cfgYaml = getConfig();
    const globs = deriveWatchGlobs(cfgYaml);
    if (globs.usedFallback) {
      writeStderr(`[massu] watching default globs (paths.*_source unset): ${globs.watch.join(', ')}\n`);
    }
    if (globs.rootWatchDetected) {
      writeStderr(
        `[massu] root sentinel ('.', '**', etc.) detected in source_dirs — ` +
        `effective scope is now 'full'. Surface cap still applies (set ` +
        `watch.paths_full_root_opt_in: true to override).\n`
      );
    }

    // Plan 3a hotfix 2026-05-02: preflight surface cap. Refuses to start
    // (throws WatchSurfaceTooLargeError) if the configured globs would
    // monitor more files than `watch.max_watched_files` AND the user has
    // not set `watch.paths_full_root_opt_in: true`. Prevents the misconfig
    // pattern that produced 30-100% sustained CPU on a large monorepo.
    const cap = cfgYaml.watch?.max_watched_files ?? 10_000;
    const optedIn = cfgYaml.watch?.paths_full_root_opt_in ?? false;
    const t0 = now();
    const surfaceCount = await enforceWatchSurfaceCap(globs, cfg.projectRoot, cap, optedIn);
    const surfaceMs = now() - t0;
    const countLabel = surfaceCount === Infinity ? `>${cap}` : String(surfaceCount);
    writeStderr(
      `[massu] watch surface: ${countLabel} files (cap ${cap}, ` +
      `opted-in: ${optedIn}, scan ${surfaceMs}ms, scope: ${globs.effectiveScope})\n`
    );

    // The canary directory joins the watch list, and `.massu/**` stops being a
    // blanket exclusion for it alone. MEASURED: with the shipped
    // DEFAULT_EXCLUSIONS a canary under `.massu/` is never delivered even after
    // an explicit `watcher.add()` — so the naive version would have reported a
    // healthy watcher DEAD on every tick. See canary.ts for the probe.
    canary = createWatcherCanary({ projectRoot: cfg.projectRoot, now });
    try {
      mkdirSync(resolve(cfg.projectRoot, canary.dirRel), { recursive: true });
    } catch {
      // Non-fatal: arm() reports `unwritable` and liveness stays UNKNOWN
      // rather than being silently reported as healthy.
    }
    watchSpec = {
      watch: [...globs.watch, canary.dirRel],
      ignored: canaryAwareIgnore(globs.ignore, cfg.projectRoot),
    };
    // Armed by the watcher's own `ready` handler, not here.
    watcher = createWatcherInstance();
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

  tickTimer = setInterval(tick, hooks.tickIntervalMs ?? TICK_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof tickTimer.unref === 'function') tickTimer.unref();

  return { pushEvent, flushNow, stop, forceReconciliation };
}

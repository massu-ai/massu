// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Watcher liveness canary — the mechanism behind plan
 * `plan-2026-08-12-watch-daemon-silent-dead-watcher`, item D-2.
 *
 * THE DEFECT THIS EXISTS FOR. `chokidar.watch()` can return a watcher that
 * emits `ready`, emits no `error`, and then delivers NOTHING for its entire
 * lifetime. Measured on macOS under load: 8 of 60 freshly-created watchers were
 * dead this way, against 0 of 60 for the same directories with `usePolling`
 * (interleaved A/B in one load window, Fisher's exact ~0.006). A user's
 * `.claude/` then silently stops refreshing while `massu watch --status` looks
 * perfectly healthy.
 *
 * WHY A CANARY AND NOT A CLOCK CHECK. The daemon's pre-existing tick heuristic
 * reconciles when `gap > TICK_GAP_THRESHOLD_MS` — its predicate is "did the
 * clock jump?" (sleep/wake) while the property is "might we have missed
 * events?". A watcher that is dead from birth produces NO tick gap at all, so
 * that heuristic is structurally blind to it (G28: a gate's scope predicate must
 * BE the property, not a correlate of it). The canary asks the watcher the
 * question directly: it writes a sentinel the watcher itself should report back,
 * and treats silence as death.
 *
 * TWO MEASURED FACTS THIS DESIGN DEPENDS ON — both probed, not reasoned about,
 * because getting either wrong yields a guard that is confidently useless:
 *
 *   1. `DEFAULT_EXCLUSIONS` contains `'**\/.massu\/**'`. A sentinel written under
 *      `.massu/` is therefore NEVER delivered — not even after an explicit
 *      `watcher.add()`. Measured with a positive control (a sibling `src/` write
 *      WAS delivered in the same run), so this is the exclusion, not a dead
 *      watcher. Shipping the naive version would have produced a canary that
 *      reports DEAD 100% of the time on a perfectly healthy watcher: a
 *      permanent-reconcile bug wearing a guard's costume. Hence
 *      {@link canaryAwareIgnore}, which un-ignores exactly the canary directory
 *      and nothing else.
 *
 *   2. The canary shares ONE recursive FSEvents stream with the watched source
 *      directories. chokidar keys its stream pool by path and attaches a new
 *      watch to any existing stream rooted at an ancestor
 *      (`lib/fsevents-handler.js:135-142`), and a watched FILE resolves its
 *      stream to its dirname (`:108`) — so the project root gets the stream and
 *      everything beneath it consolidates onto it. Verified by patching
 *      `fsevents.watch` and recording the paths streams are actually opened on:
 *      1 unique stream, at the project root, with NO separate stream for `src/`
 *      or for the canary directory — and identically so with no manifest file on
 *      disk. This is what makes the canary's verdict a statement about the SAME
 *      delivery path the user's source events travel; if the two had separate
 *      streams, a live canary could coexist with a dead `src/` watcher and the
 *      canary would be decoration.
 *
 * The canary's own events are filtered out before they reach the quiescence FSM,
 * so it can never trigger a user-visible refresh by existing.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';

/** Canary directory, relative to the project root. */
export const CANARY_DIR_REL = '.massu/watch-canary';
/** Canary sentinel file, relative to the project root. */
export const CANARY_FILE_REL = `${CANARY_DIR_REL}/liveness`;

/**
 * Consecutive dead verdicts before the daemon rebuilds the watcher (D-3).
 * One dead verdict triggers a reconciliation; reconciliation alone would leave
 * the daemon reconciling forever against a watcher that will never work again.
 */
export const CANARY_DEAD_STRIKES_BEFORE_REBUILD = 2;

/**
 * An arm younger than this is too young to judge: `evaluate()` returns `idle`
 * rather than `dead`, and the arm keeps waiting.
 *
 * MEASURED, not guessed (CR-68 — a constant about the outside world is a claim).
 * `scripts/ops/measure-canary-echo-latency.mjs` ships so this can be re-checked:
 *
 *     idle box       30/30 delivered   p50 48ms  p90 51ms  max 199ms
 *     8 spinner procs 40/40 delivered  p50 48ms  p90 52ms  max 941ms
 *
 * The median is ~50ms but the tail under contention reaches ~1s, so the floor is
 * set at roughly 2.5x the observed worst case. Production ticks every 10s, where
 * this floor never binds; it exists so a SHORT tick (tests, or a future tunable)
 * cannot make the canary declare a healthy watcher dead — which would reconcile
 * the user's project on the daemon's own heartbeat, the exact
 * permanent-reconcile failure this mechanism must not become.
 */
export const CANARY_MIN_GRACE_MS = 2_500;

/**
 * Log literals. Exported so the tests and the CR-72 live-fire assert on the
 * SAME strings the daemon emits, rather than on copies that can drift apart.
 */
export const CANARY_DEAD_LOG = '[massu] watcher liveness canary NOT echoed';
export const CANARY_REBUILD_LOG = '[massu] rebuilding file watcher';
export const CANARY_UNWRITABLE_LOG = '[massu] watcher liveness canary could not be written';
export const CANARY_RECOVERED_LOG = '[massu] file watcher recovered';

/** Verdict for the arm placed by the previous tick. */
export type CanaryVerdict =
  /** The watcher delivered the canary write back. */
  | 'alive'
  /** The watcher did not deliver its own canary write — treat it as dead. */
  | 'dead'
  /**
   * Nothing was outstanding to judge (first tick, or the previous arm could not
   * be written). Deliberately NOT 'alive': "I could not look" and "I looked and
   * saw delivery" must never collapse to the same value.
   */
  | 'idle';

export type ArmResult = 'armed' | 'unwritable';

/**
 * Normalize a path to a project-root-relative, forward-slash form.
 * chokidar hands `on('all')` listeners RELATIVE paths when `cwd` is set, but
 * hands the `ignored` matcher ABSOLUTE ones — both must resolve identically.
 */
function toRelative(projectRoot: string, p: string): string {
  const raw = String(p);
  const rel = isAbsolute(raw) ? relative(projectRoot, raw) : raw;
  return rel.split(sep).join('/');
}

/**
 * True when `p` is the canary directory or anything inside it.
 *
 * Anchored to the project root rather than pattern-matched anywhere in the
 * string: a project that itself lives under a directory called `.massu`
 * would otherwise match every path in the tree and ignore the entire repo.
 */
export function isCanaryPath(projectRoot: string, p: string): boolean {
  const rel = toRelative(projectRoot, p);
  return rel === CANARY_DIR_REL || rel.startsWith(`${CANARY_DIR_REL}/`);
}

/**
 * Build the `ignored` value for chokidar: the project's exclusion globs with
 * `'**\/.massu\/**'` replaced by a predicate that still ignores everything under
 * `.massu/` EXCEPT the canary directory.
 *
 * Surgical on purpose. Dropping the `.massu` exclusion wholesale would put the
 * daemon's own state file and databases inside the watch surface — high-churn
 * paths that exist precisely to be ignored.
 *
 * NOTE: the returned array contains a function, so it is valid for chokidar
 * (anymatch) but NOT for fast-glob. The surface-cap preflight must keep using
 * the original string-only globs.
 */
export function canaryAwareIgnore(
  ignore: readonly string[],
  projectRoot: string,
): (string | ((p: string) => boolean))[] {
  const withoutMassu = ignore.filter((g) => g !== '**/.massu/**');
  const massuButNotCanary = (p: string): boolean => {
    if (isCanaryPath(projectRoot, p)) return false;
    const rel = toRelative(projectRoot, p);
    return rel === '.massu' || rel.startsWith('.massu/') || rel.includes('/.massu/');
  };
  return [...withoutMassu, massuButNotCanary];
}

export interface WatcherCanary {
  /** Canary directory, project-root-relative. Added to the chokidar watch list. */
  readonly dirRel: string;
  /** Absolute path of the sentinel file. */
  readonly filePath: string;
  /** Consecutive `dead` verdicts. Reset by any `alive`. */
  readonly consecutiveDead: number;
  /**
   * Write a fresh sentinel and mark it outstanding. A no-op reporting `armed`
   * while a previous arm is still awaiting its verdict, so its age keeps running.
   */
  arm(): ArmResult;
  /**
   * Feed every watcher event through this. Returns true when the path was the
   * canary — the caller MUST then drop the event instead of forwarding it to
   * the quiescence FSM.
   */
  observe(path: string): boolean;
  /**
   * Verdict for the outstanding arm. Call EXACTLY ONCE per tick: it advances
   * the consecutive-dead counter. Returns `idle` while the arm is younger than
   * {@link CANARY_MIN_GRACE_MS} — too young to convict.
   *
   * NOTE: a rebuild deliberately does NOT clear the streak. The streak is what
   * drives the daemon's escalation backoff, so zeroing it on every rebuild
   * would make a permanently-dead watcher rebuild forever at a fixed cadence.
   */
  evaluate(): CanaryVerdict;
  /** Best-effort removal of the sentinel file. */
  cleanup(): void;
}

export interface CanaryOptions {
  projectRoot: string;
  /** Clock override, matching the daemon's own `now` seam. */
  now?: () => number;
}

/**
 * Create a canary bound to a project root.
 *
 * The echo is only counted while an arm is OUTSTANDING. That is what keeps
 * chokidar's initial directory scan from being mistaken for a live delivery:
 * adding the canary directory makes chokidar emit `addDir` (and `add` for a
 * pre-existing sentinel) from a synchronous readdir walk, which proves nothing
 * about the event stream. Those fire before the first arm, so they are ignored.
 */
export function createWatcherCanary(opts: CanaryOptions): WatcherCanary {
  const projectRoot = resolve(opts.projectRoot);
  const now = opts.now ?? Date.now;
  const filePath = resolve(projectRoot, CANARY_FILE_REL);

  let outstanding = false;
  let echoed = false;
  let consecutiveDead = 0;
  let armedAt = 0;

  return {
    dirRel: CANARY_DIR_REL,
    filePath,
    get consecutiveDead(): number {
      return consecutiveDead;
    },

    arm(): ArmResult {
      // An arm already in flight keeps its own clock. Re-writing the sentinel
      // here would restart the age on every tick, so with a tick shorter than
      // CANARY_MIN_GRACE_MS no arm would ever become old enough to judge and
      // the canary would sit permanently idle — a dead control reporting
      // silence, which is indistinguishable from a healthy one.
      if (outstanding) return 'armed';
      try {
        mkdirSync(resolve(projectRoot, CANARY_DIR_REL), { recursive: true });
        // The token makes each arm a distinct write, so an FSEvents coalesce of
        // two identical writes cannot masquerade as a fresh delivery.
        writeFileSync(filePath, `${now()}\n`, 'utf-8');
      } catch {
        // Could not place the canary: liveness is UNKNOWN, not dead. An
        // unwritable .massu/ is a different (and louder) failure than a dead
        // watcher, and conflating the two would be the very predicate/property
        // confusion this module exists to correct.
        outstanding = false;
        echoed = false;
        return 'unwritable';
      }
      outstanding = true;
      echoed = false;
      armedAt = now();
      return 'armed';
    },

    observe(path: string): boolean {
      if (!isCanaryPath(projectRoot, path)) return false;
      if (outstanding) echoed = true;
      return true;
    },

    evaluate(): CanaryVerdict {
      if (!outstanding) return 'idle';
      // Too young to judge: keep waiting rather than convict. Measured echo
      // latency is ~50ms at the median but tails to ~1s under contention, and
      // convicting on the tail would reconcile a perfectly healthy project.
      if (now() - armedAt < CANARY_MIN_GRACE_MS) return 'idle';
      outstanding = false;
      if (echoed) {
        consecutiveDead = 0;
        return 'alive';
      }
      consecutiveDead += 1;
      return 'dead';
    },

    cleanup(): void {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Synchronous file lock around installAll() for cross-process safety.
 *
 * Plan 3a Phase 6: installAll() may now be invoked from BOTH the manual
 * `runConfigRefresh` path AND the watcher auto-trigger. Without
 * serialization, two concurrent callers can race on `.claude/commands/`
 * file writes. proper-lockfile gives us atomic mkdir-based locks that
 * work cross-platform; we wrap it to:
 *
 *   1. mkdirSync the lock dir (fresh repos may not have `.massu/`)
 *   2. surface ELOCKED (POSIX) and EBUSY (Windows) as the same error
 *   3. keep installAll() synchronous (lockSync, not lock)
 *
 * Plan §190 retry behavior: "second caller blocks up to 30s, then bails".
 * proper-lockfile's `lockSync` REJECTS `retries>0` (see node_modules/
 * proper-lockfile/lib/adapter.js: `Cannot use retries with the sync api`).
 * We implement the retry-block manually via a `lockfile.checkSync` /
 * `lockSync` loop with a busy-wait sleep.
 *
 * iter-3 (third pass, G3-iter3-1+2): align error message with plan §243
 * format `"installAll already running (PID=X) — try again in <N>s"` AND
 * add the manual retry-block loop.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import * as lockfile from 'proper-lockfile';

export interface InstallLockOpts {
  /** Default 30s — proper-lockfile considers a lock stale after this elapses. */
  staleMs?: number;
  /**
   * How long the manual retry loop should block waiting for the holder to
   * release before bailing with `InstallLockBusyError`. Default 30s per
   * plan §190 ("second caller blocks up to 30s, then bails").
   * Pass `0` to bail immediately (used in tests).
   */
  blockMs?: number;
  /** Sleep granularity inside the retry loop. Default 100ms. */
  pollIntervalMs?: number;
  /**
   * Backwards-compat: legacy callers pass `retries: 0` to mean "do not
   * block". When set to a positive integer, used by tests that want to
   * exercise a specific retry count instead of the default time-based loop.
   */
  retries?: number;
  /** Override clock (test seam). */
  now?: () => number;
  /** Override sleep (test seam). Defaults to a busy-wait spinloop. */
  sleep?: (ms: number) => void;
}

export class InstallLockBusyError extends Error {
  constructor(
    public lockPath: string,
    public holderPid: number | null,
    public retryAfterSeconds: number,
    public causeCode?: string,
  ) {
    const pidPart = holderPid != null ? `(PID=${holderPid})` : '(PID=unknown)';
    super(`installAll already running ${pidPart} — try again in ${retryAfterSeconds}s`);
    this.name = 'InstallLockBusyError';
  }
}

/**
 * Best-effort: read the PID of the current lock holder. proper-lockfile
 * stores the lock as a directory at `<lockPath>` containing nothing PID-
 * identifying, so we look at our own sidecar `<lockPath>.pid` file (written
 * by the lock acquirer below). On any read error we return null so the
 * error message degrades gracefully to `(PID=unknown)`.
 */
function readHolderPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(`${lockPath}.pid`, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function busyWaitSync(ms: number): void {
  const end = Date.now() + ms;
  // Atomics.wait against a SharedArrayBuffer is the cleanest portable sync
  // sleep; fall back to a tight loop if SharedArrayBuffer is unavailable
  // (older runtimes / sandboxed envs).
  if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
    return;
  }
  while (Date.now() < end) {
    // Spin — this should never run on modern Node, kept as belt-and-suspenders.
  }
}

/**
 * Acquire the lock, run `fn`, release on every exit path.
 * Synchronous all the way through so installAll() keeps its sync signature.
 */
export function withInstallLock<T>(projectRoot: string, fn: () => T, opts: InstallLockOpts = {}): T {
  const lockPath = resolve(projectRoot, '.massu', 'installAll.lock');
  // iter-3 G3-A11: ensure parent dir exists (fresh repo case).
  mkdirSync(dirname(lockPath), { recursive: true });

  const staleMs = opts.staleMs ?? 30_000;
  // `retries: 0` legacy path = bail immediately, no wait.
  // Otherwise default to plan §190's 30s block.
  const blockMs = opts.retries === 0
    ? 0
    : (opts.blockMs ?? 30_000);
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? busyWaitSync;

  let release: (() => void) | null = null;
  const deadline = now() + blockMs;
  let lastErr: NodeJS.ErrnoException | null = null;

  // Manual retry loop. proper-lockfile.lockSync forbids retries>0, so we
  // wrap it ourselves: try → on ELOCKED/EBUSY, sleep → try again until
  // deadline. This satisfies plan §190 "second caller blocks up to 30s".
  for (;;) {
    try {
      release = lockfile.lockSync(lockPath, {
        stale: staleMs,
        retries: 0,
        realpath: false,
      });
      // Persist our PID alongside the lock so the next contender can include
      // it in the user-friendly error per plan §243 format.
      try {
        writeFileSync(`${lockPath}.pid`, String(process.pid), 'utf-8');
      } catch {
        // best-effort
      }
      break;
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException;
      const code = lastErr.code;
      if (code !== 'ELOCKED' && code !== 'EBUSY') {
        throw err;
      }
      if (now() >= deadline) {
        const holderPid = readHolderPid(lockPath);
        const remainingMs = Math.max(0, deadline - now());
        // Surface a hint about how long the *next* poll cycle should wait.
        // When `blockMs=0` the user got bail-immediately semantics; report
        // the staleness window so they know the lock auto-releases in N s.
        const retryAfterSeconds = blockMs === 0
          ? Math.round(staleMs / 1000)
          : Math.round(remainingMs / 1000);
        throw new InstallLockBusyError(lockPath, holderPid, retryAfterSeconds, code);
      }
      sleep(pollIntervalMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      if (release) release();
    } catch {
      // best-effort
    }
    try {
      rmSync(`${lockPath}.pid`, { force: true });
    } catch {
      // best-effort
    }
  }
}

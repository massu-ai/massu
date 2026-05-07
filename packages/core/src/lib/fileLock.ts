// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Generic synchronous file-lock primitive built on `proper-lockfile`.
 *
 * Plan 3c gap-59 deliverable. Single source of truth for "acquire-lock,
 * run fn, release on every exit path" across the codebase. Both
 * `lib/installLock.ts:withInstallLock` (Plan 3a installAll serialization)
 * AND `security/manifest-cache.ts:refreshManifest` (Plan 3c manifest
 * cache writes) MUST delegate to `withFileLockSync` here — there is NO
 * parallel lock implementation in the codebase per CR-46 / Rule 0
 * (single-source-of-truth for lock semantics).
 *
 * What this primitive provides:
 * 1. mkdirSync the lock parent dir if absent (fresh-repo / fresh-home case).
 * 2. proper-lockfile.lockSync acquires the lock; we wrap the manual retry
 *    loop because lockSync rejects retries>0 (`Cannot use retries with
 *    the sync api` per node_modules/proper-lockfile/lib/adapter.js).
 * 3. Surface ELOCKED (POSIX) and EBUSY (Windows) as the same FileLockBusyError.
 * 4. Persist the lock-holder PID alongside the lock as `<lockPath>.pid` so
 *    the next contender can include it in a user-friendly error message.
 * 5. Default 30s block-then-bail per Plan 3a §190; configurable per-callsite.
 * 6. `errorFactory` opt lets callers customize the busy-error class so
 *    domain-specific helpers (`InstallLockBusyError`, future Phase 5
 *    `ManifestCacheBusyError`) can extend the base type without each
 *    re-implementing the lock logic.
 *
 * NOT provided by this primitive:
 * - Async variant (`withFileLockAsync`). The current Phase 5 cache-write
 *   path resolves the async fetch BEFORE acquiring the lock, so the lock
 *   is held only during the brief sync atomicWrite. Async-while-holding-
 *   the-lock would deadlock under contention; the design is "fetch first,
 *   then lock-for-write only".
 * - Reentrancy. `proper-lockfile.lockSync` is non-reentrant; calling
 *   withFileLockSync recursively from inside its own `fn` will fail with
 *   ELOCKED. Plan 3a observed and documented this in
 *   __tests__/watch/config-refresh-autoyes.test.ts:129.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import * as lockfile from 'proper-lockfile';

export interface FileLockOpts {
  /** Default 30s — proper-lockfile considers a lock stale after this elapses. */
  staleMs?: number;
  /**
   * How long the manual retry loop should block waiting for the holder to
   * release before bailing with the busy error. Default 30s.
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
  /**
   * Optional custom busy-error factory. When provided, the default
   * FileLockBusyError throw is replaced with whatever this factory returns.
   * Domain-specific callers (installLock, manifest-cache) use this to
   * keep their own user-facing error types and messages.
   */
  errorFactory?: (
    lockPath: string,
    holderPid: number | null,
    retryAfterSeconds: number,
    causeCode: string | undefined,
  ) => Error;
}

export class FileLockBusyError extends Error {
  constructor(
    public lockPath: string,
    public holderPid: number | null,
    public retryAfterSeconds: number,
    public causeCode?: string,
  ) {
    const pidPart = holderPid != null ? `(PID=${holderPid})` : '(PID=unknown)';
    super(`File lock at ${lockPath} held by another process ${pidPart} — try again in ${retryAfterSeconds}s`);
    this.name = 'FileLockBusyError';
  }
}

/**
 * Best-effort: read the PID of the current lock holder from the
 * `<lockPath>.pid` sidecar file. Returns null on any read error.
 */
export function readLockHolderPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(`${lockPath}.pid`, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

export function busyWaitSync(ms: number): void {
  const end = Date.now() + ms;
  if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
    return;
  }
  while (Date.now() < end) {
    // Spin — modern Node always has Atomics; this is a fallback for sandboxed envs.
  }
}

/**
 * Acquire the lock at `lockPath`, run `fn`, release on every exit path.
 * Synchronous all the way through. See module-level doc for guarantees.
 *
 * Throws:
 * - The result of `opts.errorFactory(...)` if provided AND lock is busy
 *   beyond `blockMs`. Otherwise throws FileLockBusyError.
 * - Any non-ELOCKED/EBUSY filesystem error from proper-lockfile is
 *   re-thrown unchanged.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: FileLockOpts = {}): T {
  // Ensure the lock's parent directory exists. Fresh repos / fresh user-home
  // .massu/ may not have the parent yet.
  mkdirSync(dirname(lockPath), { recursive: true });

  const staleMs = opts.staleMs ?? 30_000;
  const blockMs = opts.retries === 0 ? 0 : (opts.blockMs ?? 30_000);
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? busyWaitSync;
  const makeBusyError =
    opts.errorFactory ??
    ((path, pid, retrySeconds, code) => new FileLockBusyError(path, pid, retrySeconds, code));

  let release: (() => void) | null = null;
  const deadline = now() + blockMs;

  for (;;) {
    try {
      release = lockfile.lockSync(lockPath, {
        stale: staleMs,
        retries: 0,
        realpath: false,
      });
      try {
        writeFileSync(`${lockPath}.pid`, String(process.pid), 'utf-8');
      } catch {
        // best-effort
      }
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const code = e.code;
      if (code !== 'ELOCKED' && code !== 'EBUSY') {
        throw err;
      }
      if (now() >= deadline) {
        const holderPid = readLockHolderPid(lockPath);
        const remainingMs = Math.max(0, deadline - now());
        const retryAfterSeconds = blockMs === 0
          ? Math.round(staleMs / 1000)
          : Math.round(remainingMs / 1000);
        throw makeBusyError(lockPath, holderPid, retryAfterSeconds, code);
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

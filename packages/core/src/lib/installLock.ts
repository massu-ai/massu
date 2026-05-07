// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Synchronous file lock around installAll() for cross-process safety.
 *
 * Plan 3a Phase 6: installAll() may now be invoked from BOTH the manual
 * `runConfigRefresh` path AND the watcher auto-trigger. Without
 * serialization, two concurrent callers can race on `.claude/commands/`
 * file writes. proper-lockfile gives us atomic mkdir-based locks that
 * work cross-platform.
 *
 * Plan 3c gap-59 / Rule 0 single-source-of-truth refactor (commit pending,
 * 2026-05-07): the proper-lockfile-wrapping logic + manual retry loop +
 * .pid sidecar bookkeeping now lives in `lib/fileLock.ts:withFileLockSync`.
 * This file is a thin domain-specific wrapper that:
 *   1. Computes the project-root-anchored lockPath
 *   2. Delegates to withFileLockSync via an `errorFactory` that returns
 *      `InstallLockBusyError` (preserving the exact error message format
 *      Plan 3a §243 specified and the install-lock tests assert)
 *
 * Plan 3a §190 retry behavior preserved: "second caller blocks up to 30s,
 * then bails". InstallLockBusyError instances continue to expose
 * `lockPath`, `holderPid`, `retryAfterSeconds`, `causeCode` — backwards-
 * compatible for any caller that does `instanceof InstallLockBusyError`.
 */

import { resolve } from 'path';
import { withFileLockSync, type FileLockOpts } from './fileLock.js';

export interface InstallLockOpts extends FileLockOpts {
  // No additional fields — all options come from FileLockOpts. This alias
  // preserves the public surface for any caller that imported `InstallLockOpts`.
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
 * Acquire the install lock for `projectRoot`, run `fn`, release on every
 * exit path. Throws `InstallLockBusyError` when the lock is held beyond
 * `blockMs`. See `lib/fileLock.ts:withFileLockSync` for the underlying
 * primitive.
 */
export function withInstallLock<T>(projectRoot: string, fn: () => T, opts: InstallLockOpts = {}): T {
  const lockPath = resolve(projectRoot, '.massu', 'installAll.lock');
  return withFileLockSync(
    lockPath,
    fn,
    {
      ...opts,
      errorFactory: (path, pid, retrySeconds, code) =>
        new InstallLockBusyError(path, pid, retrySeconds, code),
    },
  );
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Lockfile mid-write detector.
 *
 * If a `*.lock` file's mtime has shifted within the last LOCKFILE_WINDOW_MS,
 * a writer is still active and the watcher should defer applying refresh
 * for another debounce cycle.
 *
 * This is the canonical "wait for writer to settle" hook (chokidar's
 * `awaitWriteFinish` is intentionally disabled — see watcher spec §2).
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

export const LOCKFILE_WINDOW_MS = 500;

export const KNOWN_LOCKFILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'mix.lock',
  'go.sum',
] as const;

/**
 * Returns true when at least one known lockfile under projectRoot has
 * been modified within `windowMs` of `now`. Used by the quiescence
 * detector to extend the debounce when a package manager is mid-write.
 */
export function lockfileMidWrite(projectRoot: string, now = Date.now(), windowMs = LOCKFILE_WINDOW_MS): boolean {
  for (const lf of KNOWN_LOCKFILES) {
    const p = resolve(projectRoot, lf);
    if (!existsSync(p)) continue;
    try {
      const stat = statSync(p);
      const delta = now - stat.mtimeMs;
      if (delta >= 0 && delta < windowMs) return true;
    } catch {
      // Race with rename; treat as not-mid-write. Next debounce cycle re-checks.
    }
  }
  return false;
}

/**
 * Returns true when a git operation that must not be interrupted is active.
 * Watcher hard-stops (refuses to apply) until this returns false.
 */
export function gitMidOperation(projectRoot: string): boolean {
  const sentinels = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-apply', 'rebase-merge'];
  for (const s of sentinels) {
    if (existsSync(resolve(projectRoot, '.git', s))) return true;
  }
  return false;
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Watcher state persistence — `.massu/watch-state.json`.
 *
 * Crash-recovery contract: every mutation goes through writeStateAtomic()
 * (write `.tmp` → fsyncSync → renameSync). At any kill -9 point either the
 * old state or the new state survives intact (POSIX rename atomicity).
 *
 * Schema versioning: top-level `schema_version` field. Migrators in
 * STATE_MIGRATORS bump from `from` → `from + 1` until MAX_SUPPORTED.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'fs';
import { dirname, resolve } from 'path';

export const MIN_SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_SUPPORTED_SCHEMA_VERSION = 1;

export interface WatchState {
  schema_version: number;
  lastFingerprint: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  daemonPid: number | null;
  startedAt: string | null;
  tickedAt: string | null;
}

export const DEFAULT_STATE: WatchState = {
  schema_version: MAX_SUPPORTED_SCHEMA_VERSION,
  lastFingerprint: null,
  lastRefreshAt: null,
  lastError: null,
  daemonPid: null,
  startedAt: null,
  tickedAt: null,
};

/**
 * Bumps state from a known prior version to `from + 1`. Empty at ship.
 * When a future schema bump lands, register a migrator here for every
 * `from` in [MIN_SUPPORTED_SCHEMA_VERSION..MAX_SUPPORTED_SCHEMA_VERSION-1].
 */
export const STATE_MIGRATORS: Record<number, (old: Record<string, unknown>) => Record<string, unknown>> = {};

export function watchStatePath(projectRoot: string): string {
  return resolve(projectRoot, '.massu', 'watch-state.json');
}

export function backupStatePath(projectRoot: string): string {
  return resolve(projectRoot, '.massu', 'watch-state.v0.bak.json');
}

export class WatchStateNewerError extends Error {
  constructor(public stateVersion: number, public daemonMax: number) {
    super(`watch-state from newer massu version (v=${stateVersion}, daemon supports v=${daemonMax}); refusing to overwrite — upgrade massu or delete .massu/watch-state.json`);
    this.name = 'WatchStateNewerError';
  }
}

/**
 * Read state from disk. Behavior on schema mismatch:
 *  - missing schema_version: archive to backup path, return DEFAULT_STATE
 *  - older than supported: run STATE_MIGRATORS in sequence
 *  - newer than supported: throw WatchStateNewerError
 */
export function readState(projectRoot: string): WatchState {
  const path = watchStatePath(projectRoot);
  if (!existsSync(path)) return { ...DEFAULT_STATE };

  // Read once; reuse the content for archive-on-corrupt to avoid a redundant
  // disk read in the failure path (iter-9 simplify finding E1).
  const content = readFileSync(path, 'utf-8');

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    archiveCorrupt(projectRoot, content);
    return { ...DEFAULT_STATE };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_STATE };
  }

  const obj = raw as Record<string, unknown>;
  const ver = obj.schema_version;

  if (typeof ver !== 'number') {
    archiveCorrupt(projectRoot, content);
    return { ...DEFAULT_STATE };
  }

  if (ver > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new WatchStateNewerError(ver, MAX_SUPPORTED_SCHEMA_VERSION);
  }

  let migrated: Record<string, unknown> = obj;
  for (let v = ver; v < MAX_SUPPORTED_SCHEMA_VERSION; v++) {
    const migrator = STATE_MIGRATORS[v];
    if (!migrator) {
      throw new Error(
        `watch-state.json: missing migrator for schema_version ${v} -> ${v + 1}. ` +
        `Daemon supports up to v=${MAX_SUPPORTED_SCHEMA_VERSION}; this is a massu bug. ` +
        `Workaround: delete .massu/watch-state.json (the daemon will rebuild it on next start).`,
      );
    }
    migrated = migrator(migrated);
  }

  return {
    schema_version: MAX_SUPPORTED_SCHEMA_VERSION,
    lastFingerprint: typeof migrated.lastFingerprint === 'string' ? migrated.lastFingerprint : null,
    lastRefreshAt: typeof migrated.lastRefreshAt === 'string' ? migrated.lastRefreshAt : null,
    lastError: typeof migrated.lastError === 'string' ? migrated.lastError : null,
    daemonPid: typeof migrated.daemonPid === 'number' ? migrated.daemonPid : null,
    startedAt: typeof migrated.startedAt === 'string' ? migrated.startedAt : null,
    tickedAt: typeof migrated.tickedAt === 'string' ? migrated.tickedAt : null,
  };
}

function archiveCorrupt(projectRoot: string, content: string): void {
  const bak = backupStatePath(projectRoot);
  mkdirSync(dirname(bak), { recursive: true });
  writeFileSync(bak, content, 'utf-8');
}

// Per-process counter for unique temp filenames. Combined with PID this
// makes the temp path unique across concurrent writers in the same project.
let writeStateAtomicCounter = 0;

/**
 * Atomic write: tmp + fsync + rename. Survives kill -9 at any point.
 *
 * The temp filename is `<path>.<pid>.<counter>.tmp` so that two concurrent
 * processes (e.g. foreground daemon + a `massu watch --apply-now` racing
 * against it) never share the same temp file. POSIX rename is atomic per
 * (target) so the final state file always reflects exactly one of the
 * concurrent writers — never a torn write.
 */
export function writeStateAtomic(projectRoot: string, state: WatchState): void {
  const path = watchStatePath(projectRoot);
  writeStateAtomicCounter = (writeStateAtomicCounter + 1) >>> 0;
  const tmp = `${path}.${process.pid}.${writeStateAtomicCounter}.tmp`;
  mkdirSync(dirname(path), { recursive: true });

  // Iter-8 fix: clean up tmp on error. Without this, a writeSync/fsyncSync
  // failure (e.g., ENOSPC, EIO mid-write) leaves a `.<pid>.<counter>.tmp`
  // straggler in `.massu/` for every failed attempt. Mirrors the cleanup-on-
  // error pattern used by `atomicWriteFile` in install-commands.ts.
  let renamed = false;
  try {
    const fd = openSync(tmp, 'w');
    try {
      const buf = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf-8');
      writeSync(fd, buf, 0, buf.length, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed && existsSync(tmp)) {
      try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    }
  }
}

export function updateState(projectRoot: string, patch: Partial<WatchState>): WatchState {
  const current = readState(projectRoot);
  const next: WatchState = { ...current, ...patch, schema_version: MAX_SUPPORTED_SCHEMA_VERSION };
  writeStateAtomic(projectRoot, next);
  return next;
}

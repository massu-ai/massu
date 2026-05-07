/**
 * Atomic write-then-rename primitive for security-relevant state files.
 *
 * Plan 3c gap-37 + gap-41 deliverable: extracted from init.ts:writeConfigAtomic
 * (which used to inline this pattern with a hardcoded 0o644 mode and a
 * config-specific YAML/Zod validation step) so that BOTH init.ts and the new
 * Phase 5 security modules import the same helper. CR-46 / Rule 0 compliance:
 * no parallel third atomic-write helper exists in the codebase.
 *
 * Guarantees:
 * 1. Parent directory is created (recursively) with `ensureParentDirMode` if
 *    passed (typically 0o700 for ~/.massu/ per gap-37). Existing parent dirs
 *    are NOT chmod'd — that would clobber an operator's deliberate widening.
 * 2. Content is written to `${path}.tmp` via openSync + writeSync + fsyncSync
 *    + closeSync. The fsync is REQUIRED (xfs / ext4 `data=writeback` will
 *    rename-before-data on crash without it; init.ts iter-7 fix codified this).
 * 3. After tmp is durably on disk, renameSync moves it to the final path
 *    atomically (POSIX guarantees readers see EITHER old OR new, never torn).
 * 4. If `mode` is provided, chmodSync is applied AFTER rename so the final
 *    mode is exact (openSync's third arg is masked by the process umask;
 *    explicit chmod is the only way to guarantee 0o600 on systems with
 *    umask 0o022 or stricter).
 * 5. ANY error during the write/rename sequence triggers tmp cleanup before
 *    the error propagates. Original file at `path` is untouched on error.
 *
 * Concurrency:
 * - Reader side: NO lock acquired. POSIX renameSync is atomic; readers see
 *   EITHER old OR new content, never torn. This is sufficient for the cache
 *   read paths (manifest cache, fingerprint cache).
 * - Writer side: this helper does NOT serialize concurrent writers. If two
 *   processes call atomicWrite on the same path concurrently, both will
 *   succeed but the second will silently overwrite the first. For Phase 5's
 *   manifest cache (where racing `adapters refresh` invocations from the 3a
 *   watcher + manual install + coverage CLI are plausible per gap-59), the
 *   caller must acquire the advisory lock at `~/.massu/.adapter-manifest.lock`
 *   FIRST via `withFileLock()` (sibling helper). This module's job is just
 *   the write atomicity, not write serialization.
 *
 * Use this helper for any file that:
 * - Gates security decisions (cache invalidation, signature verification,
 *   path fingerprinting), OR
 * - Must survive crash / SIGKILL / power loss without ending up zero-byte, OR
 * - Has concurrent readers that must never see partial content.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  /**
   * File mode applied to the final path via chmodSync after rename.
   * Defaults to undefined (existing-mode preservation, or system default for
   * new files). Pass 0o600 for security-relevant cache files (manifest,
   * fingerprint, etc.) per Plan 3c gap-37.
   */
  mode?: number;
  /**
   * If passed AND the parent directory does NOT exist, mkdirSync creates it
   * with this mode. Pass 0o700 for ~/.massu/ per Plan 3c gap-37 deliverable.
   * Existing parent directories are NOT chmod'd — operators may have
   * deliberately widened the dir for sharing/sync.
   */
  ensureParentDirMode?: number;
}

export interface AtomicWriteResult {
  /** True when the rename succeeded and the final mode (if requested) is in place. */
  written: boolean;
  /** Error message when written is false. */
  error?: string;
}

/**
 * Atomically write `content` to `path`. See module-level doc for guarantees.
 *
 * Returns `{ written: true }` on success, `{ written: false, error }` on
 * failure (tmp file is cleaned up; original `path` is untouched).
 */
export function atomicWrite(
  path: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {},
): AtomicWriteResult {
  const tmpPath = `${path}.tmp`;
  const parentDir = dirname(path);

  try {
    if (!existsSync(parentDir)) {
      const mkdirOpts: { recursive: true; mode?: number } = { recursive: true };
      if (opts.ensureParentDirMode !== undefined) {
        mkdirOpts.mode = opts.ensureParentDirMode;
      }
      mkdirSync(parentDir, mkdirOpts);
    }

    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const openMode = opts.mode ?? 0o644;
    const fd = openSync(tmpPath, 'w', openMode);
    try {
      writeSync(fd, buf, 0, buf.length, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpPath, path);

    if (opts.mode !== undefined) {
      // openSync's mode is masked by umask; explicit chmod after rename is
      // the only way to guarantee 0o600. The chmod is best-effort wrapped
      // because some filesystems (network mounts) may reject chmod even
      // when the write succeeded — surface the error if it happens.
      chmodSync(path, opts.mode);
    }

    return { written: true };
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Tmp cleanup is best-effort; primary error wins.
      }
    }
    return { written: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stat a path and return whether it is group-writable or world-writable.
 * Used by Plan 3c gap-37 deliverable to emit a stderr warning when ~/.massu/
 * is shared across users via NFS / symlink / chmod widening — security-
 * relevant cache files MUST NOT be readable by other accounts on shared
 * systems.
 */
export function isGroupOrWorldWritable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const mode = statSync(path).mode;
    // 0o020 = group-write, 0o002 = other-write
    return (mode & 0o022) !== 0;
  } catch {
    return false;
  }
}

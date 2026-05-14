// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Shared IO helper for `.claude/settings.local.json` and the user-global
 * `~/.claude/settings.json`. SSOT for read+atomic-write semantics; closes
 * the pre-existing non-atomic-write bug at init.ts installHooks (previously
 * used writeFileSync which was vulnerable to SIGINT-between-truncate-and-write).
 *
 * Three exports:
 *   - readSettingsLocal(claudeDir): safe-parse of <claudeDir>/settings.local.json
 *   - writeSettingsLocalAtomic(claudeDir, settings): atomic write of same
 *   - readSettingsAtPath(absolutePath): generic safe-parse used by readSettingsLocal
 *     AND by permissions.ts:readGlobalSettings() reading ~/.claude/settings.json
 *
 * Plus the atomicWriteFile primitive (moved here from install-commands.ts to
 * centralize). All consumers — install-commands manifest save, install-commands
 * per-file syncs, init.ts installHooks, doctor.ts hooks-config check — share
 * this single source of truth for filesystem IO.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'fs';
import { dirname, resolve } from 'path';

/**
 * Atomic file write — tmp + fsync + rename. Moved from install-commands.ts so
 * it can be reused by settings-local IO without circular import.
 *
 * Writes via openSync + writeSync + fsyncSync + closeSync + renameSync so the
 * data hits the platter before the rename. On any error, removes the tmp file.
 * Tmp filename includes process.pid to avoid clashes with concurrent installs.
 */
export function atomicWriteFile(targetPath: string, content: string, mode = 0o644): void {
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmpPath, 'w', mode);
    try {
      const buf = Buffer.from(content, 'utf-8');
      writeSync(fd, buf, 0, buf.length, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Generic safe-parse of a JSON settings file. Used by readSettingsLocal
 * (project-local) AND permissions.ts:readGlobalSettings (user-global).
 *
 * Returns `{}` on any failure path: missing file, unreadable, malformed JSON,
 * non-object root. This contract lets callers do `(settings.permissions as any)`
 * shape-checks defensively without a separate "does the file exist" pre-check.
 */
export function readSettingsAtPath(absolutePath: string): Record<string, unknown> {
  if (!existsSync(absolutePath)) {
    return {};
  }
  try {
    const raw = readFileSync(absolutePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Read `<claudeDir>/settings.local.json`. Returns `{}` on missing/corrupt.
 */
export function readSettingsLocal(claudeDir: string): Record<string, unknown> {
  return readSettingsAtPath(resolve(claudeDir, 'settings.local.json'));
}

/**
 * Atomically write `<claudeDir>/settings.local.json`. Creates the parent
 * directory if missing. JSON.stringify with 2-space indent + trailing newline
 * (matches the existing convention in init.ts installHooks).
 */
export function writeSettingsLocalAtomic(
  claudeDir: string,
  settings: Record<string, unknown>,
): void {
  const targetPath = resolve(claudeDir, 'settings.local.json');
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(settings, null, 2) + '\n';
  atomicWriteFile(targetPath, content);
}

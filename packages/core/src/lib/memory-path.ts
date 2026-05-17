// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Memory directory name encoding — canonical helpers.
 *
 * Single source of truth for translating a project's absolute filesystem
 * root into the directory name used under `~/.claude/projects/<encoded-root>/memory/`.
 *
 * Closes the P-004 install-path drift class: the writer in `commands/init.ts`
 * historically prepended an EXTRA leading `-` while the reader in
 * `config.ts:getResolvedPaths()` and the backfill code path used the
 * canonical single-dash form. Result: 100% of `massu init` runs orphaned
 * `MEMORY.md` in a directory the reader could never find.
 *
 * Both encoding and decoding live here so the round-trip property is testable.
 *
 * Encoding rule:
 *   Replace every `/` in the absolute project root with `-`.
 *   An absolute path always starts with `/`, so the result always starts with
 *   `-` exactly once. NEVER prepend an additional `-`.
 *
 * Decoding rule:
 *   Replace every `-` in the directory name with `/`. This is the canonical
 *   inverse used by Claude Code's session-state plumbing. Note: project roots
 *   that contain literal `-` characters cannot be unambiguously round-tripped
 *   through this encoding — the same trade-off Claude Code's own resolver makes.
 */

/**
 * Encode an absolute project root into the directory name used under
 * `~/.claude/projects/<dir>/memory/`.
 *
 * @param projectRoot Absolute filesystem path (must start with `/`).
 * @returns Canonical encoded directory name (always begins with `-`).
 */
export function encodeMemoryDirName(projectRoot: string): string {
  return projectRoot.replace(/\//g, '-');
}

/**
 * Decode a memory-directory name back to its slash-separated form.
 *
 * @param dirname The directory name as it appears under `~/.claude/projects/`.
 * @returns A slash-separated path (begins with `/`).
 */
export function decodeMemoryDirName(dirname: string): string {
  return dirname.replace(/-/g, '/');
}

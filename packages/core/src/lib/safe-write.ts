// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Shared write-safety primitives for anything that touches a user's files
 * (Slice 4: A-13, A-14, A-15).
 *
 * ONE implementation, used by BOTH the existing rule-candidate applier and the
 * future memory-file renderer. Two copies of a containment check is how a
 * containment check ends up containing nothing — and this repo has already been
 * bitten twice by a duplicated path helper (`lib/memory-path.ts`, and the
 * session-start encoder that resolved to a directory that did not exist).
 *
 * Three primitives:
 *   assertContainedIn  — symlink-aware, parameterised by the ROOT (A-15)
 *   atomicWriteFileSync — temp + fsync + rename; a crash never truncates (A-14)
 *   assertSingleLine   — no embedded newlines in an index line (A-13)
 */
import {
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  realpathSync,
  unlinkSync,
  accessSync,
  statSync,
  chmodSync,
  constants,
} from 'fs';
import { dirname, resolve, relative, isAbsolute, basename, sep } from 'path';
import { createHash } from 'crypto';

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

export class UnsafeLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeLineError';
  }
}

/** Windows reserved device names. `con.md` is a valid slug and an unwritable file. */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * A-15 — assert `candidate` resolves INSIDE `rootDir`, symlinks included.
 *
 * Generalised from the `custom-destination` check in `rule-candidate-applier.ts`,
 * which hard-coded `projectRoot` as the anchor. That anchor is wrong for the memory
 * directory, which lives under `$HOME` and is OUTSIDE the project root by
 * construction — so "reuse it verbatim" would have rejected every legitimate memory
 * path, and hand-retargeting it is exactly how a containment check silently stops
 * containing anything.
 *
 * Two layers, because either alone is defeatable:
 *   1. LEXICAL: `relative(root, candidate)` must not escape. Cheap, but symlink-blind.
 *   2. REALPATH: resolve the nearest EXISTING ancestor (the target itself may not
 *      exist yet) and re-check. This is what catches `memory/evil.md -> ~/.ssh/…`.
 *
 * NESTING POLICY (`allowNested`) — the one thing the two anchors genuinely differ on:
 *   - The MEMORY DIR is FLAT by design. A memory is `<slug>.md`, never `a/b/c.md`.
 *     Forbidding a separator outright is a real safety property there, so the default
 *     is `false` — the strict setting, chosen deliberately as the default so that a
 *     new caller has to ASK for the looser one.
 *   - `custom-destination` legitimately points at nested repo paths (the shipped
 *     example in `massu.config.yaml` is `docs/brand-voice.md`). Refusing a separator
 *     there would break it — which is precisely how "just reuse the containment check
 *     verbatim" turns a safety fix into a regression.
 * Traversal (`..`), escape, NUL, and reserved device names are refused under BOTH
 * policies. `allowNested` widens WHERE inside the root, never WHETHER inside it.
 */
export function assertContainedIn(
  rootDir: string,
  candidate: string,
  opts: { allowNested?: boolean } = {},
): string {
  if (candidate.includes('\0')) {
    throw new PathEscapeError('path contains a NUL byte');
  }

  const root = resolve(rootDir);
  const abs = resolve(root, candidate);

  // A single flat file inside root — never a nested path we did not intend.
  if (!opts.allowNested) {
    const rel = relative(root, abs);
    if (rel.includes(sep)) {
      throw new PathEscapeError(`path must be a plain basename inside ${root}: ${candidate}`);
    }
  }

  // WRITE-SAFETY (this is what separates `assertContainedIn` from the pure
  // containment core below): a name that is contained can still be unwritable or
  // dangerous. `con.md` is a valid slug and an unwritable file on Windows.
  const base = basename(abs);
  const stem = base.replace(/\.[^.]*$/, '').toLowerCase();
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    throw new PathEscapeError(`reserved device name: ${base}`);
  }

  if (!isContainedIn(root, abs)) {
    throw new PathEscapeError(`path escapes ${root}: ${candidate}`);
  }

  return abs;
}

/**
 * The CONTAINMENT CORE — pure, boolean, no write-safety opinions.
 *
 * `assertContainedIn` (the WRITE path) layers reserved-device-names, NUL bytes and the
 * flat-basename rule on top of this. Read-only callers that merely need "is this path
 * inside that root, symlinks included" use this directly.
 *
 * This exists because `detect/source-dir-detector.ts` had its OWN realpath+startsWith
 * containment check — a THIRD copy, found by the B-02 drift-guard. Consolidating it
 * onto `assertContainedIn` verbatim would have been wrong (it would have started
 * rejecting a source directory named `con`, and rejecting the root itself, which that
 * detector legitimately probes as `.`). The right structural answer is not "one
 * function with five flags" but "one containment core, two thin policies over it".
 *
 * @param allowRoot  candidate === root counts as contained (the source-dir detector
 *                   probes `.`; a writer must never target the directory itself)
 */
export function isContainedIn(
  rootDir: string,
  candidate: string,
  opts: { allowRoot?: boolean } = {},
): boolean {
  if (candidate.includes('\0')) return false;

  const root = resolve(rootDir);
  const abs = resolve(root, candidate);

  // 1. Lexical containment. Cheap, but symlink-blind.
  const rel = relative(root, abs);
  if (rel === '' && !opts.allowRoot) return false;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;

  // 2. Symlink-aware containment. `realpathSync` on a not-yet-existing target throws
  // ENOENT, so walk up to the nearest ancestor that DOES exist. (The original applier
  // code swallowed that ENOENT and proceeded — meaning a not-yet-existing target was
  // never symlink-checked at all.)
  let probe = abs;
  while (!existsSync(probe) && probe.length > 1) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  let realRoot: string;
  let realProbe: string;
  try {
    realRoot = realpathSync(root);
    realProbe = realpathSync(probe);
  } catch {
    // The ROOT itself does not exist (fresh machine, no memory dir). Nothing to
    // contain; the caller's own "does the dir exist" gate decides. The lexical check
    // above already passed.
    return true;
  }

  const realRel = relative(realRoot, realProbe);
  if (realRel === '') return true; // the probe IS the root (an ancestor walk landed there)
  return !realRel.startsWith('..') && !isAbsolute(realRel);
}

/**
 * A-14 — write atomically: temp file in the SAME directory, fsync, then rename.
 *
 * Every write in the existing precedent is a truncating `writeFileSync`. A crash,
 * a full disk, or an ENOSPC part-way through leaves the user's memory file
 * TRUNCATED — the exact catastrophe the slice exists to prevent, arriving by a
 * route nobody modelled. `rename(2)` is atomic on POSIX and on NTFS: the file is
 * either the old bytes or the new bytes, never half of either.
 *
 * The temp file must share the destination's directory, or the rename becomes a
 * cross-device copy and loses atomicity.
 */
export function atomicWriteFileSync(destPath: string, contents: string): void {
  const dir = dirname(destPath);
  const tmp = resolve(dir, `.${basename(destPath)}.massu-tmp-${process.pid}`);

  // ATOMICITY MUST NOT COST PERMISSION SEMANTICS.
  //
  // `rename(2)` only needs the DIRECTORY to be writable — it will happily replace a
  // file the user marked read-only, and it replaces the destination's MODE with the
  // temp file's. Both are wrong here:
  //
  //   - A user who chmods a memory file to 0444 is SAYING "do not modify this".
  //     Silently overriding that is precisely the class of thing this slice exists
  //     to prevent: the human's explicit signal governs. So we check writability
  //     first and fail exactly as a plain write would (EACCES).
  //   - Silently widening a 0600 memory file to 0644 on every write is a quiet
  //     permission downgrade. Carry the original mode across the rename.
  let destMode: number | undefined;
  if (existsSync(destPath)) {
    accessSync(destPath, constants.W_OK); // throws EACCES on a read-only file
    destMode = statSync(destPath).mode & 0o777;
  }

  let fd: number | undefined;
  try {
    writeFileSync(tmp, contents, 'utf-8');
    if (destMode !== undefined) chmodSync(tmp, destMode);
    // fsync the DATA before the rename, else a crash can leave a renamed-but-empty
    // file: the rename is atomic, the page cache is not.
    fd = openSync(tmp, 'r+');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, destPath);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** A slug is the ONLY thing that may become a filename. */
export const SLUG_ALLOWED = /^[a-z0-9_]+$/;

/**
 * Derive a filesystem-safe slug. Strips every non `[a-z0-9]`, collapses whitespace,
 * lowercases, caps at 60 chars. (Lifted here from `rule-candidate-applier.ts` so the
 * applier and the renderer share ONE implementation — a second slugger is how two
 * writers end up disagreeing about what a file is called.)
 */
export function deriveSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 60) || 'rule_candidate';
}

/**
 * A-05 — A MEMORY'S `name` IS NOT A FILENAME, AND MUST NEVER BE USED AS ONE.
 *
 * The frontmatter `name` is human prose. In the operator's real corpus:
 *   - THREE names contain a `/` (e.g. `massu-ai/massu IS PUBLIC — never commit …`),
 *   - 14 of 69 are not valid filenames at all (spaces, parens, em-dashes, `+`, `↔`).
 * The renderer's original design wrote `memory/<name>.md`. That is an ARBITRARY FILE
 * WRITE primitive: `../../CLAUDE.md` is one memory away, and `name` is also
 * human-editable and NOT unique. This is why identity in `memory_files` is `rel_path`,
 * and why nothing may join a raw `name` into a path.
 *
 * `deriveSlug` truncates at 60 chars, and the corpus is full of long near-identical
 * names — so two distinct memories can slug to the SAME file. A collision would make
 * one render silently clobber the other, every session. The `discriminator` (a stable
 * hash of the memory's identity) makes the mapping injective.
 *
 * @param name         the frontmatter name (untrusted prose)
 * @param discriminator a stable per-memory value (its `rel_path`); when supplied, an
 *                      8-char content hash is appended so distinct memories never collide
 */
export function memoryFileSlug(name: string, discriminator?: string): string {
  const base = deriveSlug(name);
  if (!discriminator) {
    if (!SLUG_ALLOWED.test(base)) throw new PathEscapeError(`name does not slug safely: ${name}`);
    return base;
  }
  const h = createHash('sha256').update(discriminator, 'utf-8').digest('hex').slice(0, 8);
  const slug = `${base.slice(0, 51)}_${h}`; // 51 + 1 + 8 = 60
  if (!SLUG_ALLOWED.test(slug)) throw new PathEscapeError(`name does not slug safely: ${name}`);
  return slug;
}

/**
 * A-13 — an index line is ONE line.
 *
 * `appendMemoryIndexLine` does no newline stripping. It is safe today only by
 * accident of its single callsite, which happens to sanitize. A second caller (the
 * renderer) passing a store-derived title with a `\n` in it injects arbitrary
 * multi-line markdown into MEMORY.md — a file the harness auto-loads into EVERY
 * session as trusted context. The append-only invariant would not even notice:
 * `post === pre + line + '\n'` holds no matter what is inside `line`.
 *
 * Do not rely on callsite discipline for a second time.
 */
export function assertSingleLine(line: string, maxLen = 300): string {
  if (/[\r\n]/.test(line)) {
    throw new UnsafeLineError('index line must not contain a newline');
  }
  if (line.includes('\0')) {
    throw new UnsafeLineError('index line must not contain a NUL byte');
  }
  if (line.length > maxLen) {
    throw new UnsafeLineError(`index line exceeds ${maxLen} chars (got ${line.length})`);
  }
  return line;
}

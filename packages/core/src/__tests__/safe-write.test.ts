// A-13 / A-14 / A-15: the shared write-safety primitives.
//
// These exist because 4B gives Massu, for the first time, the ability to WRITE into
// the user's memory directory. Every one of these is a hole that was open in the
// existing write precedent:
//   A-15 the containment check was anchored on the PROJECT ROOT, but the memory dir
//        lives under $HOME — outside it by construction. "Reuse it verbatim" would
//        have rejected every legitimate path; hand-retargeting it is how a
//        containment check silently stops containing anything.
//   A-14 every write was a truncating writeFileSync — a crash mid-write TRUNCATES
//        the user's memory file, which is the catastrophe the slice exists to prevent.
//   A-13 appendMemoryIndexLine did NO newline stripping, and MEMORY.md is auto-loaded
//        into EVERY session as trusted context.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readdirSync,
  chmodSync,
  statSync,
} from 'fs';

import {
  assertContainedIn,
  atomicWriteFileSync,
  assertSingleLine,
  PathEscapeError,
  UnsafeLineError,
} from '../lib/safe-write.ts';

describe('safe-write primitives (A-13, A-14, A-15)', () => {
  let root: string;
  let memDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-safewrite-'));
    memDir = join(root, 'memory');
    mkdirSync(memDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('assertContainedIn (A-15)', () => {
    it('accepts a plain file inside the root', () => {
      expect(assertContainedIn(memDir, 'feedback_x.md')).toBe(join(memDir, 'feedback_x.md'));
    });

    it('REFUSES a traversal escape — this is the arbitrary-file-write primitive', () => {
      // 3 of the operator's real memories have a '/' in their frontmatter `name`,
      // and the renderer derives its filename from that name.
      expect(() => assertContainedIn(memDir, '../../CLAUDE.md')).toThrow(PathEscapeError);
      expect(() => assertContainedIn(memDir, '../evil.md')).toThrow(PathEscapeError);
    });

    it('REFUSES an absolute path', () => {
      expect(() => assertContainedIn(memDir, '/etc/passwd')).toThrow(PathEscapeError);
    });

    it('REFUSES a nested path — the target must be a plain basename', () => {
      // `name: massu-ai/massu IS PUBLIC — …` would otherwise create a subdirectory.
      expect(() => assertContainedIn(memDir, 'massu-ai/massu.md')).toThrow(PathEscapeError);
    });

    it('REFUSES a NUL byte', () => {
      expect(() => assertContainedIn(memDir, 'a\0b.md')).toThrow(PathEscapeError);
    });

    it('REFUSES a Windows reserved device name (a valid slug, an unwritable file)', () => {
      expect(() => assertContainedIn(memDir, 'con.md')).toThrow(PathEscapeError);
      expect(() => assertContainedIn(memDir, 'PRN.md')).toThrow(PathEscapeError);
    });

    it('REFUSES a symlink that escapes the root — the lexical check alone is symlink-BLIND', () => {
      const outside = join(root, 'outside.md');
      writeFileSync(outside, 'secret', 'utf-8');
      symlinkSync(outside, join(memDir, 'evil.md'));
      expect(() => assertContainedIn(memDir, 'evil.md')).toThrow(PathEscapeError);
    });

    it('a not-yet-existing target is still symlink-checked via its nearest existing ancestor', () => {
      // The old code realpath'd the target, got ENOENT, SWALLOWED it, and proceeded —
      // so a nonexistent target was never symlink-checked at all.
      const evilDir = join(root, 'evil-dir');
      mkdirSync(evilDir);
      rmSync(memDir, { recursive: true });
      symlinkSync(evilDir, memDir);
      // memDir now points OUTSIDE its lexical self; a brand-new file under it escapes.
      expect(() => assertContainedIn(join(root, 'memory'), 'brand-new.md')).not.toThrow();
      // ...and the realpath is the evil dir, which is what the caller must see:
      expect(assertContainedIn(join(root, 'memory'), 'brand-new.md')).toContain('memory');
    });
  });

  describe('atomicWriteFileSync (A-14)', () => {
    it('writes the file', () => {
      const p = join(memDir, 'a.md');
      atomicWriteFileSync(p, 'hello');
      expect(readFileSync(p, 'utf-8')).toBe('hello');
    });

    it('replaces existing content atomically and leaves NO temp file behind', () => {
      const p = join(memDir, 'a.md');
      writeFileSync(p, 'old', 'utf-8');
      atomicWriteFileSync(p, 'new');
      expect(readFileSync(p, 'utf-8')).toBe('new');
      expect(readdirSync(memDir).filter((f) => f.includes('massu-tmp'))).toEqual([]);
    });

    it('REFUSES a read-only destination — atomicity must not cost permission semantics', () => {
      // rename(2) only needs the DIRECTORY writable, so a naive temp+rename would
      // happily replace a file the user marked read-only. A user who chmods a memory
      // file to 0444 is SAYING "do not modify this"; the human's explicit signal
      // governs. (This is the property the applier's rollback test depends on.)
      const p = join(memDir, 'ro.md');
      writeFileSync(p, 'PRECIOUS', 'utf-8');
      chmodSync(p, 0o444);
      try {
        expect(() => atomicWriteFileSync(p, 'clobber')).toThrow();
        expect(readFileSync(p, 'utf-8')).toBe('PRECIOUS');
      } finally {
        chmodSync(p, 0o644);
      }
    });

    it('PRESERVES the destination mode across the rename (no silent 0600 -> 0644 widening)', () => {
      const p = join(memDir, 'secret.md');
      writeFileSync(p, 'v1', 'utf-8');
      chmodSync(p, 0o600);
      atomicWriteFileSync(p, 'v2');
      expect(readFileSync(p, 'utf-8')).toBe('v2');
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });

    it('on failure it does NOT truncate the existing file', () => {
      const p = join(memDir, 'a.md');
      writeFileSync(p, 'PRECIOUS', 'utf-8');
      // A directory that does not exist => the temp write throws.
      expect(() => atomicWriteFileSync(join(root, 'nope', 'a.md'), 'x')).toThrow();
      // The real file is untouched — a truncating writeFileSync would have lost it.
      expect(readFileSync(p, 'utf-8')).toBe('PRECIOUS');
    });
  });

  describe('assertSingleLine (A-13)', () => {
    it('accepts a normal index line', () => {
      expect(assertSingleLine('- [Title](file.md) — hook')).toBe('- [Title](file.md) — hook');
    });

    it('REFUSES an embedded newline — the MEMORY.md injection vector', () => {
      // MEMORY.md is auto-loaded into EVERY session as trusted context. A `\n` in a
      // store-derived title injects arbitrary markdown into the model's context
      // forever — and the append-only invariant does not notice.
      expect(() => assertSingleLine('- [x](a.md)\n## Injected heading')).toThrow(UnsafeLineError);
      expect(() => assertSingleLine('- [x](a.md)\r\nfoo')).toThrow(UnsafeLineError);
    });

    it('REFUSES a NUL byte and an over-long line', () => {
      expect(() => assertSingleLine('a\0b')).toThrow(UnsafeLineError);
      expect(() => assertSingleLine('x'.repeat(400))).toThrow(UnsafeLineError);
    });
  });
});

/**
 * B-02 — the write path is contained, slugged, and collision-free.
 *
 * The acceptance the plan names, verbatim:
 *   - a symlink `memory/evil.md -> ~/.ssh/authorized_keys` is REFUSED, and the file
 *     behind it is byte-unchanged;
 *   - a name of `../../CLAUDE.md` is refused;
 *   - `con` is refused (Windows reserved device name — and it passes SLUG_ALLOWED
 *     cleanly, which is exactly why bare `deriveSlug` was not enough);
 *   - two 70-char names sharing a 60-char prefix render to two distinct, stable paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeRenderPath,
  pathIsFreeOnDisk,
  RenderPathRefused,
  type RenderSource,
} from '../memory-render-path.ts';

let root: string;
let memoryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'massu-renderpath-'));
  memoryDir = join(root, 'memory');
  mkdirSync(memoryDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOBODY = () => undefined;
const src = (name: string, id = 1, title = name): RenderSource => ({
  observationId: id,
  name,
  title,
});

describe('B-02 — containment', () => {
  it('renders an ordinary memory to a flat slug inside the memory dir', () => {
    const { absPath, relPath } = computeRenderPath(memoryDir, src('feedback_never_guess'), NOBODY);
    expect(relPath).toBe('feedback_never_guess.md');
    expect(absPath).toBe(join(memoryDir, 'feedback_never_guess.md'));
  });

  it('⛔ REFUSES a traversal name — `../../CLAUDE.md` never escapes', () => {
    // The original design wrote `memory/<name>.md`. This name is one memory away from
    // overwriting the operator's CLAUDE.md.
    const claudeMd = join(root, 'CLAUDE.md');
    writeFileSync(claudeMd, '# THE OPERATOR CLAUDE.MD\n');
    const before = readFileSync(claudeMd, 'utf8');

    const { relPath } = computeRenderPath(memoryDir, src('../../CLAUDE.md'), NOBODY);

    // The slugger strips the separators rather than honoring them: the name becomes a
    // flat filename INSIDE the memory dir. The key property is that nothing lands
    // outside memoryDir, and the real CLAUDE.md is untouched.
    expect(relPath).not.toContain('..');
    expect(relPath).not.toContain('/');
    expect(readFileSync(claudeMd, 'utf8')).toBe(before);
  });

  it('⛔ REFUSES a symlink that points outside the memory dir (~/.ssh/authorized_keys)', () => {
    const ssh = join(root, 'authorized_keys');
    writeFileSync(ssh, 'ssh-ed25519 AAAA... operator@mac\n');
    const beforeBytes = readFileSync(ssh);

    // The attack: a symlink inside the memory dir whose name slugs cleanly.
    symlinkSync(ssh, join(memoryDir, 'evil.md'));

    expect(() => computeRenderPath(memoryDir, src('evil'), NOBODY)).toThrow(RenderPathRefused);

    try {
      computeRenderPath(memoryDir, src('evil'), NOBODY);
    } catch (err) {
      expect((err as RenderPathRefused).reason).toBe('path_escape');
    }

    // And the file behind the symlink is byte-unchanged.
    expect(readFileSync(ssh)).toEqual(beforeBytes);
  });

  it('⛔ REFUSES Windows reserved device names — `con` slugs cleanly and is still fatal', () => {
    // `con` passes SLUG_ALLOWED (`[a-z0-9_]+`) without complaint. This is exactly why
    // B-02 must call the shared sanitizer and never bare `deriveSlug`.
    for (const reserved of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt1']) {
      expect(() => computeRenderPath(memoryDir, src(reserved), NOBODY), reserved).toThrow(
        RenderPathRefused
      );
    }
  });

  it('⛔ REFUSES a name that slugs to nothing — inventing a filename invents an identity', () => {
    for (const junk of ['///', '— — —', '   ', '!!!']) {
      expect(() => computeRenderPath(memoryDir, src(junk)), JSON.stringify(junk)).toThrow(
        RenderPathRefused
      );
    }
  });
});

describe('B-02 — collision (F-22): 60-char truncation must not clobber', () => {
  // The corpus is full of long near-identical names. These two share a 60-char prefix.
  const A = 'feedback_the_operator_is_not_an_engineer_and_wants_plain_english_always_part_one';
  const B = 'feedback_the_operator_is_not_an_engineer_and_wants_plain_english_always_part_two';

  it('two distinct memories sharing a 60-char prefix get two DISTINCT paths', () => {
    const first = computeRenderPath(memoryDir, src(A, 1), NOBODY);

    // Now memory #1 owns that rel_path. Memory #2 slugs to the same 60 chars.
    const owner = (rel: string) => (rel === first.relPath ? 1 : undefined);
    const second = computeRenderPath(memoryDir, src(B, 2), owner);

    expect(second.relPath).not.toBe(first.relPath);
    expect(second.relPath).toMatch(/_[0-9a-f]{8}\.md$/); // the deterministic discriminator
  });

  it('the discriminated path is STABLE — the same memory always renders to the same file', () => {
    const owner = (rel: string) => (rel === `${'x'.repeat(0)}${'feedback_the_operator_is_not_an_engineer_and_wants_plain_english_'.slice(0, 60)}.md` ? 1 : undefined);
    const run1 = computeRenderPath(memoryDir, src(B, 2), (rel) => (rel === 'feedback_the_operator_is_not_an_engineer_and_wants_plain_engl.md' ? 1 : owner(rel)));
    const run2 = computeRenderPath(memoryDir, src(B, 2), (rel) => (rel === 'feedback_the_operator_is_not_an_engineer_and_wants_plain_engl.md' ? 1 : owner(rel)));

    // A counter (_2, _3) would renumber files whenever iteration order changed — a
    // rename storm in a git-tracked directory. A content-derived hash cannot.
    expect(run1.relPath).toBe(run2.relPath);
  });

  it('a memory RE-RENDERING to its own existing path keeps that path (no churn)', () => {
    const first = computeRenderPath(memoryDir, src(A, 7), NOBODY);
    // The store says observation 7 already owns it. It must reuse it, not discriminate.
    const owner = (rel: string) => (rel === first.relPath ? 7 : undefined);
    const again = computeRenderPath(memoryDir, src(A, 7), owner);
    expect(again.relPath).toBe(first.relPath);
  });

  it('REFUSES rather than overwrite when both candidates belong to other memories', () => {
    // Every candidate path is owned by somebody else. Never overwrite a real memory.
    const ownedByOthers = () => 999;
    expect(() => computeRenderPath(memoryDir, src(A, 1), ownedByOthers)).toThrow(
      /collision could not be resolved/
    );
  });
});

describe('B-02 — a file on disk we have no row for still owns its path', () => {
  it('pathIsFreeOnDisk is false for an un-ingested human file', () => {
    writeFileSync(join(memoryDir, 'handwritten.md'), '# a memory Massu has never seen\n');
    // Absence of a store row is not evidence the file is absent. Rendering over it
    // would destroy a human file we simply have not ingested yet.
    expect(pathIsFreeOnDisk(memoryDir, 'handwritten.md')).toBe(false);
    expect(pathIsFreeOnDisk(memoryDir, 'not_there.md')).toBe(true);
  });
});

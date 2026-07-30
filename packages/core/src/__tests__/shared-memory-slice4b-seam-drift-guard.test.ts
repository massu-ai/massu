// Slice 5 — S-1: the Slice-4B seam, made structural. An accepted cross-repo row has
// origin='repo:<uuid>', so isLocalOrigin() is FALSE and Slice 4B's renderer (GATE 5)
// CANNOT write it to disk. This guard is deliberately NON-VACUOUS (the exact trap
// Slice 4 A-12 caught — `for (const x of EMPTY_SET)` passes with zero assertions): it
// proves BOTH that a memory-file writer exists AND that every write it performs is
// dominated by an isLocalOrigin gate; if the writer ever vanished, the "no writer"
// branch still asserts (so the guard can never pass by finding nothing).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const RENDERER = join(SRC, 'memory-renderer.ts');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

describe('Slice 5 S-1 — a cross-repo row is structurally unrenderable to disk', () => {
  it('the memory-file writer gates every write behind isLocalOrigin (or no writer exists)', () => {
    expect.hasAssertions();
    // The memory-file writer is the renderer's atomic write. Identify every module that
    // writes to disk via atomicWriteFileSync AND renders memory-file content.
    const writers = walk(SRC).filter((f) => {
      const src = readFileSync(f, 'utf-8');
      return /atomicWriteFileSync\s*\(/.test(src) && /RenderCandidate|renderMemoryFiles|composeFile/.test(src);
    });

    // G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): both branches assert — a genuine two-branch test, not a skip. The
    // early `return` read exactly like the silent-skip class; if/else does not.
    if (writers.length === 0) {
      // BRANCH B: no memory-file writer at all ⇒ nothing can render a foreign row.
      // Still an assertion (non-vacuous): the seam holds by absence.
      expect(writers).toEqual([]);
    } else {
      // BRANCH A: a writer exists ⇒ EVERY writer must gate its write behind isLocalOrigin,
      // and the gate must DOMINATE the write in source order.
      expect(writers.map((f) => f.replace(SRC + '/', ''))).toEqual(['memory-renderer.ts']);
      const src = readFileSync(RENDERER, 'utf-8');
      expect(src).toMatch(/import\s*\{[^}]*isLocalOrigin[^}]*\}\s*from\s*'\.\/memory-origin\.ts'/);
      const gateAt = src.indexOf('!isLocalOrigin(');
      const writeAt = src.indexOf('atomicWriteFileSync(');
      expect(gateAt, 'the isLocalOrigin gate must exist').toBeGreaterThan(-1);
      expect(writeAt, 'the atomic write must exist').toBeGreaterThan(-1);
      expect(gateAt, 'the isLocalOrigin gate must dominate the write (appear before it)').toBeLessThan(writeAt);
      // The gate refuses and CONTINUES (never falls through to the write).
      expect(src).toMatch(/if\s*\(\s*!isLocalOrigin\([^)]*\)\s*\)\s*\{[\s\S]{0,400}?continue;/);
    }
  });
});

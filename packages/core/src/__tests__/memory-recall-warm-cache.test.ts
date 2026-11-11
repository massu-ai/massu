// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Hook plan P5-003. The session's first prompt paid the embedding model's cold load (measured
 * 2026-11-10: first memory-recall 1.51 s, then 0.58-0.65 s). Session start now launches
 * `memory-recall.js --warm-cache` detached, so that load happens in the background.
 *
 * Both halves are checked against BUNDLES built from current source: the warm-up mode itself (no
 * stdin, always exit 0, one `warm-cache:` line), and that the built session-start launches it
 * detached and unref'd — a warm-up that blocked session start would cost what it saves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(CORE, 'node_modules', '.cache');
let out: string;

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true });
  out = mkdtempSync(join(CACHE, 'warm-cache-'));
  execFileSync('node', [join(CORE, 'scripts', 'build-bundles.mjs'), '--hooks', '--outdir', out], { stdio: 'pipe' });
});
afterAll(() => {
  if (out && out.startsWith(CACHE + '/')) rmSync(out, { recursive: true, force: true });
});

describe('memory-recall --warm-cache', () => {
  it('reads no stdin, always exits 0, and prints exactly one warm-cache line', () => {
    const home = mkdtempSync(join(tmpdir(), 'warm-home-'));
    try {
      // No `input`: if the mode read stdin it would wait on an open pipe; spawnSync closes it,
      // and the marker proves the warm-up path ran rather than an early exit.
      const r = spawnSync('node', [join(out, 'memory-recall.js'), '--warm-cache'], {
        env: { ...process.env, HOME: home }, encoding: 'utf-8', cwd: home,
      });
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stderr.split('\n').filter((l) => l.startsWith('warm-cache: '));
      expect(lines, r.stderr).toHaveLength(1);
      expect(['warm-cache: ok', 'warm-cache: null']).toContain(lines[0]);
      expect(r.stdout, 'the warm-up writes nothing a session would read as context').toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('with embeddings disabled it is a clean no-op: null, exit 0', () => {
    const r = spawnSync('node', [join(out, 'memory-recall.js'), '--warm-cache'], {
      env: { ...process.env, MASSU_DISABLE_EMBEDDINGS: '1' }, encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('warm-cache: null');
  });
});

describe('session-start launches the warm-up without waiting for it', () => {
  it('the built bundle spawns memory-recall.js --warm-cache detached, unref\'d, with ignored stdio', () => {
    const src = readFileSync(join(out, 'session-start.js'), 'utf-8');
    const m = /["']--warm-cache["']/.exec(src);
    const at = m ? m.index : -1;
    expect(at, 'session-start.js must launch the warm-up').toBeGreaterThan(-1);
    const call = src.slice(Math.max(0, at - 300), at + 300);
    expect(call).toMatch(/memory-recall\.js/);
    expect(call).toMatch(/detached:\s*true/);
    expect(call).toMatch(/stdio:\s*["']ignore["']/);
    expect(call).toMatch(/\.unref\(\)/);
  });
});

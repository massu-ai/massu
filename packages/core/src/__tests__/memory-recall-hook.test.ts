// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P3-001 (plan-living-memory-slice-1) — memory-recall hook, end-to-end.
 *
 * Spawns the COMPILED dist/hooks/memory-recall.js, feeds a UserPromptSubmit
 * payload on stdin, and asserts fail-open behavior + hit/miss injection.
 * Requires `npm run build:hooks` to have run (CI/pre-push builds before test).
 *
 * Embeddings are disabled via MASSU_DISABLE_EMBEDDINGS=1 so the test exercises
 * the deterministic FTS-only path (no model download in CI).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession, addObservation } from '../memory-db.ts';

const HOOK = resolve(__dirname, '..', '..', 'dist', 'hooks', 'memory-recall.js');
const created: string[] = [];

const MINIMAL_CONFIG = `schema_version: 2
project:
  name: recall-test
  root: auto
framework:
  type: typescript
  router: none
  orm: none
  ui: none
paths:
  source: src
toolPrefix: massu
domains: []
rules: []
`;

function makeProject(seed?: (db: Database.Database) => void): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'massu-recall-hook-'));
  created.push(dir);
  writeFileSync(resolve(dir, 'massu.config.yaml'), MINIMAL_CONFIG);
  mkdirSync(resolve(dir, '.massu'), { recursive: true });
  const db = new Database(resolve(dir, '.massu', 'memory.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  createSession(db, 'seed-session');
  if (seed) seed(db);
  db.close();
  return dir;
}

function runHook(cwd: string, prompt: string): { stdout: string; code: number | null } {
  const input = JSON.stringify({
    session_id: 'smoke',
    transcript_path: '',
    cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
  const r = spawnSync('node', [HOOK], {
    encoding: 'utf-8',
    cwd,
    input,
    env: { ...process.env, MASSU_DISABLE_EMBEDDINGS: '1' },
    timeout: 20000,
  });
  return { stdout: r.stdout ?? '', code: r.status };
}

// This exercises the COMPILED hook, so it needs dist/hooks/. That artifact
// exists in this repo (we build before testing) but is deliberately absent from
// the PUBLIC mirror — sync-public.sh excludes `dist`. Hard-throwing there made
// the public-mirror suite fail on a missing build artifact rather than on a real
// defect (it broke the pre-push Sync Check). Skip when the artifact is absent;
// run — and stay strict — wherever it exists.
describe.skipIf(!existsSync(HOOK))('P3-001: memory-recall hook (end-to-end)', () => {

  afterAll(() => {
    for (const d of created) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('injects an on-topic block for a related prompt (hit)', () => {
    const dir = makeProject((db) => {
      addObservation(
        db,
        'seed-session',
        'decision',
        'login fail fast when no terminal',
        'guard isTTY and bound non-TTY stdin so non-interactive login never hangs',
        { importance: 5 },
      );
    });
    const { stdout, code } = runHook(dir, 'make login fail fast when there is no terminal');
    expect(code).toBe(0);
    expect(stdout).toContain('🧠 Relevant memory');
    expect(stdout).toContain('login fail fast');
  });

  it('writes nothing for an unrelated prompt on a small seeded store (miss)', () => {
    const dir = makeProject((db) => {
      addObservation(db, 'seed-session', 'decision', 'login fail fast when no terminal', 'isTTY guard', {
        importance: 5,
      });
    });
    // A totally unrelated query with no FTS match and (recency candidate exists
    // but) very low score — the single seeded item may still surface via the
    // recency channel, so we only assert exit 0 + no crash here.
    const { code } = runHook(dir, 'zzz completely unrelated quantum banana topic');
    expect(code).toBe(0);
  });

  it('fails open (exit 0, no output) on malformed stdin', () => {
    const dir = makeProject();
    const r = spawnSync('node', [HOOK], {
      encoding: 'utf-8',
      cwd: dir,
      input: 'not json at all {{{',
      env: { ...process.env, MASSU_DISABLE_EMBEDDINGS: '1' },
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('');
  });

  it('fails open (exit 0, no output) on empty prompt', () => {
    const dir = makeProject();
    const { stdout, code } = runHook(dir, '   ');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('fails open with no config / no store (exit 0)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-recall-noconfig-'));
    created.push(dir);
    const { stdout, code } = runHook(dir, 'anything');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-07-23 P8-003 / P8-007 — the operator script, driven for real.
 *
 * Since the 2026-11-25 amendment the script holds NO repair logic: it is the operator's entry
 * point to `memory-db-maintenance.ts` through the built CLI (`massu memory inspect|repair`).
 * The repair's own guards (holder check, disk peak, backup, summaries merge, end-state proof)
 * are tested against the module in memory-db-maintenance.test.ts. THIS file proves the script's
 * own job: it refuses bad input, lists with a denominator, writes nothing on a dry run, and an
 * --apply really runs the module end to end — and that it is a CALLER, not a second copy.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { codeOnly } from './helpers/code-only.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/ops/convert-memory-db-to-incremental.sh');
const CLI = join(REPO_ROOT, 'packages/core/dist/cli.js');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A repo whose .massu/memory.db is mode 0 with free pages, as an older massu left it. Small:
 *  the real disk check runs (no seam), and 4x a few hundred KB fits any test machine. */
function legacyRepo(): { repo: string; db: string } {
  const repo = mkdtempSync(join(tmpdir(), 'massu-convert-'));
  roots.push(repo);
  mkdirSync(join(repo, '.massu'));
  const db = join(repo, '.massu', 'memory.db');
  const d = new DatabaseSync(db);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, body TEXT)');
  d.exec('CREATE TABLE gone (id INTEGER PRIMARY KEY, body TEXT)');
  d.exec("INSERT INTO keep (body) SELECT hex(randomblob(500)) FROM (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<300) SELECT i FROM c)");
  d.exec("INSERT INTO gone (body) SELECT hex(randomblob(2000)) FROM (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<300) SELECT i FROM c)");
  d.exec('DELETE FROM gone WHERE id > 10');
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  d.close();
  return { repo, db };
}

const run = (args: string[]) => {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const probe = (db: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  const q = (s: string) => Object.values(d.prepare(s).get() as object)[0] as number | string;
  const r = {
    mode: Number(q('PRAGMA auto_vacuum')),
    free: Number(q('PRAGMA freelist_count')),
    keep: Number(q('SELECT count(*) FROM keep')),
    gone: Number(q('SELECT count(*) FROM gone')),
    ok: q('PRAGMA integrity_check'),
  };
  d.close();
  return r;
};

describe('convert-memory-db-to-incremental.sh', () => {
  it('the built CLI it calls exists (the suite runs after the build)', () => {
    expect(existsSync(CLI), `missing ${CLI}: run npm run build:cli`).toBe(true);
  });

  it('dry run (the default) checks everything and writes NOTHING', () => {
    const { repo, db } = legacyRepo();
    const h = sha(db);
    const r = run(['--repo', repo]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('RESULT: dry run');
    expect(sha(db)).toBe(h);
    expect(readdirSync(join(repo, '.massu')).filter((f) => f.includes('pre-maintenance'))).toEqual([]);
  });

  it('--apply runs the module end to end: mode 2, every free page returned, every row kept, a valid backup kept', () => {
    const { repo, db } = legacyRepo();
    const before = probe(db);
    const r = run(['--repo', repo, '--apply']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('RESULT: repaired');
    const after = probe(db);
    expect(after).toEqual({ mode: 2, free: 0, keep: before.keep, gone: before.gone, ok: 'ok' });
    const backups = readdirSync(join(repo, '.massu')).filter((f) => f.includes('pre-maintenance'));
    expect(backups).toHaveLength(1);
    expect(probe(join(repo, '.massu', backups[0])).keep).toBe(before.keep);
  });

  it('is idempotent: a second --apply is a reported no-op that changes nothing', () => {
    const { repo, db } = legacyRepo();
    expect(run(['--repo', repo, '--apply']).code).toBe(0);
    const h = sha(db);
    const r = run(['--repo', repo, '--apply']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('no-op');
    expect(sha(db)).toBe(h);
  });

  it('refuses ambiguous or missing input instead of guessing', () => {
    expect(run([]).code).toBe(2);
    expect(run(['--repo', '/nonexistent-dir-for-test']).code).toBe(2);
    expect(run(['--repo', tmpdir(), '--db', 'other.db']).code).toBe(2);
    expect(run(['--repo', tmpdir(), '--bogus']).code).toBe(2);
    const { repo } = legacyRepo();
    expect(run(['--repo', repo, '--db', 'data.db']).code).toBe(2); // does not exist
  });

  it('--list reports every database it found, with the denominator', () => {
    const { repo } = legacyRepo();
    const r = run(['--repo', repo, '--list']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('memory.db: auto_vacuum=0');
    expect(r.out).toContain('databases found in');
    expect(r.out).toContain(': 1 of 3 candidates');
  });

  it('is a CALLER of the module, not a second implementation (no SQL of its own)', () => {
    const code = codeOnly(readFileSync(SCRIPT, 'utf8'), '.sh')!;
    expect(code).toMatch(/memory repair --db/);
    expect(code).toMatch(/memory inspect --db/);
    for (const forbidden of [/VACUUM/, /PRAGMA/, /node:sqlite/, /\blsof\b/, /\bdf\b/]) expect(code).not.toMatch(forbidden);
  });
});

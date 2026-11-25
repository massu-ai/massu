// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-07-23 P8-003 — the operator-run conversion script, driven for real on fixture databases.
 * Every refusal must leave the database byte-identical; every success must prove nothing was deleted.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/ops/convert-memory-db-to-incremental.sh');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  while (children.length) children.pop()!.kill('SIGKILL');
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A repo whose .massu/memory.db is mode 0 with free pages, as an older massu left it. */
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

const hasLsof = spawnSync('sh', ['-c', 'command -v lsof']).status === 0;

/**
 * Without lsof the script REFUSES everything (correct: it cannot check for holders), so on such a host (the
 * node:22-bookworm image, for one) the tests that are NOT about holders put a stub `lsof` first on PATH. It behaves
 * like real lsof finding no match: no output, exit 1. The script's own logic is unchanged; the holder test below
 * never uses the stub, and asserts the "lsof is not installed" refusal on such a host instead.
 */
let stubDir = '';
function noHolderPath(): Record<string, string> {
  if (hasLsof) return {};
  if (!stubDir) {
    stubDir = mkdtempSync(join(tmpdir(), 'massu-lsof-stub-'));
    writeFileSync(join(stubDir, 'lsof'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(stubDir, 'lsof'), 0o755);
  }
  return { PATH: `${stubDir}:${process.env.PATH ?? ''}` };
}
afterAll(() => { if (stubDir) rmSync(stubDir, { recursive: true, force: true }); });

const run = (args: string[], env: Record<string, string> = {}, opts: { realLsof?: boolean } = {}) => {
  const merged = { ...process.env, ...(opts.realLsof ? {} : noHolderPath()), ...env };
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: merged });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
// The real disk may sit below the 25% floor; the apply tests are about the conversion, not this disk.
const ROOMY = { CONVERT_TEST_AVAIL_BYTES: String(10 ** 15) };
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
  it('dry run (the default) checks everything and writes NOTHING', () => {
    const { repo, db } = legacyRepo();
    const before = sha(db);
    const r = run(['--repo', repo], ROOMY);
    expect(r.out).toContain('RESULT: dry run');
    expect(r.code, r.out).toBe(0);
    expect(sha(db)).toBe(before);
    expect(readdirSync(join(repo, '.massu')).filter((f) => f.includes('pre-incremental'))).toEqual([]);
  });

  it('--apply converts to mode 2, frees every free page, keeps every row, and keeps a valid backup', () => {
    const { repo, db } = legacyRepo();
    const before = probe(db);
    expect(before).toMatchObject({ mode: 0, keep: 300, gone: 10 });
    expect(before.free).toBeGreaterThan(100);

    const r = run(['--repo', repo, '--apply'], ROOMY);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('RESULT: converted');
    expect(probe(db)).toEqual({ mode: 2, free: 0, keep: 300, gone: 10, ok: 'ok' });

    const backups = readdirSync(join(repo, '.massu')).filter((f) => /^memory\.db\.pre-incremental-\d{8}-\d{6}$/.test(f));
    expect(backups).toHaveLength(1);
    expect(probe(join(repo, '.massu', backups[0]))).toMatchObject({ keep: 300, gone: 10, ok: 'ok' });
  });

  it('a conversion that lost a row FAILS and names the table and the backup (the row-count proof fires)', () => {
    const { repo } = legacyRepo();
    const r = run(['--repo', repo, '--apply'], { ...ROOMY, CONVERT_TEST_LOSE_ROW_IN: 'keep' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('row counts changed in: keep 300 -> 299');
    expect(r.out).toMatch(/restore from .*memory\.db\.pre-incremental-/);
    expect(r.out).not.toContain('RESULT: converted');
  });

  it('is idempotent: a mode-2 database is a reported no-op that changes nothing', () => {
    const { repo, db } = legacyRepo();
    expect(run(['--repo', repo, '--apply'], ROOMY).code).toBe(0);
    const after = sha(db);
    const r = run(['--repo', repo, '--apply'], ROOMY);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('already auto_vacuum=INCREMENTAL');
    expect(sha(db)).toBe(after);
  });

  it(`refuses while another process holds the database (${hasLsof ? 'lsof present' : 'NO lsof: must refuse for that'})`, async () => {
    const { repo, db } = legacyRepo();
    const holder = spawn(process.execPath, ['--no-warnings', '-e',
      `const d = new (require('node:sqlite').DatabaseSync)(${JSON.stringify(db)}); d.prepare('SELECT 1').get(); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`]);
    children.push(holder);
    await new Promise<void>((res, rej) => {
      holder.stdout!.once('data', () => res());
      holder.once('exit', (c) => rej(new Error(`holder exited ${c}`)));
    });
    const before = sha(db);
    const r = run(['--repo', repo, '--apply'], ROOMY, { realLsof: true });
    if (hasLsof) {
      expect(r.out).toContain('REFUSED: the database is open in another process');
      expect(r.out).toContain(`pid ${holder.pid}`);
      expect(r.code).toBe(1);
    } else {
      expect(r.out).toContain('lsof is not installed');
      expect(r.code).toBe(2);
    }
    expect(sha(db)).toBe(before);
  });

  it('refuses when the conversion would take the disk below the 25% floor, and writes nothing', () => {
    const { repo, db } = legacyRepo();
    const before = sha(db);
    const r = run(['--repo', repo, '--apply'], { CONVERT_TEST_AVAIL_BYTES: '1' });
    expect(r.out).toContain('below the 25% floor');
    expect(r.code).toBe(1);
    expect(sha(db)).toBe(before);
  });

  it('refuses ambiguous or missing input instead of guessing', () => {
    expect(run([]).code).toBe(2);                                         // no --repo default
    expect(run(['--repo', '/nonexistent-massu-repo']).code).toBe(2);
    const { repo } = legacyRepo();
    expect(run(['--repo', repo, '--db', 'other.db']).code).toBe(2);
    expect(run(['--repo', repo, '--db', 'data.db']).code).toBe(2);         // that file does not exist
  });

  it('--list reports every database it found, with the denominator', () => {
    const { repo } = legacyRepo();
    const r = run(['--repo', repo, '--list']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/memory\.db\s+auto_vacuum=0/);
    expect(r.out).toContain('databases found in');
    expect(r.out).toContain('1 of 3 candidates');
  });
});

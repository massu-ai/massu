// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-07-23 Phase P8 — memory-store retention.
 *   P8-001  a NEW database is created auto_vacuum=INCREMENTAL; an EXISTING mode-0 one is left alone.
 *   P8-002  releaseFreePages frees pages in bounded batches, stops at the deadline, never spins, and REPORTS a skip.
 *   P8-004  runMemoryRetention has exactly two production callers (startup and session end).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join, resolve, relative } from 'path';

const paths = vi.hoisted(() => ({ memoryDbPath: '', dataDbPath: '', knowledgeDbPath: '' }));
vi.mock('../config.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.ts')>();
  return { ...real, getResolvedPaths: () => ({ ...real.getResolvedPaths(), ...paths }) };
});

import { openDatabase } from '../db-driver.ts';
import { getMemoryDb, createSession } from '../memory-db.ts';
import { getDataDb } from '../db.ts';
import { getKnowledgeDb } from '../knowledge-db.ts';
import {
  releaseFreePages,
  describeFreePages,
  runMemoryRetention,
  INCREMENTAL_VACUUM_BATCH_PAGES,
} from '../memory-retention.ts';

const roots: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'massu-retention-'));
  roots.push(d);
  return d;
}
afterEach(() => {
  delete process.env.MASSU_DB_ENGINE;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A database as an OLDER massu (or any other tool) left it: created without openDatabase, so mode 0. */
function legacyModeZeroDb(path: string): void {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE t (x TEXT)');
  raw.exec("INSERT INTO t SELECT hex(randomblob(2000)) FROM (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<200) SELECT i FROM c)");
  raw.exec('DELETE FROM t');
  raw.close();
}

const num = (db: { pragma: (s: string, o?: { simple?: boolean }) => unknown }, name: string) =>
  Number(db.pragma(name, { simple: true }));

/** A mode-2 database with roughly `freePages` scattered free pages (3 of every 4 rows deleted). */
function seededIncrementalDb(path: string, freePages: number) {
  const db = openDatabase(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
  const ins = db.prepare('INSERT INTO t (body) VALUES (?)');
  const body = 'x'.repeat(1000);
  db.exec('BEGIN');
  while (num(db, 'page_count') < Math.ceil(freePages / 0.75)) for (let i = 0; i < 200; i++) ins.run(body);
  db.exec('COMMIT');
  db.exec('DELETE FROM t WHERE id % 4 != 0');
  return db;
}

for (const engine of ['node-sqlite', 'better-sqlite3'] as const) {
  describe(`P8-001 new databases are created incremental — ${engine}`, () => {
    const useEngine = () => { process.env.MASSU_DB_ENGINE = engine; };

    it('every WRITABLE getter creates its new file in auto_vacuum=INCREMENTAL (2)', () => {
      useEngine();
      const root = scratch();
      paths.memoryDbPath = join(root, '.massu', 'memory.db');
      paths.dataDbPath = join(root, '.massu', 'data.db');
      paths.knowledgeDbPath = join(root, '.massu', 'knowledge.db');
      for (const [name, open] of [['memory', getMemoryDb], ['data', getDataDb], ['knowledge', getKnowledgeDb]] as const) {
        const db = open();
        try {
          // The schema was created through the getter, so the mode survived the WAL switch and the DDL.
          expect(num(db, 'page_count'), `${name} has a schema`).toBeGreaterThan(1);
          expect(num(db, 'auto_vacuum'), `${name}.db auto_vacuum`).toBe(2);
        } finally {
          db.close();
        }
      }
    });

    it('an EXISTING mode-0 database is left at 0 by a plain open (only an explicit VACUUM converts it)', () => {
      useEngine();
      const path = join(scratch(), 'old.db');
      legacyModeZeroDb(path);
      const reopened = openDatabase(path);
      try {
        expect(num(reopened, 'auto_vacuum')).toBe(0);
      } finally {
        reopened.close();
      }
    });

    it('a read-only open of an EMPTY file writes nothing (setting the mode would write the header)', () => {
      useEngine();
      const path = join(scratch(), 'empty.db');
      writeFileSync(path, '');
      const ro = openDatabase(path, { readonly: true });
      try {
        expect(num(ro, 'page_count')).toBe(0);
      } finally {
        ro.close();
      }
      expect(statSync(path).size).toBe(0);
    });
  });

  describe(`P8-002 releaseFreePages — ${engine}`, () => {
    const useEngine = () => { process.env.MASSU_DB_ENGINE = engine; };

    it('frees every free page in batches of INCREMENTAL_VACUUM_BATCH_PAGES and the file SHRINKS', () => {
      useEngine();
      const path = join(scratch(), 'm2.db');
      const db = seededIncrementalDb(path, 3 * INCREMENTAL_VACUUM_BATCH_PAGES);
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const sizeBefore = statSync(path).size;
        const before = num(db, 'freelist_count');
        expect(before).toBeGreaterThan(2 * INCREMENTAL_VACUUM_BATCH_PAGES);
        const r = releaseFreePages(db, { deadlineAt: Date.now() + 60_000 });
        expect(r).toMatchObject({ status: 'ran', freeBefore: before, freeAfter: 0, stoppedBy: 'empty' });
        if (r.status !== 'ran') throw new Error('unreachable');
        expect(r.batches).toBe(Math.ceil(before / INCREMENTAL_VACUUM_BATCH_PAGES));
        db.pragma('wal_checkpoint(TRUNCATE)');
        expect(statSync(path).size).toBeLessThan(sizeBefore - before * 4096 * 0.9);
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(describeFreePages(r)).toContain(`released ${before} free pages`);
      } finally {
        db.close();
      }
    });

    it('stops at the deadline: a past deadline runs ZERO batches and says why', () => {
      useEngine();
      const db = seededIncrementalDb(join(scratch(), 'd.db'), 600);
      try {
        const before = num(db, 'freelist_count');
        const r = releaseFreePages(db, { deadlineAt: Date.now() - 1 });
        expect(r).toEqual({ status: 'ran', freeBefore: before, freeAfter: before, batches: 0, stoppedBy: 'deadline' });
      } finally {
        db.close();
      }
    });

    it('a deadline reached mid-run stops between batches, with the rest left for the next run', () => {
      useEngine();
      const db = seededIncrementalDb(join(scratch(), 'm.db'), 3 * 64);
      try {
        let calls = 0;
        // Two "now" readings pass the check; the third is past the deadline.
        const r = releaseFreePages(db, { deadlineAt: 100, batchPages: 64, now: () => (calls++ < 2 ? 0 : 200) });
        expect(r).toMatchObject({ status: 'ran', batches: 2, stoppedBy: 'deadline' });
        if (r.status !== 'ran') throw new Error('unreachable');
        expect(r.freeBefore - r.freeAfter).toBe(128);
      } finally {
        db.close();
      }
    });

    it('mode 0 is a REPORTED skip, never a silent zero', () => {
      useEngine();
      const path = join(scratch(), 'z.db');
      legacyModeZeroDb(path);
      const db = openDatabase(path);
      try {
        const free = num(db, 'freelist_count');
        expect(free).toBeGreaterThan(0);
        const r = releaseFreePages(db, { deadlineAt: Date.now() + 60_000 });
        expect(r).toEqual({ status: 'skipped', reason: 'auto_vacuum=0', autoVacuum: 0, freePages: free });
        expect(num(db, 'freelist_count')).toBe(free);
        expect(describeFreePages(r)).toContain('skipped: auto_vacuum=0');
      } finally {
        db.close();
      }
    });

    it('rejects a non-positive batch size instead of looping', () => {
      useEngine();
      const db = openDatabase(':memory:');
      try {
        expect(() => releaseFreePages(db, { deadlineAt: Date.now() + 1000, batchPages: 0 })).toThrow(/positive integer/);
      } finally {
        db.close();
      }
    });
  });
}

describe('P8-004 runMemoryRetention', () => {
  it('retires old conversation detail and keeps recent detail (windows unchanged: 7 days)', () => {
    paths.memoryDbPath = join(scratch(), '.massu', 'memory.db');
    const db = getMemoryDb();
    try {
      const now = Math.floor(Date.now() / 1000);
      createSession(db, 's');
      const insertTurn = (age: number) => db.prepare(
        `INSERT INTO conversation_turns (session_id, turn_number, user_prompt, created_at, created_at_epoch)
         VALUES ('s', ?, 'p', datetime(?, 'unixepoch'), ?)`,
      ).run(age, now - age * 86400, now - age * 86400);
      insertTurn(8);
      insertTurn(6);
      const c = runMemoryRetention(db);
      expect(c.turnsDeleted).toBe(1);
      const left = db.prepare('SELECT turn_number FROM conversation_turns').all();
      expect(left).toEqual([{ turn_number: 6 }]);
    } finally {
      db.close();
    }
  });

  it('has exactly two production callers: the MCP server startup and the session-end hook', () => {
    const src = resolve(__dirname, '..');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!/\.ts$/.test(e.name) || e.name === 'memory-retention.ts') continue;
        if (/\brunMemoryRetention\s*\(/.test(readFileSync(p, 'utf8'))) callers.push(relative(src, p));
      }
    };
    walk(src);
    expect(callers.length, 'files scanned found callers').toBeGreaterThan(0);
    expect(callers.sort()).toEqual(['hooks/session-end.ts', 'server.ts']);
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * M-002 (plan-massu-resilience-layer2, CR-69) — the db-driver adapter shims.
 *
 * The node:sqlite driver must present the exact better-sqlite3 surface massu uses:
 * `.pragma()` (set / read / {simple}), `.transaction()` (callable, commit, rollback,
 * nested savepoint, arg + return forwarding), `.serialize()` (consistent snapshot
 * Buffer via VACUUM INTO), `{readonly}`→`{readOnly}`, and `run/get/all` with plain-object
 * rows + numeric `changes`. Every assertion is behavioral, run against the real engine.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openDatabase,
  resolveDbEngine,
  DEFAULT_DB_ENGINE,
  type MassuDatabase,
} from '../db-driver.ts';

const dirs: string[] = [];
function tempDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'massu-dbdriver-'));
  dirs.push(d);
  return join(d, 'test.db');
}

afterEach(() => {
  delete process.env.MASSU_DB_ENGINE;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('engine resolution', () => {
  it('defaults to node:sqlite (the drift-guarded constant)', () => {
    expect(DEFAULT_DB_ENGINE).toBe('node-sqlite');
    delete process.env.MASSU_DB_ENGINE;
    expect(resolveDbEngine()).toBe('node-sqlite');
  });
  it('selects better-sqlite3 only on the explicit env opt-in', () => {
    process.env.MASSU_DB_ENGINE = 'better-sqlite3';
    expect(resolveDbEngine()).toBe('better-sqlite3');
    process.env.MASSU_DB_ENGINE = 'anything-else';
    expect(resolveDbEngine()).toBe('node-sqlite');
  });
});

// Run the full shim contract against BOTH engines so the adapter is proven uniform.
for (const engine of ['node-sqlite', 'better-sqlite3'] as const) {
  describe(`adapter shims — ${engine}`, () => {
    function open(readonly = false): MassuDatabase {
      process.env.MASSU_DB_ENGINE = engine === 'better-sqlite3' ? 'better-sqlite3' : 'node-sqlite';
      return openDatabase(tempDbPath(), readonly ? { readonly: true } : {});
    }

    it('run() returns numeric changes + lastInsertRowid; get/all return plain objects', () => {
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      const r = db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
      expect(typeof r.changes).toBe('number');
      expect(r.changes).toBe(1);
      expect(Number(r.lastInsertRowid)).toBe(1);
      const row = db.prepare('SELECT id, v FROM t WHERE id = ?').get(1) as { id: number; v: string };
      expect(row).toEqual({ id: 1, v: 'a' });
      // plain object (Object prototype) — not a null-prototype row
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      const all = db.prepare('SELECT v FROM t').all();
      expect(all).toEqual([{ v: 'a' }]);
      db.close();
    });

    it('pragma: set (WAL), read (array), and {simple:true} (scalar)', () => {
      const db = open();
      db.pragma('journal_mode = WAL');
      const jm = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      expect(String(jm[0].journal_mode).toLowerCase()).toBe('wal');
      db.pragma('user_version = 7');
      expect(db.pragma('user_version', { simple: true })).toBe(7);
      const pc = db.pragma('page_count') as Array<{ page_count: number }>;
      expect(typeof pc[0].page_count).toBe('number');
      db.close();
    });

    it('foreign_keys default matches better-sqlite3 (ON), and is caller-togglable', () => {
      const db = open();
      // FAITHFULNESS: better-sqlite3's actual default is FK ON — the adapter matches it
      // so a store relying on the default keeps enforcement under node:sqlite.
      expect(Number((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0].foreign_keys)).toBe(1);
      db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))');
      // enforced by default
      expect(() => db.prepare('INSERT INTO c (id, pid) VALUES (1, 999)').run()).toThrow();
      // explicit OFF override disables enforcement (memory-db bulk-op pattern)
      db.pragma('foreign_keys = OFF');
      expect(() => db.prepare('INSERT INTO c (id, pid) VALUES (2, 999)').run()).not.toThrow();
      db.close();
    });

    it('transaction: commit persists, forwards args + return value', () => {
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
      const tx = db.transaction((a: number, b: number) => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run(a);
        db.prepare('INSERT INTO t (v) VALUES (?)').run(b);
        return a + b;
      });
      const out = tx(10, 20);
      expect(out).toBe(30);
      expect((db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(2);
      db.close();
    });

    it('transaction: rollback on throw leaves no partial writes', () => {
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (1)').run();
        throw new Error('boom');
      });
      expect(() => tx()).toThrow(/boom/);
      expect((db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(0);
      db.close();
    });

    it('transaction: nested (savepoint) — inner rollback keeps outer work', () => {
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
      const outer = db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (1)').run();
        const inner = db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (2)').run();
          throw new Error('inner');
        });
        expect(() => inner()).toThrow(/inner/);
        db.prepare('INSERT INTO t (v) VALUES (3)').run();
      });
      outer();
      const vals = (db.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: number }>).map((r) => r.v);
      expect(vals).toEqual([1, 3]); // 2 rolled back by the inner savepoint
      db.close();
    });

    it('transaction: a wrapper invoked inside a RAW exec("BEGIN") opens a savepoint (no double-BEGIN)', () => {
      // Regression (architecture review): the node:sqlite shim must decide BEGIN-vs-
      // SAVEPOINT from the connection's REAL state, so a .transaction() called from
      // inside a manual BEGIN region does not issue a second BEGIN (which node:sqlite
      // rejects). The codebase mixes raw exec('BEGIN') with .transaction() wrappers.
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
      db.exec('BEGIN'); // raw manual transaction region
      db.prepare('INSERT INTO t (v) VALUES (1)').run();
      const inner = db.transaction((x: number) => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run(x);
        return x * 2;
      });
      expect(inner(5)).toBe(10); // must NOT throw "cannot start a transaction within a transaction"
      db.exec('COMMIT');
      const vals = (db.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: number }>).map((r) => r.v);
      expect(vals).toEqual([1, 5]);
      db.close();
    });

    it('transaction: a wrapper failing inside a RAW BEGIN rolls back to its savepoint, outer survives', () => {
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
      db.exec('BEGIN');
      db.prepare('INSERT INTO t (v) VALUES (1)').run();
      const inner = db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (2)').run();
        throw new Error('inner-fail');
      });
      expect(() => inner()).toThrow(/inner-fail/);
      // savepoint rolled back (2 gone) + released, so the outer txn is still usable
      db.prepare('INSERT INTO t (v) VALUES (3)').run();
      db.exec('COMMIT');
      const vals = (db.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: number }>).map((r) => r.v);
      expect(vals).toEqual([1, 3]);
      db.close();
    });

    it('serialize() returns a consistent snapshot Buffer that reopens as a valid DB', () => {
      const db = open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('snap');
      const snapshot = (db as unknown as { serialize: () => Buffer }).serialize();
      expect(Buffer.isBuffer(snapshot)).toBe(true);
      expect(snapshot.length).toBeGreaterThan(0);
      // SQLite file header magic
      expect(snapshot.subarray(0, 15).toString('utf-8')).toBe('SQLite format 3');
      // Reopen the snapshot bytes and confirm the row survived.
      const restorePath = tempDbPath();
      writeFileSync(restorePath, snapshot);
      process.env.MASSU_DB_ENGINE = engine === 'better-sqlite3' ? 'better-sqlite3' : 'node-sqlite';
      const restored = openDatabase(restorePath, { readonly: true });
      expect((restored.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('snap');
      restored.close();
      db.close();
    });

    it('readonly opens reject writes', () => {
      const path = tempDbPath();
      process.env.MASSU_DB_ENGINE = engine === 'better-sqlite3' ? 'better-sqlite3' : 'node-sqlite';
      const w = openDatabase(path, {});
      w.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      w.close();
      const ro = openDatabase(path, { readonly: true });
      expect(() => ro.exec('INSERT INTO t (id) VALUES (1)')).toThrow();
      ro.close();
    });
  });
}

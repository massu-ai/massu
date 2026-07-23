// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/*
 * node:sqlite CAPABILITY-FLOOR drift-guard (CR-69 correction, plan-2026-07-23-node-sqlite-
 * fts5-floor-correction). The REAL can-fail guard for the two customer-affecting bugs the
 * corrected floor (>=22.16.0) exists to prevent:
 *
 *   Bug #1 (FTS5): the memory DB's `observations_fts` virtual table needs `USING fts5`,
 *     which Node's built-in `node:sqlite` gained only at v22.16.0 (22.15.1 has bundled
 *     SQLite 3.49.1 WITHOUT the FTS5 compile flag → `no such module: fts5`). Below 22.16
 *     the CREATE VIRTUAL TABLE silently no-ops → `no such table: main.observations_fts`.
 *   Bug #3 (nested savepoint): `db-driver.ts` `transaction()` reads `raw.isTransaction`
 *     (line ~177) to decide SAVEPOINT-vs-BEGIN. `DatabaseSync.prototype.isTransaction`
 *     also arrived at v22.16.0; below it `raw.isTransaction` is `undefined` → falsy → the
 *     adapter runs `exec('BEGIN')` inside an already-open txn → SQLite throws "cannot start
 *     a transaction within a transaction".
 *
 * CAN-FAIL: because CI now pins the floor Node (22.16.0), (a)/(b1)/(b2) run on the EXACT
 * floor → they genuinely fail if the floor were set below the true capability version. On a
 * Node <22.16 each of (a)/(b1)/(b2) reds — the real regression proof (CR-63/CR-64 spirit).
 *
 * NOTE: (b1) constructs `node:sqlite`'s `DatabaseSync` DIRECTLY to probe the underlying
 * engine capability the adapter depends on. This is a TEST probe of the capability — it does
 * NOT violate the db-driver sole-`node:sqlite`-value-importer invariant, which governs
 * `packages/core/src` PRODUCT code, not `__tests__`.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { openDatabase } from '../db-driver.ts';
import { MIN_NODE_MAJOR, MIN_NODE_MINOR } from '../preflight.ts';

describe('node:sqlite capability floor (>=22.16.0) — FTS5 + isTransaction (plan-2026-07-23)', () => {
  it('(a) FTS5 is present THROUGH the adapter (the observations_fts product path)', () => {
    // openDatabase() defaults to the node:sqlite engine — the exact path the memory DB uses.
    const db = openDatabase(':memory:');
    try {
      // A real `no such module: fts5` throw here (NOT a silent no-op) if FTS5 is absent.
      db.exec('CREATE VIRTUAL TABLE cap USING fts5(x)');
      db.prepare('INSERT INTO cap VALUES (?)').run('hello world');
      const rows = db.prepare('SELECT x FROM cap WHERE cap MATCH ?').all('hello');
      expect(rows.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('(b1) DatabaseSync.prototype.isTransaction exists + toggles (the adapter precondition)', () => {
    // Probe node:sqlite directly — the adapter hides `raw`, so reach the capability the
    // adapter's transaction() (db-driver.ts ~L177 `const nested = raw.isTransaction`) needs.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec(s: string): void;
        close(): void;
        readonly isTransaction: boolean;
      };
    };
    const raw = new DatabaseSync(':memory:');
    try {
      // On Node <22.16 `isTransaction` is `undefined` → `'isTransaction' in raw` is false → RED.
      expect('isTransaction' in raw).toBe(true);
      expect(raw.isTransaction).toBe(false);
      raw.exec('BEGIN');
      expect(raw.isTransaction).toBe(true);
      raw.exec('COMMIT');
      expect(raw.isTransaction).toBe(false);
    } finally {
      raw.close();
    }
  });

  it('(b2) nested savepoint works THROUGH the adapter (bug #3 regression guard)', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      // Open a RAW transaction, then invoke a .transaction() helper INSIDE it. Below 22.16
      // (raw.isTransaction === undefined → falsy) the adapter would run a second BEGIN and
      // SQLite throws "cannot start a transaction within a transaction" → RED.
      db.exec('BEGIN');
      expect(() => {
        db.transaction(() => {
          db.prepare('INSERT INTO t (x) VALUES (?)').run(1);
        })();
      }).not.toThrow();
      db.exec('COMMIT');
      expect((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('(c) the declared floor is >= the 22.16 capability version (SoT lock)', () => {
    // Encode 22.16.0 as the capability floor. A future floor DROP below 22.16 reds here even
    // on a capable dev machine. DEFEAT: lowering MIN_NODE_MINOR to 15 turns this red.
    expect(MIN_NODE_MAJOR * 100 + MIN_NODE_MINOR).toBeGreaterThanOrEqual(22 * 100 + 16);
  });
});

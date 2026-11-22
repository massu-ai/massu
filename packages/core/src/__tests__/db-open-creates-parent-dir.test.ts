// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A read-write open creates its parent directory at the ONE open chokepoint (db-driver.ts).
 *
 * Regression for 2026-11-21: the server's startup RW assert called `openDatabase(memoryDbPath)`
 * directly, skipping the `mkdirSync(dirname())` that each DB getter carried its own copy of. In
 * every checkout with no `.massu/` (92 worktrees of one consumer repo) massu refused to start with "unable to
 * open database file", and the error then advised `npm rebuild better-sqlite3`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase } from '../db-driver.ts';
import { assertMemoryEngineHealthy, FatalStartupError } from '../startup-health.ts';

const roots: string[] = [];
function scratchRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'massu-parentdir-'));
  roots.push(d);
  return d;
}

afterEach(() => {
  delete process.env.MASSU_DB_ENGINE;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

for (const engine of ['node-sqlite', 'better-sqlite3'] as const) {
  describe(`openDatabase parent-directory contract — ${engine}`, () => {
    const useEngine = () => { process.env.MASSU_DB_ENGINE = engine; };

    it('a read-write open in a MISSING directory creates it and the database works', () => {
      useEngine();
      const dir = join(scratchRoot(), 'checkout', '.massu');
      const dbPath = join(dir, 'memory.db');
      expect(existsSync(dir)).toBe(false); // the precondition the bug needs
      const db = openDatabase(dbPath);
      try {
        db.exec('CREATE TABLE t (id INTEGER)');
        db.prepare('INSERT INTO t (id) VALUES (?)').run(7);
        expect(db.prepare('SELECT id FROM t').get()).toEqual({ id: 7 });
      } finally {
        db.close();
      }
      expect(existsSync(dbPath)).toBe(true);
    });

    it('a READ-ONLY open in a missing directory creates nothing', () => {
      useEngine();
      const dir = join(scratchRoot(), 'absent');
      expect(() => openDatabase(join(dir, 'memory.db'), { readonly: true })).toThrow();
      expect(existsSync(dir)).toBe(false);
    });

    it(':memory: opens without touching the filesystem', () => {
      useEngine();
      const db = openDatabase(':memory:');
      try {
        expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
      } finally {
        db.close();
      }
    });

    it("the server's startup RW assert passes in a checkout with no .massu/ (the original failure)", () => {
      useEngine();
      const dbPath = join(scratchRoot(), 'repo-wt-example', '.massu', 'memory.db');
      // Exactly server.ts:113's call shape.
      expect(() => assertMemoryEngineHealthy(() => openDatabase(dbPath))).not.toThrow();
      expect(existsSync(dbPath)).toBe(true);
    });
  });
}

describe('assertMemoryEngineHealthy remedy names the cause the error shows', () => {
  it('a filesystem open error gets a filesystem remedy, NOT rebuild advice', () => {
    const cantOpen = () => {
      const e = new Error('unable to open database file') as NodeJS.ErrnoException;
      e.code = 'ERR_SQLITE_ERROR';
      throw e;
    };
    let message = '';
    try {
      assertMemoryEngineHealthy(cantOpen);
    } catch (e) {
      expect(e).toBeInstanceOf(FatalStartupError);
      message = (e as Error).message;
    }
    expect(message).toMatch(/unable to open database file/); // the real cause is preserved
    expect(message).toMatch(/filesystem\/open error/);
    expect(message).toMatch(/\.massu\//);
    expect(message).not.toMatch(/npm rebuild|different Node\.js ABI/);
  });

  it('a real native ABI mismatch still gets the rebuild remedy', () => {
    const abi = () => {
      throw new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.');
    };
    expect(() => assertMemoryEngineHealthy(abi)).toThrow(/npm rebuild better-sqlite3/);
    expect(() => assertMemoryEngineHealthy(abi)).not.toThrow(/filesystem\/open error/);
  });
});

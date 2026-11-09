// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { isDataStale, updateBuildTimestamp, codegraphIndexedAtToEpochMs } from '../db.ts';
import { unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

// DB scratch under the OS temp dir, NEVER under packages/core/src (feedback_dashboard_key_ux_and_src_scratch_race).
const TEST_DATA_DB_PATH = resolve(tmpdir(), `massu-test-data-db-${process.pid}.db`);
const TEST_CODEGRAPH_DB_PATH = resolve(tmpdir(), `massu-test-codegraph-db-${process.pid}.db`);

function createTestDataDb(): Database.Database {
  if (existsSync(TEST_DATA_DB_PATH)) {
    unlinkSync(TEST_DATA_DB_PATH);
  }

  const db = new Database(TEST_DATA_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS massu_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

function createTestCodeGraphDb(): Database.Database {
  if (existsSync(TEST_CODEGRAPH_DB_PATH)) {
    unlinkSync(TEST_CODEGRAPH_DB_PATH);
  }

  const db = new Database(TEST_CODEGRAPH_DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      indexed_at INTEGER NOT NULL
    );
  `);

  return db;
}

describe('Database Module', () => {
  let dataDb: Database.Database;
  let codegraphDb: Database.Database;

  beforeEach(() => {
    dataDb = createTestDataDb();
    codegraphDb = createTestCodeGraphDb();
  });

  afterEach(() => {
    dataDb.close();
    codegraphDb.close();
    if (existsSync(TEST_DATA_DB_PATH)) {
      unlinkSync(TEST_DATA_DB_PATH);
    }
    if (existsSync(TEST_CODEGRAPH_DB_PATH)) {
      unlinkSync(TEST_CODEGRAPH_DB_PATH);
    }
  });

  describe('isDataStale', () => {
    it('returns true when no last_build_time exists', () => {
      codegraphDb.prepare(`INSERT INTO files (path, indexed_at) VALUES ('test.ts', ?)`).run(
        Math.floor(Date.now() / 1000)
      );

      const stale = isDataStale(dataDb, codegraphDb);
      expect(stale).toBe(true);
    });

    it('returns true when codegraph is newer than last build', () => {
      const oldTime = new Date(Date.now() - 60000); // 1 minute ago
      dataDb.prepare(`INSERT INTO massu_meta (key, value) VALUES ('last_build_time', ?)`).run(
        oldTime.toISOString()
      );

      const newTimestamp = Math.floor(Date.now() / 1000); // Now
      codegraphDb.prepare(`INSERT INTO files (path, indexed_at) VALUES ('test.ts', ?)`).run(newTimestamp);

      const stale = isDataStale(dataDb, codegraphDb);
      expect(stale).toBe(true);
    });

    it('returns false when data is up to date', () => {
      const currentTime = Math.floor(Date.now() / 1000);
      const pastTime = currentTime - 60; // 1 minute ago

      codegraphDb.prepare(`INSERT INTO files (path, indexed_at) VALUES ('test.ts', ?)`).run(pastTime);

      dataDb.prepare(`INSERT INTO massu_meta (key, value) VALUES ('last_build_time', ?)`).run(
        new Date().toISOString()
      );

      const stale = isDataStale(dataDb, codegraphDb);
      expect(stale).toBe(false);
    });

    // THE FIXTURES ABOVE INSERT SECONDS. THE INSTALLED ENGINE WRITES MILLISECONDS.
    //
    // That mismatch is why the shipped defect was invisible: the suite asserted BOTH
    // verdicts and passed, because the fixture agreed with the code's assumption rather
    // than with the data source. Measured 2026-08-13 against the real
    // `.codegraph/codegraph.db`: max(indexed_at) = 1783961298985, which is 2026-07-13
    // as milliseconds and the year 58501 as seconds.
    //
    // Against millisecond input the old `latest * 1000` could not return false at all —
    // it answered `true` correctly and `false` never. These cases model the real format,
    // and each unit is asserted in BOTH directions so neither can go one-way again.
    describe('millisecond indexed_at — the format the installed engine actually writes', () => {
      it('returns true when the codegraph index is NEWER than the last build', () => {
        dataDb.prepare(`INSERT INTO massu_meta (key, value) VALUES ('last_build_time', ?)`).run(
          new Date(Date.now() - 60_000).toISOString()
        );
        codegraphDb.prepare(`INSERT INTO files (path, indexed_at) VALUES ('test.ts', ?)`).run(Date.now());

        expect(isDataStale(dataDb, codegraphDb)).toBe(true);
      });

      it('returns FALSE when the last build is newer than the codegraph index', () => {
        codegraphDb.prepare(`INSERT INTO files (path, indexed_at) VALUES ('test.ts', ?)`).run(Date.now() - 60_000);
        dataDb.prepare(`INSERT INTO massu_meta (key, value) VALUES ('last_build_time', ?)`).run(
          new Date().toISOString()
        );

        // The load-bearing assertion: the pre-fix implementation returned true here.
        expect(isDataStale(dataDb, codegraphDb)).toBe(false);
      });
    });

    describe('codegraphIndexedAtToEpochMs — the unit is detected, not assumed', () => {
      it('passes milliseconds through unchanged', () => {
        const ms = Date.now() - 5_000;
        expect(codegraphIndexedAtToEpochMs(ms)).toBe(ms);
      });

      it('scales seconds up to milliseconds', () => {
        const secs = Math.floor((Date.now() - 5_000) / 1000);
        expect(codegraphIndexedAtToEpochMs(secs)).toBe(secs * 1000);
      });

      it('THROWS on a value implausible under both readings rather than guessing', () => {
        // 1e17 is far future as ms and absurd as seconds — an unrecognised format.
        expect(() => codegraphIndexedAtToEpochMs(1e17)).toThrow(/implausible as both milliseconds/);
        // 0 / tiny values are not timestamps under either reading.
        expect(() => codegraphIndexedAtToEpochMs(42)).toThrow(/implausible as both milliseconds/);
      });

      it('names the offending value and both interpretations in the error', () => {
        expect(() => codegraphIndexedAtToEpochMs(1e17)).toThrow(/1e\+17|100000000000000000/);
        expect(() => codegraphIndexedAtToEpochMs(1e17)).toThrow(/do not guess the unit/);
      });
    });

    it('returns true when no files in codegraph', () => {
      dataDb.prepare(`INSERT INTO massu_meta (key, value) VALUES ('last_build_time', ?)`).run(
        new Date().toISOString()
      );

      const stale = isDataStale(dataDb, codegraphDb);
      expect(stale).toBe(true);
    });
  });

  describe('updateBuildTimestamp', () => {
    it('inserts last_build_time when not exists', () => {
      updateBuildTimestamp(dataDb);

      const result = dataDb.prepare(`SELECT value FROM massu_meta WHERE key = 'last_build_time'`).get() as { value: string } | undefined;
      expect(result).toBeTruthy();
      expect(result?.value).toBeTruthy();

      const timestamp = new Date(result!.value);
      expect(timestamp.getTime()).toBeGreaterThan(Date.now() - 5000); // Within last 5 seconds
    });

    it('updates last_build_time when exists', () => {
      const oldTime = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
      dataDb.prepare(`INSERT INTO massu_meta (key, value) VALUES ('last_build_time', ?)`).run(oldTime);

      updateBuildTimestamp(dataDb);

      const result = dataDb.prepare(`SELECT value FROM massu_meta WHERE key = 'last_build_time'`).get() as { value: string };
      expect(result.value).not.toBe(oldTime);

      const timestamp = new Date(result.value);
      expect(timestamp.getTime()).toBeGreaterThan(Date.now() - 5000); // Within last 5 seconds
    });

    it('stores timestamp as ISO string', () => {
      updateBuildTimestamp(dataDb);

      const result = dataDb.prepare(`SELECT value FROM massu_meta WHERE key = 'last_build_time'`).get() as { value: string };
      expect(result.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO format
    });
  });

  describe('Data DB schema', () => {
    it('creates massu_meta table', () => {
      const tables = dataDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='massu_meta'`).all();
      expect(tables.length).toBe(1);
    });

    it('massu_meta has correct columns', () => {
      const columns = dataDb.prepare(`PRAGMA table_info(massu_meta)`).all() as { name: string; type: string }[];
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('key');
      expect(columnNames).toContain('value');
    });
  });

  describe('CodeGraph DB schema', () => {
    it('creates files table', () => {
      const tables = codegraphDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files'`).all();
      expect(tables.length).toBe(1);
    });

    it('files table has indexed_at column', () => {
      const columns = codegraphDb.prepare(`PRAGMA table_info(files)`).all() as { name: string }[];
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('indexed_at');
    });
  });
});

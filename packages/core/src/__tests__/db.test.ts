// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { isDataStale, updateBuildTimestamp } from '../db.ts';
import { unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const TEST_DATA_DB_PATH = resolve(__dirname, '../test-data-db.db');
const TEST_CODEGRAPH_DB_PATH = resolve(__dirname, '../test-codegraph-db.db');

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

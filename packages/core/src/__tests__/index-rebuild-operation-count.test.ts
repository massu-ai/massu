// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The staleness gate GATES — asserted by OPERATION COUNT, never by elapsed time.
 *
 * Plan: `plan-2026-08-13-index-builder-input-contracts`, Q4 acceptance.
 *
 * A timing assertion here would assert the machine, not the code (G27): it goes
 * red on a loaded host and stays green on a fast one even when the gate is dead.
 * Counting builder invocations is strictly stronger — it is exactly the property,
 * and it is deterministic.
 *
 * Why this matters more since Q4: before the prefix fix the builder consumed 0
 * of 1266 files, so rebuilding on every dispatch cost ~4 ms and hid the dead
 * gate. Measured after the fix, the same rebuild parses 1128 files. The gate is
 * now load-bearing, so it needs a test that can see it stop working.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handleToolCall } from '../tools.ts';

const buildImportIndexCalls = vi.fn();
const buildPageDepsCalls = vi.fn();

vi.mock('../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'none', orm: 'none' },
    paths: { source: 'src' },
    domains: [],
  }),
  getProjectRoot: () => '/test/project',
  getResolvedPaths: () => ({
    codegraphDbPath: '/test/codegraph.db',
    dataDbPath: '/test/data.db',
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  }),
}));

vi.mock('../memory-db.ts', () => ({ getMemoryDb: () => new Database(':memory:') }));
vi.mock('../import-resolver.ts', () => ({
  buildImportIndex: (...args: unknown[]) => { buildImportIndexCalls(...args); return 0; },
}));
vi.mock('../page-deps.ts', () => ({
  buildPageDeps: (...args: unknown[]) => { buildPageDepsCalls(...args); return 0; },
  findAffectedPages: () => [],
}));
vi.mock('../trpc-index.ts', () => ({
  buildTrpcIndex: () => ({ totalProcedures: 0, withCallers: 0, withoutCallers: 0 }),
}));
vi.mock('../middleware-tree.ts', () => ({
  buildMiddlewareTree: () => 0,
  isInMiddlewareTree: () => false,
  getMiddlewareTree: () => [],
}));
vi.mock('../rules.ts', () => ({ matchRules: () => [], globMatch: () => false }));
vi.mock('../sentinel-scanner.ts', () => ({
  runFeatureScan: () => ({ registered: 0, fromProcedures: 0, fromPages: 0, fromComponents: 0 }),
}));

// NOTE: `../db.ts` is deliberately NOT mocked. `isDataStale` and
// `updateBuildTimestamp` are the subject; stubbing either would make this test
// assert its own mock.

function makeDataDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE massu_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL, target_file TEXT NOT NULL,
      import_type TEXT NOT NULL, imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE massu_trpc_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_file TEXT NOT NULL, router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL, procedure_type TEXT NOT NULL,
      has_ui_caller INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE massu_middleware_tree (id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL UNIQUE);
    CREATE TABLE massu_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function makeCodegraph(indexedAtMs: number): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, indexed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER, end_line INTEGER);
  `);
  db.prepare('INSERT INTO files (path, indexed_at) VALUES (?, ?)').run('src/a.ts', indexedAtMs);
  return db;
}

let dataDb: Database.Database;
let codegraphDb: Database.Database;

beforeEach(() => {
  buildImportIndexCalls.mockClear();
  buildPageDepsCalls.mockClear();
  dataDb = makeDataDb();
  // One minute in the past, so a build recorded "now" is unambiguously newer.
  codegraphDb = makeCodegraph(Date.now() - 60_000);
});

afterEach(() => {
  dataDb.close();
  codegraphDb.close();
});

describe('a repeat dispatch performs NO rebuild', () => {
  it('builds once across two identical dispatches', async () => {
    await handleToolCall('massu_context', { file: 'src/a.ts' }, dataDb, codegraphDb);
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(1);   // it ran at all
    expect(buildPageDepsCalls).toHaveBeenCalledTimes(1);

    await handleToolCall('massu_context', { file: 'src/a.ts' }, dataDb, codegraphDb);
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(1);   // and did NOT run again
    expect(buildPageDepsCalls).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: a newer CodeGraph index DOES trigger a rebuild', async () => {
    // Without this, "1 call across two dispatches" is equally consistent with a
    // gate that refuses everything, or with a mock that is never reached.
    await handleToolCall('massu_context', { file: 'src/a.ts' }, dataDb, codegraphDb);
    await handleToolCall('massu_context', { file: 'src/a.ts' }, dataDb, codegraphDb);
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(1);

    codegraphDb.prepare('UPDATE files SET indexed_at = ?').run(Date.now() + 60_000);

    await handleToolCall('massu_context', { file: 'src/a.ts' }, dataDb, codegraphDb);
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(2);
  });

  it('every staleness-gated tool honours the same gate', async () => {
    // The five call sites §1.1 names. One build total across all of them.
    for (const tool of ['massu_context', 'massu_trpc_map', 'massu_coupling_check', 'massu_impact', 'massu_domains']) {
      await handleToolCall(tool, { file: 'src/a.ts' }, dataDb, codegraphDb);
    }
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(1);
  });

  it('massu_sync rebuilds unconditionally — force bypasses the gate by design', async () => {
    await handleToolCall('massu_context', { file: 'src/a.ts' }, dataDb, codegraphDb);
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(1);

    await handleToolCall('massu_sync', {}, dataDb, codegraphDb);
    expect(buildImportIndexCalls).toHaveBeenCalledTimes(2);
  });
});

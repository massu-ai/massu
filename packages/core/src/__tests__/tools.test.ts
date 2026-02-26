// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getToolDefinitions, handleToolCall } from '../tools.ts';

// Mock all dependencies
vi.mock('../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'trpc', orm: 'prisma' },
    paths: {
      source: 'src',
      routers: 'src/server/api/routers',
      middleware: 'src/middleware.ts',
    },
    domains: [
      {
        name: 'test',
        routers: ['test'],
        pages: ['src/app/test/**'],
        tables: ['test_table'],
        allowedImportsFrom: ['*'],
      },
    ],
  }),
  getProjectRoot: () => '/test/project',
  getResolvedPaths: () => ({
    codegraphDbPath: '/test/codegraph.db',
    dataDbPath: '/test/data.db',
  }),
}));

vi.mock('../memory-db.ts', () => ({
  getMemoryDb: () => createMockDb(),
}));

vi.mock('../db.ts', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isDataStale: () => false,
    updateBuildTimestamp: vi.fn(),
  };
});

vi.mock('../import-resolver.ts', () => ({
  buildImportIndex: () => 0,
}));

vi.mock('../trpc-index.ts', () => ({
  buildTrpcIndex: () => ({ totalProcedures: 0, withCallers: 0, withoutCallers: 0 }),
}));

vi.mock('../page-deps.ts', () => ({
  buildPageDeps: () => 0,
  findAffectedPages: () => [],
}));

vi.mock('../middleware-tree.ts', () => ({
  buildMiddlewareTree: () => 0,
  isInMiddlewareTree: () => false,
  getMiddlewareTree: () => [],
}));

vi.mock('../rules.ts', () => ({
  matchRules: () => [],
  globMatch: () => false,
}));

vi.mock('../sentinel-scanner.ts', () => ({
  runFeatureScan: () => ({ registered: 0, fromProcedures: 0, fromPages: 0, fromComponents: 0 }),
}));

function createMockDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS massu_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      target_file TEXT NOT NULL,
      import_type TEXT NOT NULL,
      imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS massu_trpc_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_file TEXT NOT NULL,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT NOT NULL,
      has_ui_caller INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS massu_trpc_call_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL DEFAULT 0,
      call_pattern TEXT NOT NULL,
      FOREIGN KEY (procedure_id) REFERENCES massu_trpc_procedures(id)
    );

    CREATE TABLE IF NOT EXISTS massu_middleware_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS massu_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

function createMockCodeGraphDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      indexed_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER
    );
  `);

  // Seed with at least one file to pass staleness check
  db.prepare('INSERT INTO files (path, indexed_at) VALUES (?, ?)').run('test.ts', Math.floor(Date.now() / 1000));

  return db;
}

describe('Tools Module', () => {
  let dataDb: Database.Database;
  let codegraphDb: Database.Database;

  beforeEach(() => {
    dataDb = createMockDb();
    codegraphDb = createMockCodeGraphDb();
  });

  afterEach(() => {
    dataDb.close();
    codegraphDb.close();
  });

  describe('getToolDefinitions', () => {
    it('returns an array of tool definitions', () => {
      const tools = getToolDefinitions();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('includes core tools', () => {
      const tools = getToolDefinitions();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('massu_sync');
      expect(toolNames).toContain('massu_context');
      expect(toolNames).toContain('massu_impact');
    });

    it('includes trpc tools when framework.router is trpc', () => {
      const tools = getToolDefinitions();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('massu_trpc_map');
      expect(toolNames).toContain('massu_coupling_check');
    });

    it('includes domain tools when domains are configured', () => {
      const tools = getToolDefinitions();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('massu_domains');
    });

    it('includes schema tools when framework.orm is prisma', () => {
      const tools = getToolDefinitions();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('massu_schema');
    });

    it('each tool has required properties', () => {
      const tools = getToolDefinitions();
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
        expect(typeof tool.inputSchema).toBe('object');
      }
    });
  });

  describe('handleToolCall - massu_sync', () => {
    it('rebuilds indexes and returns summary', async () => {
      const result = await handleToolCall('massu_sync', {}, dataDb, codegraphDb);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Indexes rebuilt');
    });
  });

  describe('handleToolCall - massu_context', () => {
    beforeEach(() => {
      codegraphDb.prepare(`
        INSERT INTO nodes (file_path, name, kind, start_line, end_line)
        VALUES ('src/test.ts', 'testFunction', 'function', 1, 10)
      `).run();

      dataDb.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES ('src/test.ts', 'src/utils.ts', 'named')
      `).run();
    });

    it('returns context for a file', async () => {
      const result = await handleToolCall('massu_context', { file: 'src/test.ts' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('CodeGraph Nodes');
      expect(result.content[0].text).toContain('testFunction');
    });

    it('includes domain classification', async () => {
      const result = await handleToolCall('massu_context', { file: 'src/test.ts' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Domain:');
    });

    it('includes import information', async () => {
      const result = await handleToolCall('massu_context', { file: 'src/test.ts' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Imports');
    });
  });

  describe('handleToolCall - massu_impact', () => {
    it('returns impact analysis for a file', async () => {
      const result = await handleToolCall('massu_impact', { file: 'src/test.ts' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Impact Analysis');
      expect(result.content[0].text).toContain('src/test.ts');
    });

    it('includes middleware tree check', async () => {
      const result = await handleToolCall('massu_impact', { file: 'src/test.ts' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Middleware');
    });

    it('includes domain information', async () => {
      const result = await handleToolCall('massu_impact', { file: 'src/test.ts' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Domain:');
    });
  });

  describe('handleToolCall - massu_trpc_map', () => {
    beforeEach(() => {
      dataDb.prepare(`
        INSERT INTO massu_trpc_procedures (router_file, router_name, procedure_name, procedure_type, has_ui_caller)
        VALUES
          ('src/server/api/routers/test.ts', 'test', 'getTest', 'query', 1),
          ('src/server/api/routers/test.ts', 'test', 'updateTest', 'mutation', 0)
      `).run();
    });

    it('returns summary without arguments', async () => {
      const result = await handleToolCall('massu_trpc_map', {}, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('tRPC Procedure Summary');
      expect(result.content[0].text).toContain('Total procedures');
    });

    it('filters by router', async () => {
      const result = await handleToolCall('massu_trpc_map', { router: 'test' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Router: test');
      expect(result.content[0].text).toContain('getTest');
      expect(result.content[0].text).toContain('updateTest');
    });

    it('shows uncoupled procedures', async () => {
      const result = await handleToolCall('massu_trpc_map', { uncoupled: true }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Uncoupled Procedures');
      expect(result.content[0].text).toContain('updateTest');
    });
  });

  describe('handleToolCall - massu_domains', () => {
    beforeEach(() => {
      dataDb.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES ('src/app/test/page.tsx', 'src/utils/helper.ts', 'named')
      `).run();

      codegraphDb.prepare(`
        INSERT INTO files (path, indexed_at)
        VALUES ('src/app/test/page.tsx', ?)
      `).run(Math.floor(Date.now() / 1000));
    });

    it('classifies a file', async () => {
      const result = await handleToolCall('massu_domains', { file: 'src/app/test/page.tsx' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Domain:');
    });

    it('shows domain summary without arguments', async () => {
      const result = await handleToolCall('massu_domains', {}, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Domain Summary');
    });

    it('lists files in domain', async () => {
      const result = await handleToolCall('massu_domains', { domain: 'test' }, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Domain: test');
    });
  });

  describe('handleToolCall - unknown tool', () => {
    it('returns error for unknown tool', async () => {
      const result = await handleToolCall('massu_unknown_tool', {}, dataDb, codegraphDb);
      expect(result.content[0].text).toContain('Unknown tool');
    });
  });

  describe('handleToolCall - error handling', () => {
    it('catches and returns errors', async () => {
      // Force an error by passing invalid database
      const badDb = new Database(':memory:');
      badDb.close(); // Closed DB will cause errors

      const result = await handleToolCall('massu_context', { file: 'test.ts' }, badDb, codegraphDb);
      expect(result.content[0].text).toContain('Error');
    });
  });
});

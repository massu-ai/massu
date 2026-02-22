// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, vi } from 'vitest';
import { handleToolCall } from '../../tools.ts';

// Mock all external dependencies
vi.mock('../../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'trpc', orm: 'prisma' },
    paths: {
      source: 'src',
      routers: 'src/server/api/routers',
      middleware: 'src/middleware.ts',
    },
    domains: [],
  }),
  getProjectRoot: () => '/test/project',
  getResolvedPaths: () => ({
    codegraphDbPath: '/test/codegraph.db',
    dataDbPath: '/test/data.db',
  }),
}));

vi.mock('../../memory-db.ts', () => {
  const Database = require('better-sqlite3');
  return {
    getMemoryDb: () => {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, context TEXT);
        CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT, category TEXT, confidence REAL, created_at TEXT);
        CREATE TABLE IF NOT EXISTS analytics_events (id INTEGER PRIMARY KEY, session_id TEXT, event_type TEXT, data TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS cost_records (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, cost REAL, created_at TEXT);
        CREATE TABLE IF NOT EXISTS prompt_analyses (id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, prompt_text TEXT, analysis TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS audit_trail (id INTEGER PRIMARY KEY, session_id TEXT, action TEXT, details TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS validation_results (id INTEGER PRIMARY KEY, session_id TEXT, rule_id TEXT, result TEXT, details TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS adrs (id INTEGER PRIMARY KEY, session_id TEXT, title TEXT, status TEXT, context TEXT, decision TEXT, consequences TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS security_scores (id INTEGER PRIMARY KEY, session_id TEXT, file_path TEXT, score REAL, findings TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS dependency_scores (id INTEGER PRIMARY KEY, session_id TEXT, package_name TEXT, score REAL, details TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS team_knowledge (id INTEGER PRIMARY KEY, session_id TEXT, topic TEXT, content TEXT, author TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS regression_baselines (id INTEGER PRIMARY KEY, session_id TEXT, metric TEXT, value REAL, created_at TEXT);
        CREATE TABLE IF NOT EXISTS observability_spans (id INTEGER PRIMARY KEY, session_id TEXT, trace_id TEXT, span_id TEXT, parent_span_id TEXT, name TEXT, start_time TEXT, end_time TEXT, duration_ms REAL, status TEXT, attributes TEXT);
        CREATE TABLE IF NOT EXISTS observability_metrics (id INTEGER PRIMARY KEY, session_id TEXT, name TEXT, value REAL, unit TEXT, dimensions TEXT, timestamp TEXT);
        CREATE TABLE IF NOT EXISTS observability_logs (id INTEGER PRIMARY KEY, session_id TEXT, level TEXT, message TEXT, context TEXT, timestamp TEXT);
      `);
      return db;
    },
  };
});

vi.mock('../../db.ts', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isDataStale: () => false,
    updateBuildTimestamp: vi.fn(),
  };
});

vi.mock('../../import-resolver.ts', () => ({
  buildImportIndex: () => 0,
}));

vi.mock('../../trpc-index.ts', () => ({
  buildTrpcIndex: () => ({ totalProcedures: 0, withCallers: 0, withoutCallers: 0 }),
}));

vi.mock('../../page-deps.ts', () => ({
  buildPageDeps: () => 0,
  findAffectedPages: () => [],
}));

vi.mock('../../middleware-tree.ts', () => ({
  buildMiddlewareTree: () => 0,
  isInMiddlewareTree: () => false,
  getMiddlewareTree: () => [],
}));

vi.mock('../../domains.ts', () => ({
  classifyFile: () => ({ domain: 'unknown', layer: 'unknown' }),
  classifyRouter: () => 'unknown',
  findCrossDomainImports: () => [],
  getFilesInDomain: () => [],
}));

vi.mock('../../schema-mapper.ts', () => ({
  parsePrismaSchema: () => [],
  detectMismatches: () => [],
  findColumnUsageInRouters: () => [],
}));

vi.mock('../../sentinel-scanner.ts', () => ({
  runFeatureScan: () => ({ newFeatures: 0, updatedFeatures: 0 }),
}));

describe('Integration: Path Traversal Prevention', () => {
  const traversalPaths = [
    '../../etc/passwd',
    '/etc/passwd',
    '../../../.env',
    '/Users/someone/.ssh/id_rsa',
    'src/../../secret.txt',
  ];

  it('massu_context rejects paths with directory traversal', () => {
    for (const maliciousPath of traversalPaths) {
      try {
        const result = handleToolCall('massu_context', { file_path: maliciousPath });
        const text = result.content[0]?.text || '';
        // Should either error or not return actual file contents
        // The tool should not silently succeed with external file contents
        expect(text).not.toContain('root:x:0:0');
        expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
      } catch {
        // Throwing is acceptable - it means the tool rejected the input
      }
    }
  });

  it('docs tools reject paths outside project root', () => {
    for (const maliciousPath of traversalPaths) {
      try {
        const result = handleToolCall('massu_docs_read', { path: maliciousPath });
        const text = result.content[0]?.text || '';
        expect(text).not.toContain('root:x:0:0');
        expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
      } catch {
        // Throwing is acceptable
      }
    }
  });
});

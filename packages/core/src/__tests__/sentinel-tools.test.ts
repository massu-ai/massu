// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getSentinelToolDefinitions, handleSentinelToolCall } from '../sentinel-tools.ts';
import { upsertFeature, linkComponent, linkProcedure, linkPage } from '../sentinel-db.ts';

// Mock config
vi.mock('../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'trpc', orm: 'prisma' },
    paths: { source: 'src', routers: 'src/server/api/routers' },
    domains: [],
  }),
  getProjectRoot: () => '/test/project',
}));

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Initialize sentinel schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS massu_sentinel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT UNIQUE NOT NULL,
      domain TEXT NOT NULL,
      subdomain TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('planned', 'active', 'deprecated', 'removed')),
      priority TEXT DEFAULT 'standard'
        CHECK(priority IN ('critical', 'standard', 'nice-to-have')),
      portal_scope TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      removed_at TEXT,
      removed_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS massu_sentinel_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      component_file TEXT NOT NULL,
      component_name TEXT,
      role TEXT DEFAULT 'implementation'
        CHECK(role IN ('implementation', 'ui', 'data', 'utility')),
      is_primary BOOLEAN DEFAULT 0,
      UNIQUE(feature_id, component_file, component_name)
    );

    CREATE TABLE IF NOT EXISTS massu_sentinel_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT,
      UNIQUE(feature_id, router_name, procedure_name)
    );

    CREATE TABLE IF NOT EXISTS massu_sentinel_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      page_route TEXT NOT NULL,
      portal TEXT,
      UNIQUE(feature_id, page_route, portal)
    );

    CREATE TABLE IF NOT EXISTS massu_sentinel_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      depends_on_feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      dependency_type TEXT DEFAULT 'requires'
        CHECK(dependency_type IN ('requires', 'enhances', 'replaces')),
      UNIQUE(feature_id, depends_on_feature_id)
    );

    CREATE TABLE IF NOT EXISTS massu_sentinel_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      change_type TEXT NOT NULL,
      changed_by TEXT,
      change_detail TEXT,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS massu_sentinel_fts USING fts5(
      feature_key, title, description, domain, subdomain,
      content=massu_sentinel, content_rowid=id
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS massu_sentinel_ai AFTER INSERT ON massu_sentinel BEGIN
      INSERT INTO massu_sentinel_fts(rowid, feature_key, title, description, domain, subdomain)
      VALUES (new.id, new.feature_key, new.title, new.description, new.domain, new.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS massu_sentinel_ad AFTER DELETE ON massu_sentinel BEGIN
      INSERT INTO massu_sentinel_fts(massu_sentinel_fts, rowid, feature_key, title, description, domain, subdomain)
      VALUES ('delete', old.id, old.feature_key, old.title, old.description, old.domain, old.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS massu_sentinel_au AFTER UPDATE ON massu_sentinel BEGIN
      INSERT INTO massu_sentinel_fts(massu_sentinel_fts, rowid, feature_key, title, description, domain, subdomain)
      VALUES ('delete', old.id, old.feature_key, old.title, old.description, old.domain, old.subdomain);
      INSERT INTO massu_sentinel_fts(rowid, feature_key, title, description, domain, subdomain)
      VALUES (new.id, new.feature_key, new.title, new.description, new.domain, new.subdomain);
    END;
  `);

  return db;
}

describe('Sentinel Tools', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getSentinelToolDefinitions', () => {
    it('returns tool definitions array', () => {
      const tools = getSentinelToolDefinitions();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('includes sentinel_search tool', () => {
      const tools = getSentinelToolDefinitions();
      const searchTool = tools.find(t => t.name === 'massu_sentinel_search');
      expect(searchTool).toBeTruthy();
      expect(searchTool?.description).toBeTruthy();
      expect(searchTool?.inputSchema).toBeTruthy();
    });

    it('includes all sentinel tools', () => {
      const tools = getSentinelToolDefinitions();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('massu_sentinel_search');
      expect(toolNames).toContain('massu_sentinel_detail');
      expect(toolNames).toContain('massu_sentinel_impact');
      expect(toolNames).toContain('massu_sentinel_validate');
      expect(toolNames).toContain('massu_sentinel_register');
      expect(toolNames).toContain('massu_sentinel_parity');
    });
  });

  describe('handleSentinelToolCall - sentinel_search', () => {
    beforeEach(() => {
      upsertFeature(db, {
        feature_key: 'auth.login',
        domain: 'auth',
        title: 'User Login',
        description: 'Login feature',
        status: 'active',
      });
      upsertFeature(db, {
        feature_key: 'auth.register',
        domain: 'auth',
        title: 'User Registration',
        status: 'active',
      });
    });

    it('searches features with query', () => {
      const result = handleSentinelToolCall('massu_sentinel_search', { query: 'login' }, db);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('auth.login');
    });

    it('filters by domain', () => {
      const result = handleSentinelToolCall('massu_sentinel_search', { domain: 'auth' }, db);
      expect(result.content[0].text).toContain('auth.login');
      expect(result.content[0].text).toContain('auth.register');
    });

    it('returns empty result for no matches', () => {
      const result = handleSentinelToolCall('massu_sentinel_search', { query: 'nonexistent' }, db);
      expect(result.content[0].text).toContain('No features found');
    });
  });

  describe('handleSentinelToolCall - sentinel_detail', () => {
    it('retrieves feature detail by key', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature',
        domain: 'test',
        title: 'Test Feature',
      });
      linkComponent(db, featureId, 'src/test.ts', 'TestComponent', 'ui', true);

      const result = handleSentinelToolCall('massu_sentinel_detail', { feature_key: 'test.feature' }, db);
      expect(result.content[0].text).toContain('Test Feature');
      expect(result.content[0].text).toContain('src/test.ts');
    });

    it('retrieves feature detail by id', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature',
        domain: 'test',
        title: 'Test Feature',
      });

      const result = handleSentinelToolCall('massu_sentinel_detail', { feature_id: featureId }, db);
      expect(result.content[0].text).toContain('Test Feature');
    });

    it('returns error for missing feature', () => {
      const result = handleSentinelToolCall('massu_sentinel_detail', { feature_key: 'nonexistent' }, db);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('handleSentinelToolCall - sentinel_impact', () => {
    it('analyzes file deletion impact', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature',
        domain: 'test',
        title: 'Test Feature',
        status: 'active',
        priority: 'critical',
      });
      linkComponent(db, featureId, 'src/test.ts', 'TestComponent', 'implementation', true);

      const result = handleSentinelToolCall('massu_sentinel_impact', { files: ['src/test.ts'] }, db);
      expect(result.content[0].text).toContain('Impact Analysis');
      expect(result.content[0].text).toContain('Orphaned');
    });

    it('returns error for missing files argument', () => {
      const result = handleSentinelToolCall('massu_sentinel_impact', {}, db);
      expect(result.content[0].text).toContain('Error');
    });
  });

  describe('handleSentinelToolCall - sentinel_validate', () => {
    it('validates all features', () => {
      upsertFeature(db, {
        feature_key: 'test.feature',
        domain: 'test',
        title: 'Test Feature',
        status: 'active',
      });

      const result = handleSentinelToolCall('massu_sentinel_validate', {}, db);
      expect(result.content[0].text).toContain('Validation Report');
      expect(result.content[0].text).toContain('Summary');
    });

    it('filters by domain', () => {
      upsertFeature(db, {
        feature_key: 'test.feature',
        domain: 'test',
        title: 'Test Feature',
        status: 'active',
      });

      const result = handleSentinelToolCall('massu_sentinel_validate', { domain: 'test' }, db);
      expect(result.content[0].text).toContain('Domain filter: test');
    });
  });

  describe('handleSentinelToolCall - sentinel_register', () => {
    it('registers a new feature', () => {
      const result = handleSentinelToolCall('massu_sentinel_register', {
        feature_key: 'new.feature',
        domain: 'test',
        title: 'New Feature',
        components: [{ file: 'src/new.ts', name: 'NewComponent', is_primary: true }],
      }, db);
      expect(result.content[0].text).toContain('Feature registered');
      expect(result.content[0].text).toContain('new.feature');
    });

    it('requires feature_key, domain, and title', () => {
      const result = handleSentinelToolCall('massu_sentinel_register', {}, db);
      expect(result.content[0].text).toContain('Error');
      expect(result.content[0].text).toContain('required');
    });
  });

  describe('handleSentinelToolCall - sentinel_parity', () => {
    it('compares old and new file sets', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature',
        domain: 'test',
        title: 'Test Feature',
      });
      linkComponent(db, featureId, 'src/old.ts', null, 'implementation', true);
      linkComponent(db, featureId, 'src/new.ts', null, 'implementation', true);

      const result = handleSentinelToolCall('massu_sentinel_parity', {
        old_files: ['src/old.ts'],
        new_files: ['src/new.ts'],
      }, db);
      expect(result.content[0].text).toContain('Parity Report');
      expect(result.content[0].text).toContain('Parity:');
    });

    it('returns error for missing arguments', () => {
      const result = handleSentinelToolCall('massu_sentinel_parity', {}, db);
      expect(result.content[0].text).toContain('Error');
    });
  });

  describe('handleSentinelToolCall - unknown tool', () => {
    it('returns error for unknown tool', () => {
      const result = handleSentinelToolCall('massu_sentinel_unknown', {}, db);
      expect(result.content[0].text).toContain('Unknown');
    });
  });
});

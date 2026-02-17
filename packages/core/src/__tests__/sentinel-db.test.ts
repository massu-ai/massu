// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  upsertFeature,
  getFeature,
  getFeatureById,
  searchFeatures,
  getFeatureImpact,
  linkComponent,
  linkProcedure,
  linkPage,
  logChange,
  validateFeatures,
  checkParity,
  clearAutoDiscoveredFeatures,
  bulkUpsertFeatures,
} from '../sentinel-db.ts';
import type { FeatureInput } from '../sentinel-types.ts';

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

    CREATE INDEX IF NOT EXISTS idx_sentinel_domain ON massu_sentinel(domain);
    CREATE INDEX IF NOT EXISTS idx_sentinel_status ON massu_sentinel(status);
    CREATE INDEX IF NOT EXISTS idx_sentinel_key ON massu_sentinel(feature_key);

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

    CREATE INDEX IF NOT EXISTS idx_sentinel_components_file ON massu_sentinel_components(component_file);
    CREATE INDEX IF NOT EXISTS idx_sentinel_procedures_router ON massu_sentinel_procedures(router_name);
    CREATE INDEX IF NOT EXISTS idx_sentinel_pages_route ON massu_sentinel_pages(page_route);
    CREATE INDEX IF NOT EXISTS idx_sentinel_changelog_feature ON massu_sentinel_changelog(feature_id);
  `);

  // FTS5 table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS massu_sentinel_fts USING fts5(
      feature_key, title, description, domain, subdomain,
      content=massu_sentinel, content_rowid=id
    );
  `);

  // FTS5 triggers
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

describe('Sentinel Database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('upsertFeature', () => {
    it('inserts a new feature', () => {
      const input: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        subdomain: 'unit',
        title: 'Test Feature 1',
        description: 'A test feature',
        status: 'active',
        priority: 'standard',
        portal_scope: ['internal'],
      };

      const id = upsertFeature(db, input);
      expect(id).toBeGreaterThan(0);

      const feature = getFeature(db, 'test.feature-1');
      expect(feature).toBeTruthy();
      expect(feature?.title).toBe('Test Feature 1');
      expect(feature?.domain).toBe('testing');
      expect(feature?.portal_scope).toEqual(['internal']);
    });

    it('updates an existing feature', () => {
      const input: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Original Title',
      };

      const id1 = upsertFeature(db, input);

      const updateInput: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Updated Title',
        status: 'deprecated',
      };

      const id2 = upsertFeature(db, updateInput);
      expect(id2).toBe(id1);

      const feature = getFeature(db, 'test.feature-1');
      expect(feature?.title).toBe('Updated Title');
      expect(feature?.status).toBe('deprecated');
    });

    it('preserves existing status if not provided', () => {
      const input1: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Feature 1',
        status: 'deprecated',
      };
      upsertFeature(db, input1);

      const input2: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Feature 1 Updated',
      };
      upsertFeature(db, input2);

      const feature = getFeature(db, 'test.feature-1');
      expect(feature?.status).toBe('deprecated');
    });
  });

  describe('getFeature and getFeatureById', () => {
    it('retrieves feature by key', () => {
      const input: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature 1',
      };
      upsertFeature(db, input);

      const feature = getFeature(db, 'test.feature-1');
      expect(feature).toBeTruthy();
      expect(feature?.feature_key).toBe('test.feature-1');
    });

    it('retrieves feature by id', () => {
      const input: FeatureInput = {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature 1',
      };
      const id = upsertFeature(db, input);

      const feature = getFeatureById(db, id);
      expect(feature).toBeTruthy();
      expect(feature?.id).toBe(id);
    });

    it('returns null for non-existent feature', () => {
      expect(getFeature(db, 'nonexistent')).toBeNull();
      expect(getFeatureById(db, 9999)).toBeNull();
    });
  });

  describe('searchFeatures', () => {
    beforeEach(() => {
      upsertFeature(db, {
        feature_key: 'auth.login',
        domain: 'auth',
        title: 'User Login',
        description: 'Login feature with email',
        status: 'active',
      });
      upsertFeature(db, {
        feature_key: 'auth.register',
        domain: 'auth',
        title: 'User Registration',
        description: 'Registration with validation',
        status: 'active',
      });
      upsertFeature(db, {
        feature_key: 'product.list',
        domain: 'product',
        title: 'Product Listing',
        status: 'deprecated',
      });
    });

    it('searches with FTS5 query', () => {
      const results = searchFeatures(db, 'login');
      expect(results.length).toBe(1);
      expect(results[0].feature_key).toBe('auth.login');
    });

    it('filters by domain', () => {
      const results = searchFeatures(db, '', { domain: 'auth' });
      expect(results.length).toBe(2);
      expect(results.every(f => f.domain === 'auth')).toBe(true);
    });

    it('filters by status', () => {
      const results = searchFeatures(db, '', { status: 'deprecated' });
      expect(results.length).toBe(1);
      expect(results[0].feature_key).toBe('product.list');
    });

    it('returns features with counts', () => {
      const id = upsertFeature(db, {
        feature_key: 'test.with-links',
        domain: 'test',
        title: 'Feature with links',
      });
      linkComponent(db, id, 'src/test.ts', 'TestComponent', 'implementation', true);
      linkProcedure(db, id, 'testRouter', 'testProc', 'query');
      linkPage(db, id, '/test', 'internal');

      const results = searchFeatures(db, '', { domain: 'test' });
      expect(results.length).toBe(1);
      expect(results[0].component_count).toBe(1);
      expect(results[0].procedure_count).toBe(1);
      expect(results[0].page_count).toBe(1);
    });
  });

  describe('linkComponent, linkProcedure, linkPage', () => {
    let featureId: number;

    beforeEach(() => {
      featureId = upsertFeature(db, {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature',
      });
    });

    it('links a component to a feature', () => {
      linkComponent(db, featureId, 'src/components/Test.tsx', 'TestComponent', 'ui', true);

      const components = db.prepare('SELECT * FROM massu_sentinel_components WHERE feature_id = ?').all(featureId);
      expect(components.length).toBe(1);
      expect(components[0]).toMatchObject({
        component_file: 'src/components/Test.tsx',
        component_name: 'TestComponent',
        role: 'ui',
        is_primary: 1,
      });
    });

    it('links a procedure to a feature', () => {
      linkProcedure(db, featureId, 'orders', 'getOrder', 'query');

      const procedures = db.prepare('SELECT * FROM massu_sentinel_procedures WHERE feature_id = ?').all(featureId);
      expect(procedures.length).toBe(1);
      expect(procedures[0]).toMatchObject({
        router_name: 'orders',
        procedure_name: 'getOrder',
        procedure_type: 'query',
      });
    });

    it('links a page to a feature', () => {
      linkPage(db, featureId, '/orders/[id]', 'internal');

      const pages = db.prepare('SELECT * FROM massu_sentinel_pages WHERE feature_id = ?').all(featureId);
      expect(pages.length).toBe(1);
      expect(pages[0]).toMatchObject({
        page_route: '/orders/[id]',
        portal: 'internal',
      });
    });
  });

  describe('logChange', () => {
    it('logs a change to the changelog', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature',
      });

      logChange(db, featureId, 'created', 'Initial creation', 'abc123', 'test-user');

      const changes = db.prepare('SELECT * FROM massu_sentinel_changelog WHERE feature_id = ?').all(featureId);
      expect(changes.length).toBe(1);
      expect(changes[0]).toMatchObject({
        change_type: 'created',
        changed_by: 'test-user',
        change_detail: 'Initial creation',
        commit_hash: 'abc123',
      });
    });
  });

  describe('getFeatureImpact', () => {
    it('identifies orphaned features', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature',
        status: 'active',
        priority: 'critical',
      });
      linkComponent(db, featureId, 'src/test.ts', 'TestComponent', 'implementation', true);

      const report = getFeatureImpact(db, ['src/test.ts']);
      expect(report.orphaned.length).toBe(1);
      expect(report.orphaned[0].feature.feature_key).toBe('test.feature-1');
      expect(report.blocked).toBe(true);
    });

    it('identifies degraded features', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature',
        status: 'active',
      });
      linkComponent(db, featureId, 'src/primary.ts', 'Primary', 'implementation', true);
      linkComponent(db, featureId, 'src/helper.ts', 'Helper', 'utility', false);

      const report = getFeatureImpact(db, ['src/helper.ts']);
      expect(report.degraded.length).toBe(1);
      expect(report.degraded[0].feature.feature_key).toBe('test.feature-1');
      expect(report.degraded[0].affected_files).toEqual(['src/helper.ts']);
      expect(report.degraded[0].remaining_files).toEqual(['src/primary.ts']);
    });
  });

  describe('validateFeatures', () => {
    it('validates features against filesystem', () => {
      upsertFeature(db, {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature',
        status: 'active',
      });

      const report = validateFeatures(db);
      expect(report.alive).toBeGreaterThanOrEqual(0);
      expect(report.orphaned).toBeGreaterThanOrEqual(0);
      expect(report.degraded).toBeGreaterThanOrEqual(0);
      expect(report.details).toBeTruthy();
    });
  });

  describe('checkParity', () => {
    it('compares old and new file sets', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.feature-1',
        domain: 'testing',
        title: 'Test Feature',
      });
      linkComponent(db, featureId, 'src/old.ts', null, 'implementation', true);
      linkComponent(db, featureId, 'src/new.ts', null, 'implementation', true);

      const report = checkParity(db, ['src/old.ts'], ['src/new.ts']);
      expect(report.done.length).toBe(1);
      expect(report.parity_percentage).toBeGreaterThan(0);
    });
  });

  describe('clearAutoDiscoveredFeatures', () => {
    it('clears auto-discovered features', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.auto-feature',
        domain: 'testing',
        title: 'Auto Feature',
      });
      logChange(db, featureId, 'created', null, undefined, 'scanner');

      clearAutoDiscoveredFeatures(db);

      const feature = getFeature(db, 'test.auto-feature');
      expect(feature).toBeNull();
    });

    it('preserves manually changed features', () => {
      const featureId = upsertFeature(db, {
        feature_key: 'test.manual-feature',
        domain: 'testing',
        title: 'Manual Feature',
      });
      logChange(db, featureId, 'created', null, undefined, 'scanner');
      logChange(db, featureId, 'updated', null, undefined, 'user');

      clearAutoDiscoveredFeatures(db);

      const feature = getFeature(db, 'test.manual-feature');
      expect(feature).toBeTruthy();
    });
  });

  describe('bulkUpsertFeatures', () => {
    it('inserts multiple features in a transaction', () => {
      const features: FeatureInput[] = [
        { feature_key: 'bulk.1', domain: 'bulk', title: 'Bulk 1' },
        { feature_key: 'bulk.2', domain: 'bulk', title: 'Bulk 2' },
        { feature_key: 'bulk.3', domain: 'bulk', title: 'Bulk 3' },
      ];

      const count = bulkUpsertFeatures(db, features);
      expect(count).toBe(3);

      const results = searchFeatures(db, '', { domain: 'bulk' });
      expect(results.length).toBe(3);
    });
  });
});

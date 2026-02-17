// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runFeatureScan } from '../sentinel-scanner.ts';
import type { ScanResult } from '../sentinel-scanner.ts';

// Mock config — domains drive domain-inference logic
vi.mock('../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'trpc', orm: 'prisma' },
    paths: { source: 'src', components: 'src/components' },
    domains: [
      {
        name: 'auth',
        routers: ['auth', 'user'],
        pages: ['/auth', '/login'],
        tables: [],
        allowedImportsFrom: [],
      },
      {
        name: 'orders',
        routers: ['orders', 'orderItems'],
        pages: ['/orders'],
        tables: [],
        allowedImportsFrom: [],
      },
      {
        name: 'billing',
        routers: ['billing', 'subscription'],
        pages: ['/billing'],
        tables: [],
        allowedImportsFrom: [],
      },
    ],
  }),
  getProjectRoot: () => '/test/project',
}));

// Mock fs so scanComponentExports does not touch the real filesystem
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  };
});

// ============================================================
// Shared DB helper
// ============================================================

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

    CREATE TABLE IF NOT EXISTS massu_trpc_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT,
      router_file TEXT
    );

    CREATE TABLE IF NOT EXISTS massu_page_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_file TEXT NOT NULL,
      route TEXT NOT NULL,
      portal TEXT,
      components TEXT DEFAULT '[]',
      hooks TEXT DEFAULT '[]',
      routers TEXT DEFAULT '[]'
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

// ============================================================
// Helpers
// ============================================================

function insertProcedure(
  db: Database.Database,
  routerName: string,
  procedureName: string,
  procedureType: string,
  routerFile: string
): void {
  db.prepare(`
    INSERT INTO massu_trpc_procedures (router_name, procedure_name, procedure_type, router_file)
    VALUES (?, ?, ?, ?)
  `).run(routerName, procedureName, procedureType, routerFile);
}

function insertPage(
  db: Database.Database,
  pageFile: string,
  route: string,
  portal: string | null,
  components: string[] = [],
  routers: string[] = []
): void {
  db.prepare(`
    INSERT INTO massu_page_deps (page_file, route, portal, components, hooks, routers)
    VALUES (?, ?, ?, ?, '[]', ?)
  `).run(pageFile, route, portal, JSON.stringify(components), JSON.stringify(routers));
}

function getFeatureRows(db: Database.Database): { feature_key: string; domain: string; subdomain: string | null; title: string }[] {
  return db.prepare('SELECT feature_key, domain, subdomain, title FROM massu_sentinel ORDER BY feature_key').all() as any[];
}

function getComponentRows(db: Database.Database, featureKey: string): { component_file: string; role: string; is_primary: number }[] {
  return db.prepare(`
    SELECT sc.component_file, sc.role, sc.is_primary
    FROM massu_sentinel_components sc
    JOIN massu_sentinel s ON s.id = sc.feature_id
    WHERE s.feature_key = ?
    ORDER BY sc.component_file
  `).all(featureKey) as any[];
}

function getProcedureRows(db: Database.Database, featureKey: string): { router_name: string; procedure_name: string; procedure_type: string }[] {
  return db.prepare(`
    SELECT sp.router_name, sp.procedure_name, sp.procedure_type
    FROM massu_sentinel_procedures sp
    JOIN massu_sentinel s ON s.id = sp.feature_id
    WHERE s.feature_key = ?
    ORDER BY sp.procedure_name
  `).all(featureKey) as any[];
}

function getPageRows(db: Database.Database, featureKey: string): { page_route: string; portal: string | null }[] {
  return db.prepare(`
    SELECT sp.page_route, sp.portal
    FROM massu_sentinel_pages sp
    JOIN massu_sentinel s ON s.id = sp.feature_id
    WHERE s.feature_key = ?
    ORDER BY sp.page_route
  `).all(featureKey) as any[];
}

function getChangelogRows(db: Database.Database, featureKey: string): { change_type: string; changed_by: string | null; change_detail: string | null }[] {
  return db.prepare(`
    SELECT sc.change_type, sc.changed_by, sc.change_detail
    FROM massu_sentinel_changelog sc
    JOIN massu_sentinel s ON s.id = sc.feature_id
    WHERE s.feature_key = ?
    ORDER BY sc.id
  `).all(featureKey) as any[];
}

// ============================================================
// Tests
// ============================================================

describe('sentinel-scanner / runFeatureScan', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ----------------------------------------------------------
  // ScanResult shape
  // ----------------------------------------------------------

  describe('ScanResult shape', () => {
    it('returns all required ScanResult fields when tables are empty', () => {
      const result: ScanResult = runFeatureScan(db);
      expect(typeof result.totalDiscovered).toBe('number');
      expect(typeof result.fromProcedures).toBe('number');
      expect(typeof result.fromPages).toBe('number');
      expect(typeof result.fromComponents).toBe('number');
      expect(typeof result.registered).toBe('number');
    });

    it('returns zeros when no tRPC procedures and no pages exist', () => {
      const result = runFeatureScan(db);
      expect(result.totalDiscovered).toBe(0);
      expect(result.fromProcedures).toBe(0);
      expect(result.fromPages).toBe(0);
      expect(result.fromComponents).toBe(0);
      expect(result.registered).toBe(0);
    });

    it('totalDiscovered equals registered when there are no key collisions', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertPage(db, 'src/app/dashboard/page.tsx', '/dashboard', 'internal');
      const result = runFeatureScan(db);
      expect(result.totalDiscovered).toBe(result.registered);
    });
  });

  // ----------------------------------------------------------
  // Feature discovery from tRPC procedures
  // ----------------------------------------------------------

  describe('Feature discovery from tRPC procedures', () => {
    it('discovers one feature per unique procedure', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertProcedure(db, 'auth', 'createUser', 'mutation', 'src/server/api/routers/auth.ts');

      const result = runFeatureScan(db);
      expect(result.fromProcedures).toBe(2);
    });

    it('registers features in massu_sentinel for each procedure', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const feature = rows.find(r => r.feature_key === 'auth.getUser');
      expect(feature).toBeTruthy();
    });

    it('links the router file as a data component', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);

      const comps = getComponentRows(db, 'auth.getUser');
      expect(comps.length).toBeGreaterThanOrEqual(1);
      const routerComp = comps.find(c => c.component_file === 'src/server/api/routers/auth.ts');
      expect(routerComp).toBeTruthy();
      expect(routerComp!.role).toBe('data');
    });

    it('does not duplicate router file component when multiple procedures share a router file', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertProcedure(db, 'auth', 'listUsers', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);

      // Each feature key is distinct, so each has its own component entry
      const compsGet = getComponentRows(db, 'auth.getUser');
      const compslist = getComponentRows(db, 'auth.listUsers');
      expect(compsGet.length).toBe(1);
      expect(compslist.length).toBe(1);
    });

    it('links procedure details to the feature', () => {
      insertProcedure(db, 'orders', 'createOrder', 'mutation', 'src/server/api/routers/orders.ts');

      runFeatureScan(db);

      const procs = getProcedureRows(db, 'orders.createOrder');
      expect(procs.length).toBe(1);
      expect(procs[0].router_name).toBe('orders');
      expect(procs[0].procedure_name).toBe('createOrder');
      expect(procs[0].procedure_type).toBe('mutation');
    });

    it('generates a changelog entry per feature with changed_by = scanner', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);

      const changelog = getChangelogRows(db, 'auth.getUser');
      expect(changelog.length).toBeGreaterThanOrEqual(1);
      const entry = changelog.find(c => c.changed_by === 'scanner');
      expect(entry).toBeTruthy();
      expect(entry!.change_type).toBe('created');
    });

    it('handles multiple routers independently', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertProcedure(db, 'orders', 'listOrders', 'query', 'src/server/api/routers/orders.ts');

      const result = runFeatureScan(db);
      expect(result.fromProcedures).toBe(2);

      const rows = getFeatureRows(db);
      const keys = rows.map(r => r.feature_key);
      expect(keys).toContain('auth.getUser');
      expect(keys).toContain('orders.listOrders');
    });
  });

  // ----------------------------------------------------------
  // Feature discovery from page routes
  // ----------------------------------------------------------

  describe('Feature discovery from page routes', () => {
    it('discovers one feature per valid page route', () => {
      insertPage(db, 'src/app/dashboard/page.tsx', '/dashboard', 'internal');
      insertPage(db, 'src/app/settings/page.tsx', '/settings', 'internal');

      const result = runFeatureScan(db);
      expect(result.fromPages).toBe(2);
    });

    it('registers page feature with correct feature_key format', () => {
      insertPage(db, 'src/app/dashboard/page.tsx', '/dashboard', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.dashboard');
      expect(feature).toBeTruthy();
    });

    it('sets page feature title to Page: <route>', () => {
      insertPage(db, 'src/app/settings/page.tsx', '/settings', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.settings');
      expect(feature).toBeTruthy();
      expect(feature!.title).toBe('Page: /settings');
    });

    it('skips error pages', () => {
      insertPage(db, 'src/app/error.tsx', '/error', null);

      const result = runFeatureScan(db);
      expect(result.fromPages).toBe(0);
    });

    it('skips not-found pages', () => {
      insertPage(db, 'src/app/not-found.tsx', '/not-found', null);

      const result = runFeatureScan(db);
      expect(result.fromPages).toBe(0);
    });

    it('skips the root route /', () => {
      insertPage(db, 'src/app/page.tsx', '/', null);

      const result = runFeatureScan(db);
      expect(result.fromPages).toBe(0);
    });

    it('links the page file as a primary ui component', () => {
      insertPage(db, 'src/app/dashboard/page.tsx', '/dashboard', 'internal');

      runFeatureScan(db);

      const comps = getComponentRows(db, 'page.dashboard');
      const primary = comps.find(c => c.component_file === 'src/app/dashboard/page.tsx');
      expect(primary).toBeTruthy();
      expect(primary!.role).toBe('ui');
      expect(primary!.is_primary).toBe(1);
    });

    it('links additional components from page deps as non-primary ui', () => {
      insertPage(
        db,
        'src/app/dashboard/page.tsx',
        '/dashboard',
        'internal',
        ['src/components/Dashboard.tsx', 'src/components/Widget.tsx']
      );

      runFeatureScan(db);

      const comps = getComponentRows(db, 'page.dashboard');
      expect(comps.length).toBe(3); // page file + 2 components
      const nonPrimary = comps.filter(c => c.is_primary === 0);
      expect(nonPrimary.length).toBe(2);
      expect(nonPrimary.every(c => c.role === 'ui')).toBe(true);
    });

    it('links the page route to the feature', () => {
      insertPage(db, 'src/app/orders/page.tsx', '/orders', 'internal');

      runFeatureScan(db);

      const pages = getPageRows(db, 'page.orders');
      expect(pages.length).toBe(1);
      expect(pages[0].page_route).toBe('/orders');
      expect(pages[0].portal).toBe('internal');
    });

    it('handles nested routes with dynamic segments', () => {
      insertPage(db, 'src/app/orders/[id]/page.tsx', '/orders/[id]', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      // Feature key replaces [id] with _id_
      const feature = rows.find(r => r.feature_key.includes('orders'));
      expect(feature).toBeTruthy();
    });

    it('handles routes with portal = null', () => {
      insertPage(db, 'src/app/public/page.tsx', '/public', null);

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.public');
      expect(feature).toBeTruthy();
    });
  });

  // ----------------------------------------------------------
  // Feature discovery from component annotations (fs mocked away)
  // ----------------------------------------------------------

  describe('Feature discovery from component annotations', () => {
    it('reports zero fromComponents when filesystem is empty (mocked)', () => {
      const result = runFeatureScan(db);
      expect(result.fromComponents).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Domain inference
  // ----------------------------------------------------------

  describe('Domain inference from file paths', () => {
    it('infers "auth" domain from router file containing "auth"', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'auth.getUser');
      expect(feature).toBeTruthy();
      expect(feature!.domain).toBe('auth');
    });

    it('infers "orders" domain from router file containing "orders"', () => {
      insertProcedure(db, 'orders', 'listOrders', 'query', 'src/server/api/routers/orders.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'orders.listOrders');
      expect(feature).toBeTruthy();
      expect(feature!.domain).toBe('orders');
    });

    it('falls back to "system" domain when no domain matches the file path', () => {
      insertProcedure(db, 'misc', 'ping', 'query', 'src/server/api/routers/misc.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'misc.ping');
      expect(feature).toBeTruthy();
      expect(feature!.domain).toBe('system');
    });

    it('infers "auth" domain from page route containing "auth" keyword', () => {
      // Insert a route whose path includes a known domain name word
      insertPage(db, 'src/app/auth/login/page.tsx', '/auth/login', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.auth.login');
      expect(feature).toBeTruthy();
      expect(feature!.domain).toBe('auth');
    });

    it('falls back to "system" for routes that do not match any domain', () => {
      insertPage(db, 'src/app/about/page.tsx', '/about', null);

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.about');
      expect(feature).toBeTruthy();
      expect(feature!.domain).toBe('system');
    });
  });

  // ----------------------------------------------------------
  // Kebab-to-title conversion (tested via generated titles)
  // ----------------------------------------------------------

  describe('Kebab-to-title conversion in generated feature titles', () => {
    it('converts simple kebab router name to title case in feature title', () => {
      // Router 'auth' → subdomain 'auth' → title includes 'Auth'
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'auth.getUser');
      expect(feature).toBeTruthy();
      // Title should be 'Auth - Get User' or similar capitalised form
      expect(feature!.title).toMatch(/Auth/);
    });

    it('converts camelCase router to kebab subdomain correctly', () => {
      // orderItems router → subdomain: 'order-items'
      insertProcedure(db, 'orderItems', 'listItems', 'query', 'src/server/api/routers/orderItems.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'order-items.listItems');
      expect(feature).toBeTruthy();
      expect(feature!.subdomain).toBe('order-items');
    });

    it('converts procedure name with camelCase to readable title words', () => {
      insertProcedure(db, 'billing', 'createSubscription', 'mutation', 'src/server/api/routers/billing.ts');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'billing.createSubscription');
      expect(feature).toBeTruthy();
      // Title contains capitalised versions from kebabToTitle applied to the procedure name
      expect(feature!.title).toBeTruthy();
      expect(feature!.title.length).toBeGreaterThan(0);
    });

    it('generates page feature title starting with "Page:"', () => {
      insertPage(db, 'src/app/settings/page.tsx', '/settings', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.settings');
      expect(feature!.title).toMatch(/^Page:/);
    });
  });

  // ----------------------------------------------------------
  // Merge priority (components > pages > procedures)
  // ----------------------------------------------------------

  describe('Feature merge priority', () => {
    it('page feature overwrites procedure feature with same key', () => {
      // This is unlikely in practice but tests the merge order
      // Insert a page whose feature_key would collide with a procedure feature
      // The page scanner produces 'page.<route>', procedure scanner 'router.proc'
      // so we test indirectly: fromProcedures + fromPages are both counted correctly
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertPage(db, 'src/app/dashboard/page.tsx', '/dashboard', 'internal');

      const result = runFeatureScan(db);
      // Both are distinct keys: 'auth.getUser' and 'page.dashboard'
      expect(result.totalDiscovered).toBe(2);
      expect(result.registered).toBe(2);
    });

    it('registered count equals totalDiscovered for distinct keys', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertProcedure(db, 'auth', 'createUser', 'mutation', 'src/server/api/routers/auth.ts');
      insertPage(db, 'src/app/profile/page.tsx', '/profile', 'internal');

      const result = runFeatureScan(db);
      expect(result.totalDiscovered).toBe(result.registered);
    });
  });

  // ----------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------

  describe('Edge cases', () => {
    it('handles empty massu_trpc_procedures gracefully', () => {
      expect(() => runFeatureScan(db)).not.toThrow();
    });

    it('handles empty massu_page_deps gracefully', () => {
      expect(() => runFeatureScan(db)).not.toThrow();
    });

    it('is idempotent: running scan twice does not throw (upserts on second run)', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      expect(() => {
        runFeatureScan(db);
        runFeatureScan(db);
      }).not.toThrow();
    });

    it('second scan does not duplicate features', () => {
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');

      runFeatureScan(db);
      runFeatureScan(db);

      const rows = db.prepare('SELECT COUNT(*) as cnt FROM massu_sentinel WHERE feature_key = ?').get('auth.getUser') as { cnt: number };
      expect(rows.cnt).toBe(1);
    });

    it('handles a procedure with an empty router_file path', () => {
      insertProcedure(db, 'misc', 'healthCheck', 'query', '');

      expect(() => runFeatureScan(db)).not.toThrow();

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'misc.healthCheck');
      expect(feature).toBeTruthy();
    });

    it('handles page with empty components list', () => {
      insertPage(db, 'src/app/empty/page.tsx', '/empty', null, []);

      runFeatureScan(db);

      const comps = getComponentRows(db, 'page.empty');
      // Only the page file itself should be linked
      expect(comps.length).toBe(1);
      expect(comps[0].component_file).toBe('src/app/empty/page.tsx');
    });

    it('returns fromProcedures count reflecting unique feature keys, not raw procedure count', () => {
      // Two procedures for the same router → two separate feature keys
      insertProcedure(db, 'auth', 'getUser', 'query', 'src/server/api/routers/auth.ts');
      insertProcedure(db, 'auth', 'deleteUser', 'mutation', 'src/server/api/routers/auth.ts');

      const result = runFeatureScan(db);
      expect(result.fromProcedures).toBe(2);
    });

    it('page feature key replaces slashes with dots and strips leading/trailing dots', () => {
      insertPage(db, 'src/app/admin/users/page.tsx', '/admin/users', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.admin.users');
      expect(feature).toBeTruthy();
    });

    it('page feature key handles dynamic route segment notation', () => {
      insertPage(db, 'src/app/products/[id]/page.tsx', '/products/[id]', 'internal');

      runFeatureScan(db);

      const rows = getFeatureRows(db);
      const feature = rows.find(r => r.feature_key === 'page.products._id_');
      expect(feature).toBeTruthy();
    });
  });
});

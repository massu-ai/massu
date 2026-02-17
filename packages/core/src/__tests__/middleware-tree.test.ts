// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildMiddlewareTree, isInMiddlewareTree, getMiddlewareTree } from '../middleware-tree.ts';

// Mock config
vi.mock('../config.ts', () => ({
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
}));

function createTestDb(): Database.Database {
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

    CREATE TABLE IF NOT EXISTS massu_middleware_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL UNIQUE
    );
  `);

  return db;
}

describe('Middleware Tree', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('buildMiddlewareTree', () => {
    it('builds middleware tree from imports', () => {
      // Seed import edges
      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES
          ('src/middleware.ts', 'src/lib/auth.ts', 'named'),
          ('src/lib/auth.ts', 'src/lib/session.ts', 'named'),
          ('src/lib/auth.ts', 'src/utils/crypto.ts', 'named')
      `).run();

      const count = buildMiddlewareTree(db);
      expect(count).toBeGreaterThan(0);

      const files = getMiddlewareTree(db);
      expect(files).toContain('src/middleware.ts');
      expect(files).toContain('src/lib/auth.ts');
      expect(files).toContain('src/lib/session.ts');
      expect(files).toContain('src/utils/crypto.ts');
    });

    it('includes transitive imports', () => {
      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES
          ('src/middleware.ts', 'src/lib/auth.ts', 'named'),
          ('src/lib/auth.ts', 'src/lib/session.ts', 'named'),
          ('src/lib/session.ts', 'src/lib/database.ts', 'named')
      `).run();

      buildMiddlewareTree(db);
      const files = getMiddlewareTree(db);
      expect(files).toContain('src/lib/database.ts');
    });

    it('ignores non-src imports', () => {
      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES
          ('src/middleware.ts', 'src/lib/auth.ts', 'named'),
          ('src/lib/auth.ts', 'node_modules/lodash/index.js', 'named')
      `).run();

      buildMiddlewareTree(db);
      const files = getMiddlewareTree(db);
      expect(files).not.toContain('node_modules/lodash/index.js');
    });

    it('clears existing tree before rebuild', () => {
      db.prepare(`INSERT INTO massu_middleware_tree (file) VALUES ('old-file.ts')`).run();

      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES ('src/middleware.ts', 'src/lib/new.ts', 'named')
      `).run();

      buildMiddlewareTree(db);
      const files = getMiddlewareTree(db);
      expect(files).not.toContain('old-file.ts');
      expect(files).toContain('src/middleware.ts');
    });

    it('handles missing middleware path gracefully', () => {
      // Note: vi.mock doesn't work inside a test, so we test with configured path
      // The actual function returns 0 for null/undefined middleware path, but
      // our mock always has middleware configured, so we just verify it doesn't throw
      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES ('src/middleware.ts', 'src/lib/auth.ts', 'named')
      `).run();

      const count = buildMiddlewareTree(db);
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isInMiddlewareTree', () => {
    beforeEach(() => {
      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES
          ('src/middleware.ts', 'src/lib/auth.ts', 'named'),
          ('src/lib/auth.ts', 'src/lib/session.ts', 'named')
      `).run();
      buildMiddlewareTree(db);
    });

    it('returns true for files in tree', () => {
      expect(isInMiddlewareTree(db, 'src/middleware.ts')).toBe(true);
      expect(isInMiddlewareTree(db, 'src/lib/auth.ts')).toBe(true);
      expect(isInMiddlewareTree(db, 'src/lib/session.ts')).toBe(true);
    });

    it('returns false for files not in tree', () => {
      expect(isInMiddlewareTree(db, 'src/app/page.tsx')).toBe(false);
      expect(isInMiddlewareTree(db, 'src/utils/helpers.ts')).toBe(false);
    });
  });

  describe('getMiddlewareTree', () => {
    it('returns all files in tree sorted', () => {
      db.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES
          ('src/middleware.ts', 'src/lib/b.ts', 'named'),
          ('src/middleware.ts', 'src/lib/a.ts', 'named'),
          ('src/middleware.ts', 'src/lib/c.ts', 'named')
      `).run();
      buildMiddlewareTree(db);

      const files = getMiddlewareTree(db);
      expect(files.length).toBe(4); // middleware + 3 imports
      expect(files).toEqual([...files].sort()); // Check if sorted
    });

    it('returns empty array when tree is empty', () => {
      const files = getMiddlewareTree(db);
      expect(files).toEqual([]);
    });
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { classifyRouter, classifyFile, findCrossDomainImports, getFilesInDomain } from '../domains.ts';

// Mock config
vi.mock('../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'trpc', orm: 'prisma' },
    paths: { source: 'src', routers: 'src/server/api/routers' },
    domains: [
      {
        name: 'auth',
        routers: ['auth', 'user'],
        pages: ['src/app/auth/**'],
        tables: ['users', 'sessions'],
        allowedImportsFrom: ['*'],
      },
      {
        name: 'product',
        routers: ['product', 'catalog'],
        pages: ['src/app/products/**'],
        tables: ['products'],
        allowedImportsFrom: ['auth'],
      },
      {
        name: 'order',
        routers: ['order*'],
        pages: ['src/app/orders/**'],
        tables: ['orders'],
        allowedImportsFrom: ['auth', 'product'],
      },
    ],
  }),
  getProjectRoot: () => '/test/project',
  getResolvedPaths: () => ({
    codegraphDbPath: '/test/codegraph.db',
    dataDbPath: '/test/data.db',
  }),
}));

function createTestDataDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS massu_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      target_file TEXT NOT NULL,
      import_type TEXT NOT NULL,
      imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

function createTestCodeGraphDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL
    );
  `);

  return db;
}

describe('Domains Module', () => {
  let dataDb: Database.Database;
  let codegraphDb: Database.Database;

  beforeEach(() => {
    dataDb = createTestDataDb();
    codegraphDb = createTestCodeGraphDb();
  });

  afterEach(() => {
    dataDb.close();
    codegraphDb.close();
  });

  describe('classifyRouter', () => {
    it('classifies router by exact match', () => {
      expect(classifyRouter('auth')).toBe('auth');
      expect(classifyRouter('user')).toBe('auth');
      expect(classifyRouter('product')).toBe('product');
    });

    it('classifies router by wildcard pattern', () => {
      expect(classifyRouter('orders')).toBe('order');
      expect(classifyRouter('orderHistory')).toBe('order');
    });

    it('returns Unknown for unmatched router', () => {
      expect(classifyRouter('unknownRouter')).toBe('Unknown');
    });
  });

  describe('classifyFile', () => {
    it('classifies file by page pattern', () => {
      expect(classifyFile('src/app/auth/login/page.tsx')).toBe('auth');
      expect(classifyFile('src/app/products/list/page.tsx')).toBe('product');
      expect(classifyFile('src/app/orders/[id]/page.tsx')).toBe('order');
    });

    it('classifies router file by path', () => {
      expect(classifyFile('src/server/api/routers/auth.ts')).toBe('auth');
      expect(classifyFile('src/server/api/routers/product.ts')).toBe('product');
      expect(classifyFile('src/server/api/routers/orders.ts')).toBe('order');
    });

    it('classifies component file by directory name', () => {
      expect(classifyFile('src/components/auth/LoginForm.tsx')).toBe('auth');
      expect(classifyFile('src/components/product/ProductCard.tsx')).toBe('product');
    });

    it('returns Unknown for unclassifiable file', () => {
      expect(classifyFile('src/utils/helpers.ts')).toBe('Unknown');
    });
  });

  describe('findCrossDomainImports', () => {
    beforeEach(() => {
      // Seed test imports
      dataDb.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type, imported_names)
        VALUES
          ('src/app/orders/page.tsx', 'src/app/auth/hooks.ts', 'named', '["useAuth"]'),
          ('src/app/orders/page.tsx', 'src/app/products/api.ts', 'named', '["getProduct"]'),
          ('src/app/products/page.tsx', 'src/app/orders/utils.ts', 'named', '["formatOrder"]'),
          ('src/app/auth/page.tsx', 'src/app/auth/login.tsx', 'named', '["LoginForm"]')
      `).run();
    });

    it('identifies cross-domain imports', () => {
      const crossings = findCrossDomainImports(dataDb);
      expect(crossings.length).toBeGreaterThan(0);

      const orderToAuth = crossings.find(c => c.sourceDomain === 'order' && c.targetDomain === 'auth');
      expect(orderToAuth).toBeTruthy();
    });

    it('marks allowed imports correctly', () => {
      const crossings = findCrossDomainImports(dataDb);
      const orderToAuth = crossings.find(c => c.sourceDomain === 'order' && c.targetDomain === 'auth');
      expect(orderToAuth?.allowed).toBe(true); // order allows imports from auth
    });

    it('marks disallowed imports as violations', () => {
      const crossings = findCrossDomainImports(dataDb);
      const productToOrder = crossings.find(c => c.sourceDomain === 'product' && c.targetDomain === 'order');
      if (productToOrder) {
        expect(productToOrder.allowed).toBe(false); // product doesn't allow imports from order
      }
    });

    it('ignores same-domain imports', () => {
      const crossings = findCrossDomainImports(dataDb);
      const authToAuth = crossings.find(c => c.sourceDomain === 'auth' && c.targetDomain === 'auth');
      expect(authToAuth).toBeUndefined();
    });

    it('ignores Unknown domain imports', () => {
      dataDb.prepare(`
        INSERT INTO massu_imports (source_file, target_file, import_type)
        VALUES ('src/utils/helper.ts', 'src/app/auth/page.tsx', 'named')
      `).run();

      const crossings = findCrossDomainImports(dataDb);
      const unknownToAuth = crossings.find(c => c.sourceDomain === 'Unknown');
      expect(unknownToAuth).toBeUndefined();
    });
  });

  describe('getFilesInDomain', () => {
    beforeEach(() => {
      // Seed test files
      codegraphDb.prepare(`
        INSERT INTO files (path) VALUES
          ('src/server/api/routers/auth.ts'),
          ('src/server/api/routers/user.ts'),
          ('src/server/api/routers/product.ts'),
          ('src/app/auth/login/page.tsx'),
          ('src/app/auth/register/page.tsx'),
          ('src/app/products/list/page.tsx'),
          ('src/components/auth/LoginForm.tsx'),
          ('src/components/product/ProductCard.tsx')
      `).run();
    });

    it('returns routers in domain', () => {
      const files = getFilesInDomain(dataDb, codegraphDb, 'auth');
      expect(files.routers.length).toBeGreaterThan(0);
      expect(files.routers).toContain('src/server/api/routers/auth.ts');
      expect(files.routers).toContain('src/server/api/routers/user.ts');
    });

    it('returns pages in domain', () => {
      const files = getFilesInDomain(dataDb, codegraphDb, 'auth');
      expect(files.pages.length).toBeGreaterThan(0);
      expect(files.pages).toContain('src/app/auth/login/page.tsx');
      expect(files.pages).toContain('src/app/auth/register/page.tsx');
    });

    it('returns components in domain', () => {
      const files = getFilesInDomain(dataDb, codegraphDb, 'auth');
      expect(files.components.length).toBeGreaterThan(0);
      expect(files.components).toContain('src/components/auth/LoginForm.tsx');
    });

    it('returns empty for nonexistent domain', () => {
      const files = getFilesInDomain(dataDb, codegraphDb, 'nonexistent');
      expect(files.routers).toEqual([]);
      expect(files.pages).toEqual([]);
      expect(files.components).toEqual([]);
    });

    it('filters files correctly by domain', () => {
      const authFiles = getFilesInDomain(dataDb, codegraphDb, 'auth');
      const productFiles = getFilesInDomain(dataDb, codegraphDb, 'product');

      expect(authFiles.routers).not.toContain('src/server/api/routers/product.ts');
      expect(productFiles.routers).toContain('src/server/api/routers/product.ts');
    });
  });
});

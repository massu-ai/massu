// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { resetConfig, getResolvedPaths } from '../config.ts';
import { getDataDb } from '../db.ts';
import { t } from '../lib/sql-table-names.ts';
import {
  buildPageDeps,
  getPageChain,
  findAffectedPages,
} from '../page-deps.ts';

const TEST_DIR = resolve(__dirname, '../test-page-deps-tmp');

function write(path: string, content: string) {
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/** Build an in-memory codegraph-shaped DB with a `files` table. */
function makeCodegraphDb(paths: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files (path TEXT)');
  const ins = db.prepare('INSERT INTO files (path) VALUES (?)');
  for (const p of paths) ins.run(p);
  return db;
}

describe('page-deps (DB-backed dependency chains)', () => {
  const originalCwd = process.cwd();
  let dataDb: Database.Database;

  beforeEach(() => {
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    write(resolve(TEST_DIR, 'massu.config.yaml'), 'project:\n  name: app\npaths:\n  source: src\n');
    process.chdir(TEST_DIR);
    dataDb = getDataDb();
  });

  afterEach(() => {
    try { dataDb.close(); } catch { /* already closed */ }
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function seedImports(rows: Array<{ source: string; target: string; names?: string }>) {
    const stmt = dataDb.prepare(
      `INSERT INTO ${t('imports')} (source_file, target_file, import_type, imported_names, line) VALUES (?, ?, 'named', ?, 1)`
    );
    for (const r of rows) stmt.run(r.source, r.target, r.names ?? '[]');
  }

  function seedTrpcProcedure(routerName: string, routerFile: string) {
    dataDb
      .prepare(
        `INSERT INTO ${t('trpc_procedures')} (router_file, router_name, procedure_name, procedure_type) VALUES (?, ?, 'list', 'query')`
      )
      .run(routerFile, routerName);
  }

  it('builds page deps tracing components, hooks, routers, and tables', () => {
    // Page imports a component and a hook; the hook calls api.orders.list;
    // the orders router touches ctx.db.orders.
    seedImports([
      { source: 'src/app/orders/page.tsx', target: 'src/components/OrderList.tsx' },
      { source: 'src/app/orders/page.tsx', target: 'src/hooks/useOrders.ts' },
    ]);
    seedTrpcProcedure('orders', 'src/server/api/routers/orders.ts');

    // Real on-disk files for findRouterCalls + findTablesFromRouters.
    write(
      resolve(TEST_DIR, 'src/hooks/useOrders.ts'),
      'export function useOrders() { return api.orders.list.useQuery(); }'
    );
    write(
      resolve(TEST_DIR, 'src/components/OrderList.tsx'),
      'export function OrderList() { return api.orders.list.useQuery(); }'
    );
    write(
      resolve(TEST_DIR, 'src/server/api/routers/orders.ts'),
      'export const ordersRouter = router({ list: q(async ({ ctx }) => ctx.db.orders.findMany()) });'
    );

    const codegraphDb = makeCodegraphDb([
      'src/app/orders/page.tsx',
      'src/app/page.tsx',
    ]);

    const count = buildPageDeps(dataDb, codegraphDb);
    codegraphDb.close();

    expect(count).toBe(2);

    const chain = getPageChain(dataDb, 'src/app/orders/page.tsx');
    expect(chain).not.toBeNull();
    expect(chain!.route).toBe('/orders');
    expect(chain!.portal).toBe('orders');
    expect(chain!.components).toContain('src/components/OrderList.tsx');
    expect(chain!.hooks).toContain('src/hooks/useOrders.ts');
    expect(chain!.routers).toContain('orders');
    expect(chain!.tables).toContain('orders');

    // Root page has no imports -> empty chain.
    const rootChain = getPageChain(dataDb, 'src/app/page.tsx');
    expect(rootChain).not.toBeNull();
    expect(rootChain!.route).toBe('/');
    expect(rootChain!.components).toEqual([]);
  });

  it('getPageChain returns null for an unknown page', () => {
    const codegraphDb = makeCodegraphDb([]);
    buildPageDeps(dataDb, codegraphDb);
    codegraphDb.close();
    expect(getPageChain(dataDb, 'src/app/missing/page.tsx')).toBeNull();
  });

  it('buildPageDeps clears prior rows on rebuild', () => {
    let codegraphDb = makeCodegraphDb(['src/app/a/page.tsx', 'src/app/b/page.tsx']);
    expect(buildPageDeps(dataDb, codegraphDb)).toBe(2);
    codegraphDb.close();

    // Rebuild with a single page; prior rows must be deleted.
    codegraphDb = makeCodegraphDb(['src/app/a/page.tsx']);
    expect(buildPageDeps(dataDb, codegraphDb)).toBe(1);
    codegraphDb.close();

    expect(getPageChain(dataDb, 'src/app/b/page.tsx')).toBeNull();
    expect(getPageChain(dataDb, 'src/app/a/page.tsx')).not.toBeNull();
  });

  it('findAffectedPages returns the page directly when given a page file', () => {
    const codegraphDb = makeCodegraphDb(['src/app/orders/page.tsx']);
    buildPageDeps(dataDb, codegraphDb);
    codegraphDb.close();

    const affected = findAffectedPages(dataDb, 'src/app/orders/page.tsx');
    expect(affected).toHaveLength(1);
    expect(affected[0].page).toBe('src/app/orders/page.tsx');
  });

  it('findAffectedPages walks the import tree to reach pages transitively', () => {
    // page -> mid -> leaf. Changing leaf should surface the page.
    seedImports([
      { source: 'src/app/orders/page.tsx', target: 'src/components/Mid.tsx' },
      { source: 'src/components/Mid.tsx', target: 'src/lib/leaf.ts' },
    ]);
    const codegraphDb = makeCodegraphDb(['src/app/orders/page.tsx']);
    buildPageDeps(dataDb, codegraphDb);
    codegraphDb.close();

    const affected = findAffectedPages(dataDb, 'src/lib/leaf.ts');
    expect(affected.map(a => a.page)).toContain('src/app/orders/page.tsx');
  });

  it('findAffectedPages returns empty when the file affects no page', () => {
    const codegraphDb = makeCodegraphDb(['src/app/orders/page.tsx']);
    buildPageDeps(dataDb, codegraphDb);
    codegraphDb.close();

    const affected = findAffectedPages(dataDb, 'src/lib/orphan.ts');
    expect(affected).toEqual([]);
  });

  it('writes the data DB under the resolved project root', () => {
    // sanity: the resolved data DB path lives inside the temp project
    expect(getResolvedPaths().dataDbPath.startsWith(TEST_DIR)).toBe(true);
  });
});

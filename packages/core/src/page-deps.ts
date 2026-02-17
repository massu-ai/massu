// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import { getConfig, getProjectRoot } from './config.ts';

export interface PageChain {
  page: string;
  route: string;
  portal: string;
  components: string[];
  hooks: string[];
  routers: string[];
  tables: string[];
}

/**
 * Derive the URL route from a Next.js page file path.
 * e.g., src/app/orders/page.tsx -> /orders
 * e.g., src/app/orders/[id]/page.tsx -> /orders/[id]
 */
export function deriveRoute(pageFile: string): string {
  let route = pageFile
    .replace(/^src\/app/, '')
    .replace(/\/page\.tsx?$/, '')
    .replace(/\/page\.jsx?$/, '');
  return route || '/';
}

/**
 * Determine which portal/scope a page belongs to based on its route.
 * Uses accessScopes from config if available, otherwise infers from route prefix.
 */
export function derivePortal(route: string): string {
  const scopes = getConfig().accessScopes;
  if (scopes && scopes.length > 0) {
    for (const scope of scopes) {
      if (route.startsWith('/' + scope)) return scope;
    }
  }
  // Fallback: use the first path segment as the scope
  const parts = route.split('/').filter(Boolean);
  return parts[0] ?? 'default';
}

/**
 * Recursively trace imports from a file, collecting components and hooks.
 */
function traceImports(
  startFile: string,
  dataDb: Database.Database,
  visited: Set<string>,
  components: Set<string>,
  hooks: Set<string>,
  maxDepth: number = 5
): void {
  if (maxDepth <= 0 || visited.has(startFile)) return;
  visited.add(startFile);

  const imports = dataDb.prepare(
    'SELECT target_file, imported_names FROM massu_imports WHERE source_file = ?'
  ).all(startFile) as { target_file: string; imported_names: string }[];

  for (const imp of imports) {
    const target = imp.target_file;

    // Classify the import
    if (target.includes('/components/')) {
      components.add(target);
    }
    if (target.includes('/hooks/') || target.match(/use[A-Z]/)) {
      hooks.add(target);
    }

    // Recurse into local imports (not node_modules)
    if (target.startsWith('src/')) {
      traceImports(target, dataDb, visited, components, hooks, maxDepth - 1);
    }
  }
}

/**
 * Find routers called by hooks/components via api.* patterns.
 */
function findRouterCalls(files: string[]): string[] {
  const routers = new Set<string>();
  const projectRoot = getProjectRoot();

  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    try {
      const source = readFileSync(absPath, 'utf-8');
      const apiCallRegex = /api\.(\w+)\.\w+/g;
      let match;
      while ((match = apiCallRegex.exec(source)) !== null) {
        routers.add(match[1]);
      }
    } catch {
      // Skip unreadable component files
    }
  }

  return [...routers];
}

/**
 * Find database tables touched by routers.
 */
function findTablesFromRouters(routerNames: string[], dataDb: Database.Database): string[] {
  const tables = new Set<string>();

  // Look up router files from the tRPC index
  for (const routerName of routerNames) {
    const procs = dataDb.prepare(
      'SELECT DISTINCT router_file FROM massu_trpc_procedures WHERE router_name = ?'
    ).all(routerName) as { router_file: string }[];

    for (const proc of procs) {
      const absPath = resolve(getProjectRoot(), proc.router_file);
      if (!existsSync(absPath)) continue;

      try {
        const source = readFileSync(absPath, 'utf-8');
        // Match database access patterns from config (default: ctx.db.{table})
        const dbPattern = getConfig().dbAccessPattern ?? 'ctx.db.{table}';
        const regexStr = dbPattern
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace('\\{table\\}', '(\\w+)');
        const tableRegex = new RegExp(regexStr + '\\.', 'g');
        let match;
        while ((match = tableRegex.exec(source)) !== null) {
          tables.add(match[1]);
        }
      } catch {
        // Skip unreadable source files
      }
    }
  }

  return [...tables];
}

/**
 * Build page dependency chains for all page.tsx files.
 */
export function buildPageDeps(dataDb: Database.Database, codegraphDb: Database.Database): number {
  // Clear existing data
  dataDb.exec('DELETE FROM massu_page_deps');

  // Find all page.tsx files from CodeGraph
  const pages = codegraphDb.prepare(
    "SELECT path FROM files WHERE path LIKE 'src/app/%/page.tsx' OR path = 'src/app/page.tsx'"
  ).all() as { path: string }[];

  const insertStmt = dataDb.prepare(
    'INSERT INTO massu_page_deps (page_file, route, portal, components, hooks, routers, tables_touched) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  let count = 0;

  const insertAll = dataDb.transaction(() => {
    for (const page of pages) {
      const route = deriveRoute(page.path);
      const portal = derivePortal(route);

      const visited = new Set<string>();
      const components = new Set<string>();
      const hooks = new Set<string>();

      traceImports(page.path, dataDb, visited, components, hooks);

      const allFiles = [...visited];
      const routers = findRouterCalls(allFiles);
      const tables = findTablesFromRouters(routers, dataDb);

      insertStmt.run(
        page.path,
        route,
        portal,
        JSON.stringify([...components]),
        JSON.stringify([...hooks]),
        JSON.stringify(routers),
        JSON.stringify(tables)
      );

      count++;
    }
  });

  insertAll();
  return count;
}

/**
 * Get the dependency chain for a specific page.
 */
export function getPageChain(dataDb: Database.Database, pageFile: string): PageChain | null {
  const row = dataDb.prepare('SELECT * FROM massu_page_deps WHERE page_file = ?').get(pageFile) as {
    page_file: string; route: string; portal: string;
    components: string; hooks: string; routers: string; tables_touched: string;
  } | undefined;

  if (!row) return null;

  return {
    page: row.page_file,
    route: row.route,
    portal: row.portal,
    components: JSON.parse(row.components),
    hooks: JSON.parse(row.hooks),
    routers: JSON.parse(row.routers),
    tables: JSON.parse(row.tables_touched),
  };
}

/**
 * Find all pages affected by a given file (reverse lookup).
 */
export function findAffectedPages(dataDb: Database.Database, file: string): PageChain[] {
  // Check if this file is directly a page
  const directPage = getPageChain(dataDb, file);
  if (directPage) return [directPage];

  // Find all pages that import this file (directly or transitively)
  // First, find who imports this file
  const importers = dataDb.prepare(
    'SELECT source_file FROM massu_imports WHERE target_file = ?'
  ).all(file) as { source_file: string }[];

  const affectedFiles = new Set<string>([file, ...importers.map(i => i.source_file)]);

  // Walk up the import tree to find pages
  let frontier = [...importers.map(i => i.source_file)];
  const visited = new Set(frontier);
  const maxDepth = 10;
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const f of frontier) {
      const upstreamImporters = dataDb.prepare(
        'SELECT source_file FROM massu_imports WHERE target_file = ?'
      ).all(f) as { source_file: string }[];

      for (const imp of upstreamImporters) {
        if (!visited.has(imp.source_file)) {
          visited.add(imp.source_file);
          affectedFiles.add(imp.source_file);
          next.push(imp.source_file);
        }
      }
    }
    frontier = next;
    depth++;
  }

  // Now find which pages are in the affected set
  const allPages = dataDb.prepare('SELECT * FROM massu_page_deps').all() as {
    page_file: string; route: string; portal: string;
    components: string; hooks: string; routers: string; tables_touched: string;
  }[];

  const results: PageChain[] = [];
  for (const row of allPages) {
    if (affectedFiles.has(row.page_file)) {
      results.push({
        page: row.page_file,
        route: row.route,
        portal: row.portal,
        components: JSON.parse(row.components),
        hooks: JSON.parse(row.hooks),
        routers: JSON.parse(row.routers),
        tables: JSON.parse(row.tables_touched),
      });
    }
  }

  return results;
}

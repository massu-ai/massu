// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { getConfig } from './config.ts';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Build the middleware import tree by tracing all transitive imports
 * from the middleware entry point. Any file in this tree is subject to
 * Edge Runtime restrictions (no Node.js deps).
 */
export function buildMiddlewareTree(dataDb: Database.Database): number {
  // Clear existing data
  dataDb.exec('DELETE FROM massu_middleware_tree');

  const config = getConfig();
  const middlewareFile = config.paths.middleware ?? 'src/middleware.ts';

  // Only build if the middleware file path is configured and exists conceptually
  if (!middlewareFile) return 0;

  // BFS through import edges starting from middleware.ts
  const visited = new Set<string>();
  const queue: string[] = [middlewareFile];
  visited.add(middlewareFile);

  while (queue.length > 0) {
    const current = queue.shift()!;

    const imports = dataDb.prepare(
      'SELECT target_file FROM massu_imports WHERE source_file = ?'
    ).all(current) as { target_file: string }[];

    for (const imp of imports) {
      if (!visited.has(imp.target_file) && imp.target_file.startsWith('src/')) {
        visited.add(imp.target_file);
        queue.push(imp.target_file);
      }
    }
  }

  // Store the tree
  const insertStmt = dataDb.prepare('INSERT INTO massu_middleware_tree (file) VALUES (?)');
  const insertAll = dataDb.transaction(() => {
    for (const file of visited) {
      insertStmt.run(file);
    }
  });
  insertAll();

  return visited.size;
}

/**
 * Check if a file is in the middleware import tree.
 */
export function isInMiddlewareTree(dataDb: Database.Database, file: string): boolean {
  const result = dataDb.prepare('SELECT 1 FROM massu_middleware_tree WHERE file = ?').get(file);
  return result !== undefined;
}

/**
 * Get all files in the middleware import tree.
 */
export function getMiddlewareTree(dataDb: Database.Database): string[] {
  const rows = dataDb.prepare('SELECT file FROM massu_middleware_tree ORDER BY file').all() as { file: string }[];
  return rows.map(r => r.file);
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { classifyPythonFileDomain } from './domain-enforcer.ts';

export interface PythonImpactReport {
  file: string;
  domain: string;
  importedBy: string[];
  routes: { method: string; path: string; functionName: string }[];
  models: { className: string; tableName: string | null }[];
  frontendCallers: string[];
  domainCrossings: { file: string; domain: string }[];
}

/**
 * Full impact analysis for a Python file.
 * Cross-references import graph, routes, models, and frontend coupling.
 */
export function analyzePythonImpact(dataDb: Database.Database, file: string): PythonImpactReport {
  const domain = classifyPythonFileDomain(file);

  // 1. Who imports this file (direct + transitive)
  const importedBy = collectTransitiveImporters(dataDb, file, 5);

  // 2. Routes defined in this file
  const routes = dataDb.prepare(
    'SELECT method, path, function_name FROM massu_py_routes WHERE file = ?'
  ).all(file) as { method: string; path: string; function_name: string }[];

  // 3. Models defined in this file
  const models = dataDb.prepare(
    'SELECT class_name, table_name FROM massu_py_models WHERE file = ?'
  ).all(file) as { class_name: string; table_name: string | null }[];

  // 4. Frontend callers (via routes in this file)
  const routeIds = dataDb.prepare('SELECT id FROM massu_py_routes WHERE file = ?').all(file) as { id: number }[];
  const frontendCallers: string[] = [];
  if (routeIds.length > 0) {
    const placeholders = routeIds.map(() => '?').join(',');
    const callers = dataDb.prepare(
      `SELECT DISTINCT frontend_file FROM massu_py_route_callers WHERE route_id IN (${placeholders})`
    ).all(...routeIds.map(r => r.id)) as { frontend_file: string }[];
    frontendCallers.push(...callers.map(c => c.frontend_file));
  }

  // 5. Domain crossings
  const imports = dataDb.prepare(
    'SELECT target_file FROM massu_py_imports WHERE source_file = ?'
  ).all(file) as { target_file: string }[];

  const domainCrossings = imports
    .map(imp => ({ file: imp.target_file, domain: classifyPythonFileDomain(imp.target_file) }))
    .filter(imp => imp.domain !== domain && imp.domain !== 'Unknown');

  return {
    file,
    domain,
    importedBy,
    routes: routes.map(r => ({ method: r.method, path: r.path, functionName: r.function_name })),
    models: models.map(m => ({ className: m.class_name, tableName: m.table_name })),
    frontendCallers,
    domainCrossings,
  };
}

function collectTransitiveImporters(dataDb: Database.Database, file: string, maxDepth: number): string[] {
  const visited = new Set<string>();
  const queue = [file];
  let depth = 0;

  const importerStmt = dataDb.prepare(
    'SELECT source_file FROM massu_py_imports WHERE target_file = ?'
  );

  while (queue.length > 0 && depth < maxDepth) {
    const batch = [...queue];
    queue.length = 0;
    for (const f of batch) {
      if (visited.has(f)) continue;
      visited.add(f);
      const importers = importerStmt.all(f) as { source_file: string }[];
      for (const imp of importers) {
        if (!visited.has(imp.source_file)) {
          queue.push(imp.source_file);
        }
      }
    }
    depth++;
  }

  visited.delete(file); // Don't include the file itself
  return [...visited];
}

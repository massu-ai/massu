// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import type Database from 'better-sqlite3';
import { parsePythonRoutes } from './route-parser.ts';
import { getProjectRoot } from '../config.ts';

function walkPyFiles(dir: string, excludeDirs: string[]): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue;
        files.push(...walkPyFiles(join(dir, entry.name), excludeDirs));
      } else if (entry.name.endsWith('.py')) {
        files.push(join(dir, entry.name));
      }
    }
  } catch { /* dir not readable, skip */ }
  return files;
}

export function buildPythonRouteIndex(dataDb: Database.Database, pythonRoot: string, excludeDirs: string[] = ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache']): number {
  const projectRoot = getProjectRoot();
  const absRoot = join(projectRoot, pythonRoot);
  dataDb.exec('DELETE FROM massu_py_routes');
  dataDb.exec('DELETE FROM massu_py_route_callers');

  const insertStmt = dataDb.prepare(
    'INSERT INTO massu_py_routes (file, method, path, function_name, dependencies, request_model, response_model, is_authenticated, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const files = walkPyFiles(absRoot, excludeDirs);
  let count = 0;

  dataDb.transaction(() => {
    for (const absFile of files) {
      const relFile = relative(projectRoot, absFile);
      let source: string;
      try { source = readFileSync(absFile, 'utf-8'); } catch { continue; }

      const routes = parsePythonRoutes(source);
      for (const route of routes) {
        insertStmt.run(
          relFile, route.method, route.path, route.functionName,
          JSON.stringify(route.dependencies), route.requestModel, route.responseModel,
          route.isAuthenticated ? 1 : 0, route.line
        );
        count++;
      }
    }
  })();

  return count;
}

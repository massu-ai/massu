// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import type Database from 'better-sqlite3';
import { getProjectRoot, getConfig } from '../config.ts';

interface CouplingMatch {
  frontendFile: string;
  line: number;
  callPattern: string;
  routeId: number;
}

/**
 * Scan frontend files for API calls matching Python routes.
 * Stores matches in massu_py_route_callers.
 */
export function buildPythonCouplingIndex(dataDb: Database.Database): number {
  const projectRoot = getProjectRoot();
  const config = getConfig();
  const srcDir = join(projectRoot, config.paths.source);

  // Get all routes from DB
  const routes = dataDb.prepare('SELECT id, method, path FROM massu_py_routes').all() as {
    id: number; method: string; path: string;
  }[];

  if (routes.length === 0) return 0;

  // Clear existing callers
  dataDb.exec('DELETE FROM massu_py_route_callers');

  // Walk frontend files (TS/TSX/JS/JSX)
  const frontendFiles = walkFrontendFiles(srcDir);

  const insertStmt = dataDb.prepare(
    'INSERT INTO massu_py_route_callers (route_id, frontend_file, line, call_pattern) VALUES (?, ?, ?, ?)'
  );

  let count = 0;

  // API call patterns to detect
  const apiPatterns = [
    /fetch\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,           // fetch('/api/...')
    /fetch\s*\(\s*[`'"]([^`'"]*\/api\/[^`'"]*)[`'"]/g,     // fetch('http.../api/...')
    /axios\.\w+\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,       // axios.get('/api/...')
    /\.get\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,             // client.get('/api/...')
    /\.post\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,            // client.post('/api/...')
    /\.put\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,             // client.put('/api/...')
    /\.delete\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,          // client.delete('/api/...')
    /\.patch\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g,           // client.patch('/api/...')
  ];

  dataDb.transaction(() => {
    for (const absFile of frontendFiles) {
      const relFile = relative(projectRoot, absFile);
      let source: string;
      try { source = readFileSync(absFile, 'utf-8'); } catch { continue; }

      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of apiPatterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(line)) !== null) {
            const urlPath = match[1];
            // Try to match against routes
            const matchedRoute = findMatchingRoute(urlPath, routes);
            if (matchedRoute) {
              insertStmt.run(matchedRoute.id, relFile, i + 1, match[0].slice(0, 200));
              count++;
            }
          }
        }
      }
    }
  })();

  return count;
}

function walkFrontendFiles(dir: string): string[] {
  const files: string[] = [];
  const exclude = ['node_modules', '.next', 'dist', '.git', '__pycache__', '.venv', 'venv'];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (exclude.includes(entry.name)) continue;
        files.push(...walkFrontendFiles(join(dir, entry.name)));
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  } catch { /* dir not readable, skip */ }
  return files;
}

/**
 * Match a URL path against route definitions.
 * Handles path parameters: /api/users/{id} matches /api/users/123
 */
/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingRoute(urlPath: string, routes: { id: number; method: string; path: string }[]): { id: number } | null {
  for (const route of routes) {
    // Escape regex-special chars in route path, then replace param placeholders
    const escaped = escapeRegex(route.path);
    const pattern = escaped.replace(/\\\{[^}]+\\\}/g, '[^/]+');
    const routeRegex = new RegExp('^' + pattern + '$');
    if (routeRegex.test(urlPath)) {
      return { id: route.id };
    }
  }
  return null;
}

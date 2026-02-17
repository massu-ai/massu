// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import type Database from 'better-sqlite3';
import { getConfig, getResolvedPaths, getProjectRoot } from './config.ts';

interface RouterMapping {
  key: string;       // e.g., "orders" (used as api.orders.*)
  variable: string;  // e.g., "ordersRouter"
  file: string;      // e.g., "src/server/api/routers/orders.ts"
}

interface ProcedureInfo {
  name: string;
  type: 'query' | 'mutation';
  isProtected: boolean;
}

/**
 * Parse src/server/api/root.ts to extract router key-to-file mapping.
 * The key is what UI code uses: api.[key].[procedure]
 */
export function parseRootRouter(): RouterMapping[] {
  const paths = getResolvedPaths();
  const rootPath = paths.rootRouterPath;
  if (!existsSync(rootPath)) {
    throw new Error(`Root router not found at ${rootPath}`);
  }

  const source = readFileSync(rootPath, 'utf-8');
  const mappings: RouterMapping[] = [];

  // Step 1: Parse imports to map variable names to file paths
  // import { ordersRouter } from './routers/orders'
  const importMap = new Map<string, string>();
  const importRegex = /import\s+\{[^}]*?(\w+Router)[^}]*\}\s+from\s+['"]\.\/routers\/([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const variable = match[1];
    let filePath = match[2];
    // Resolve to actual file path
    const fullPath = resolve(paths.routersDir, filePath);
    // Try with extensions
    for (const ext of ['.ts', '.tsx', '']) {
      const candidate = fullPath + ext;
      const routersRelPath = getConfig().paths.routers ?? 'src/server/api/routers';
      if (existsSync(candidate)) {
        filePath = routersRelPath + '/' + filePath + ext;
        break;
      }
      // Check if it's a directory with index
      const indexCandidate = join(fullPath, 'index.ts');
      if (existsSync(indexCandidate)) {
        filePath = routersRelPath + '/' + filePath + '/index.ts';
        break;
      }
    }
    importMap.set(variable, filePath);
  }

  // Step 2: Parse router registration - "orders: ordersRouter"
  const regRegex = /(\w+)\s*:\s*(\w+Router)/g;
  while ((match = regRegex.exec(source)) !== null) {
    const key = match[1];
    const variable = match[2];
    const file = importMap.get(variable);
    if (file) {
      mappings.push({ key, variable, file });
    }
  }

  return mappings;
}

/**
 * Extract procedure definitions from a router file.
 */
export function extractProcedures(routerFilePath: string): ProcedureInfo[] {
  const absPath = resolve(getProjectRoot(), routerFilePath);
  if (!existsSync(absPath)) return [];

  const source = readFileSync(absPath, 'utf-8');
  const procedures: ProcedureInfo[] = [];
  const seen = new Set<string>();

  // Pattern: procedureName: protectedProcedure or publicProcedure
  const procRegex = /(\w+)\s*:\s*(protected|public)Procedure/g;
  let match;
  while ((match = procRegex.exec(source)) !== null) {
    const name = match[1];
    const isProtected = match[2] === 'protected';
    if (seen.has(name)) continue;
    seen.add(name);

    // Determine if query or mutation by looking ahead
    const afterMatch = source.slice(match.index);
    const typeMatch = afterMatch.match(/\.(query|mutation)\s*\(/);
    const type = typeMatch ? (typeMatch[1] as 'query' | 'mutation') : 'query';

    procedures.push({ name, type, isProtected });
  }

  return procedures;
}

/**
 * Find UI call sites for a given router key and procedure name.
 */
export function findUICallSites(routerKey: string, procedureName: string): { file: string; line: number; pattern: string }[] {
  const callSites: { file: string; line: number; pattern: string }[] = [];
  const config = getConfig();
  const root = getProjectRoot();
  const src = config.paths.source;
  const searchDirs = [
    resolve(root, config.paths.pages ?? (src + '/app')),
    resolve(root, config.paths.components ?? (src + '/components')),
    resolve(root, config.paths.hooks ?? (src + '/hooks')),
  ];

  const searchPattern = `api.${routerKey}.${procedureName}`;

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    searchDirectory(dir, searchPattern, callSites);
  }

  return callSites;
}

function searchDirectory(dir: string, pattern: string, results: { file: string; line: number; pattern: string }[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      searchDirectory(fullPath, pattern, results);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      try {
        const source = readFileSync(fullPath, 'utf-8');
        const lines = source.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            const relPath = fullPath.slice(getProjectRoot().length + 1);
            // Extract the full call pattern (e.g., api.orders.create.useMutation())
            const lineContent = lines[i].trim();
            const callMatch = lineContent.match(new RegExp(`(api\\.${escapeRegex(pattern.slice(4))}\\.[\\w.()]+)`));
            results.push({
              file: relPath,
              line: i + 1,
              pattern: callMatch ? callMatch[1] : pattern,
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the full tRPC procedure index.
 * Stores results in massu_trpc_procedures and massu_trpc_call_sites tables.
 */
export function buildTrpcIndex(dataDb: Database.Database): { totalProcedures: number; withCallers: number; withoutCallers: number } {
  // Clear existing data
  dataDb.exec('DELETE FROM massu_trpc_call_sites');
  dataDb.exec('DELETE FROM massu_trpc_procedures');

  const routerMappings = parseRootRouter();

  const insertProc = dataDb.prepare(
    'INSERT INTO massu_trpc_procedures (router_file, router_name, procedure_name, procedure_type, has_ui_caller) VALUES (?, ?, ?, ?, ?)'
  );
  const insertCallSite = dataDb.prepare(
    'INSERT INTO massu_trpc_call_sites (procedure_id, file, line, call_pattern) VALUES (?, ?, ?, ?)'
  );

  let totalProcedures = 0;
  let withCallers = 0;
  let withoutCallers = 0;

  const insertAll = dataDb.transaction(() => {
    for (const router of routerMappings) {
      const procedures = extractProcedures(router.file);

      for (const proc of procedures) {
        const callSites = findUICallSites(router.key, proc.name);
        const hasUICaller = callSites.length > 0 ? 1 : 0;

        const result = insertProc.run(router.file, router.key, proc.name, proc.type, hasUICaller);
        const procId = result.lastInsertRowid;

        for (const site of callSites) {
          insertCallSite.run(procId, site.file, site.line, site.pattern);
        }

        totalProcedures++;
        if (hasUICaller) withCallers++;
        else withoutCallers++;
      }
    }
  });

  insertAll();

  return { totalProcedures, withCallers, withoutCallers };
}

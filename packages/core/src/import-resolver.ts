// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import type Database from 'better-sqlite3';
import { getResolvedPaths, getProjectRoot } from './config.ts';
import { ensureWithinRoot } from './security-utils.ts';

interface ImportEdge {
  source_file: string;
  target_file: string;
  import_type: 'named' | 'default' | 'namespace' | 'side_effect' | 'dynamic';
  imported_names: string; // JSON array
  line: number;
}

interface ParsedImport {
  type: 'named' | 'default' | 'namespace' | 'side_effect' | 'dynamic';
  names: string[];
  specifier: string;
  line: number;
}

/**
 * Parse import statements from TypeScript/JavaScript source code.
 */
export function parseImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;

    // Named imports: import { Foo, Bar } from 'module'
    const namedMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({ type: 'named', names, specifier: namedMatch[2], line: lineNum });
      continue;
    }

    // Default import: import Foo from 'module'
    const defaultMatch = line.match(/import\s+([A-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultMatch) {
      imports.push({ type: 'default', names: [defaultMatch[1]], specifier: defaultMatch[2], line: lineNum });
      continue;
    }

    // Default + named: import Foo, { Bar } from 'module'
    const mixedMatch = line.match(/import\s+([A-Z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (mixedMatch) {
      const names = [mixedMatch[1], ...mixedMatch[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)];
      imports.push({ type: 'named', names, specifier: mixedMatch[3], line: lineNum });
      continue;
    }

    // Namespace import: import * as Foo from 'module'
    const namespaceMatch = line.match(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (namespaceMatch) {
      imports.push({ type: 'namespace', names: [namespaceMatch[1]], specifier: namespaceMatch[2], line: lineNum });
      continue;
    }

    // Type imports: import type { Foo } from 'module'
    const typeMatch = line.match(/import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (typeMatch) {
      const names = typeMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({ type: 'named', names, specifier: typeMatch[2], line: lineNum });
      continue;
    }

    // Side effect import: import 'module'
    const sideEffectMatch = line.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch) {
      imports.push({ type: 'side_effect', names: [], specifier: sideEffectMatch[1], line: lineNum });
      continue;
    }

    // Dynamic import: await import('module') or import('module')
    const dynamicMatch = line.match(/(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynamicMatch) {
      imports.push({ type: 'dynamic', names: [], specifier: dynamicMatch[1], line: lineNum });
      continue;
    }
  }

  return imports;
}

/**
 * Resolve an import specifier to an absolute file path.
 * Returns null for external packages (bare imports).
 */
export function resolveImportPath(specifier: string, fromFile: string): string | null {
  // Skip external/bare imports (no . or @ prefix)
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
    return null;
  }

  let basePath: string;

  // Handle @/ alias -> src/
  if (specifier.startsWith('@/')) {
    const paths = getResolvedPaths();
    basePath = resolve(paths.pathAlias['@'] ?? paths.srcDir, specifier.slice(2));
  } else {
    // Relative path
    basePath = resolve(dirname(fromFile), specifier);
  }

  // Try exact path first
  if (existsSync(basePath) && !isDirectory(basePath)) {
    return toRelative(basePath);
  }

  // Try with extensions
  const resolvedPaths = getResolvedPaths();
  for (const ext of resolvedPaths.extensions) {
    const withExt = basePath + ext;
    if (existsSync(withExt)) {
      return toRelative(withExt);
    }
  }

  // Try index files (if path is a directory or could be)
  for (const indexFile of resolvedPaths.indexFiles) {
    const indexPath = join(basePath, indexFile);
    if (existsSync(indexPath)) {
      return toRelative(indexPath);
    }
  }

  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // Path doesn't exist or is inaccessible
    return false;
  }
}

function toRelative(absPath: string): string {
  const root = getProjectRoot();
  if (absPath.startsWith(root)) {
    return absPath.slice(root.length + 1);
  }
  return absPath;
}

/**
 * Build the full import graph for all files in CodeGraph.
 * Stores results in massu_imports table.
 */
export function buildImportIndex(dataDb: Database.Database, codegraphDb: Database.Database): number {
  // Get all files from CodeGraph
  const files = codegraphDb.prepare("SELECT path FROM files WHERE path LIKE 'src/%'").all() as { path: string }[];

  // Clear existing import edges
  dataDb.exec('DELETE FROM massu_imports');

  const insertStmt = dataDb.prepare(
    'INSERT INTO massu_imports (source_file, target_file, import_type, imported_names, line) VALUES (?, ?, ?, ?, ?)'
  );

  let edgeCount = 0;
  const projectRoot = getProjectRoot();

  const insertMany = dataDb.transaction((edges: ImportEdge[]) => {
    for (const edge of edges) {
      insertStmt.run(edge.source_file, edge.target_file, edge.import_type, edge.imported_names, edge.line);
    }
  });

  const batchSize = 500;
  let batch: ImportEdge[] = [];

  for (const file of files) {
    const absPath = ensureWithinRoot(resolve(projectRoot, file.path), projectRoot);
    if (!existsSync(absPath)) continue;

    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      // Skip unreadable source files
      continue;
    }

    const imports = parseImports(source);

    for (const imp of imports) {
      const targetPath = resolveImportPath(imp.specifier, absPath);
      if (!targetPath) continue; // Skip external packages

      batch.push({
        source_file: file.path,
        target_file: targetPath,
        import_type: imp.type,
        imported_names: JSON.stringify(imp.names),
        line: imp.line,
      });

      edgeCount++;

      if (batch.length >= batchSize) {
        insertMany(batch);
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    insertMany(batch);
  }

  return edgeCount;
}

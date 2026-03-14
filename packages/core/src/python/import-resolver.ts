// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join, relative, dirname } from 'path';
import type Database from 'better-sqlite3';
import { parsePythonImports } from './import-parser.ts';
import { getProjectRoot } from '../config.ts';

/**
 * Resolve a Python module path to a file path.
 * Checks both module.py and module/__init__.py.
 * Returns path relative to project root, or null for external modules.
 */
export function resolvePythonModulePath(module: string, fromFile: string, pythonRoot: string, level: number): string | null {
  const projectRoot = getProjectRoot();

  if (level > 0) {
    // Relative import - resolve from current file's directory
    let baseDir = dirname(resolve(projectRoot, fromFile));
    for (let i = 1; i < level; i++) {
      baseDir = dirname(baseDir);
    }
    // Strip the dots prefix to get the actual module part
    const modulePart = module.replace(/^\.+/, '');
    if (modulePart) {
      const parts = modulePart.split('.');
      return tryResolvePythonPath(join(baseDir, ...parts), projectRoot);
    }
    // `from . import x` - the module is the current package
    return tryResolvePythonPath(baseDir, projectRoot);
  }

  // Absolute import
  const parts = module.split('.');
  const candidate = join(resolve(projectRoot, pythonRoot), ...parts);
  return tryResolvePythonPath(candidate, projectRoot);
}

function tryResolvePythonPath(basePath: string, projectRoot: string): string | null {
  // Try as file: module.py
  if (existsSync(basePath + '.py')) {
    return relative(projectRoot, basePath + '.py');
  }
  // Try as package: module/__init__.py
  if (existsSync(join(basePath, '__init__.py'))) {
    return relative(projectRoot, join(basePath, '__init__.py'));
  }
  // Try exact path (already has .py)
  if (basePath.endsWith('.py') && existsSync(basePath)) {
    return relative(projectRoot, basePath);
  }
  return null;
}

/**
 * Walk directory recursively, collecting .py files.
 * Skips excluded directories.
 */
function walkPythonFiles(dir: string, excludeDirs: string[]): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue;
        files.push(...walkPythonFiles(join(dir, entry.name), excludeDirs));
      } else if (entry.name.endsWith('.py')) {
        files.push(join(dir, entry.name));
      }
    }
  } catch { /* directory may not exist */ }
  return files;
}

/**
 * Build the Python import graph for all .py files under pythonRoot.
 * Stores results in massu_py_imports table.
 */
export function buildPythonImportIndex(dataDb: Database.Database, pythonRoot: string, excludeDirs: string[] = ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache']): number {
  const projectRoot = getProjectRoot();
  const absRoot = resolve(projectRoot, pythonRoot);

  // Clear existing Python import edges
  dataDb.exec('DELETE FROM massu_py_imports');

  const insertStmt = dataDb.prepare(
    'INSERT INTO massu_py_imports (source_file, target_file, import_type, imported_names, line) VALUES (?, ?, ?, ?, ?)'
  );

  const files = walkPythonFiles(absRoot, excludeDirs);
  let edgeCount = 0;

  const insertMany = dataDb.transaction((edges: { source: string; target: string; type: string; names: string; line: number }[]) => {
    for (const edge of edges) {
      insertStmt.run(edge.source, edge.target, edge.type, edge.names, edge.line);
    }
  });

  const batch: { source: string; target: string; type: string; names: string; line: number }[] = [];

  for (const absFile of files) {
    const relFile = relative(projectRoot, absFile);
    let source: string;
    try {
      source = readFileSync(absFile, 'utf-8');
    } catch { continue; }

    const imports = parsePythonImports(source);

    for (const imp of imports) {
      const targetPath = resolvePythonModulePath(imp.module, relFile, pythonRoot, imp.level);
      if (!targetPath) continue; // Skip external/stdlib

      batch.push({
        source: relFile,
        target: targetPath,
        type: imp.type,
        names: JSON.stringify(imp.names),
        line: imp.line,
      });
      edgeCount++;

      if (batch.length >= 500) {
        insertMany(batch.splice(0));
      }
    }
  }

  if (batch.length > 0) {
    insertMany(batch);
  }

  return edgeCount;
}

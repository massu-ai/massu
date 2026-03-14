// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import type Database from 'better-sqlite3';
import { parseAlembicMigration } from './migration-parser.ts';
import { getProjectRoot } from '../config.ts';

export function buildPythonMigrationIndex(dataDb: Database.Database, alembicDir: string): number {
  const projectRoot = getProjectRoot();
  const absDir = join(projectRoot, alembicDir);
  dataDb.exec('DELETE FROM massu_py_migrations');

  // Look for version files in versions/ subdirectory
  const versionsDir = join(absDir, 'versions');
  let files: string[] = [];
  try {
    files = readdirSync(versionsDir)
      .filter(f => f.endsWith('.py'))
      .map(f => join(versionsDir, f));
  } catch { /* versions/ subdir not found, try parent */
    try {
      files = readdirSync(absDir)
        .filter(f => f.endsWith('.py') && f !== 'env.py')
        .map(f => join(absDir, f));
    } catch { /* alembic dir not readable, skip */ }
  }

  const insertStmt = dataDb.prepare(
    'INSERT INTO massu_py_migrations (revision, down_revision, file, description, operations, is_head) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let count = 0;
  const allRevisions: Set<string> = new Set();
  const hasDownRef: Set<string> = new Set();

  // First pass: parse all migrations
  interface MigRow { revision: string; downRevision: string | null; file: string; description: string | null; operations: string }
  const rows: MigRow[] = [];

  for (const absFile of files) {
    let source: string;
    try { source = readFileSync(absFile, 'utf-8'); } catch { continue; }

    const parsed = parseAlembicMigration(source);
    if (!parsed.revision) continue;

    allRevisions.add(parsed.revision);
    if (parsed.downRevision) hasDownRef.add(parsed.downRevision);

    rows.push({
      revision: parsed.revision,
      downRevision: parsed.downRevision,
      file: relative(projectRoot, absFile),
      description: parsed.description,
      operations: JSON.stringify(parsed.operations),
    });
  }

  // Determine heads (revisions not referenced as down_revision by anyone)
  dataDb.transaction(() => {
    for (const row of rows) {
      const isHead = !hasDownRef.has(row.revision) ? 1 : 0;
      insertStmt.run(row.revision, row.downRevision, row.file, row.description, row.operations, isHead);
      count++;
    }
  })();

  return count;
}

/**
 * Detect drift between SQLAlchemy models and migration state.
 */
export interface DriftReport {
  unmigratedModels: { className: string; tableName: string }[];
  missingColumns: { model: string; column: string }[];
  extraMigrations: string[];
}

export function detectMigrationDrift(dataDb: Database.Database): DriftReport {
  const models = dataDb.prepare('SELECT class_name, table_name, columns FROM massu_py_models WHERE table_name IS NOT NULL').all() as {
    class_name: string; table_name: string; columns: string;
  }[];

  const migrations = dataDb.prepare('SELECT operations FROM massu_py_migrations').all() as { operations: string }[];

  // Collect all tables and columns mentioned in migrations
  const migratedTables = new Set<string>();
  const migratedColumns = new Map<string, Set<string>>();

  for (const mig of migrations) {
    let ops: { table?: string; column?: string }[];
    try { ops = JSON.parse(mig.operations); } catch { ops = []; }
    for (const op of ops) {
      if (op.table) {
        migratedTables.add(op.table);
        if (!migratedColumns.has(op.table)) migratedColumns.set(op.table, new Set());
        if (op.column) migratedColumns.get(op.table)!.add(op.column);
      }
    }
  }

  const unmigratedModels: DriftReport['unmigratedModels'] = [];
  const missingColumns: DriftReport['missingColumns'] = [];

  for (const model of models) {
    if (!migratedTables.has(model.table_name)) {
      unmigratedModels.push({ className: model.class_name, tableName: model.table_name });
    }
  }

  return { unmigratedModels, missingColumns, extraMigrations: [] };
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import type Database from 'better-sqlite3';
import { parsePythonModels } from './model-parser.ts';
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

export function buildPythonModelIndex(dataDb: Database.Database, pythonRoot: string, excludeDirs: string[] = ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache']): number {
  const projectRoot = getProjectRoot();
  const absRoot = join(projectRoot, pythonRoot);
  dataDb.exec('DELETE FROM massu_py_models');
  dataDb.exec('DELETE FROM massu_py_fk_edges');

  const insertModel = dataDb.prepare(
    'INSERT INTO massu_py_models (class_name, table_name, file, line, columns, relationships, foreign_keys) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertFk = dataDb.prepare(
    'INSERT INTO massu_py_fk_edges (source_table, source_column, target_table, target_column) VALUES (?, ?, ?, ?)'
  );

  const files = walkPyFiles(absRoot, excludeDirs);
  let count = 0;

  dataDb.transaction(() => {
    for (const absFile of files) {
      const relFile = relative(projectRoot, absFile);
      let source: string;
      try { source = readFileSync(absFile, 'utf-8'); } catch { continue; }

      const models = parsePythonModels(source);
      for (const model of models) {
        insertModel.run(
          model.className, model.tableName, relFile, model.line,
          JSON.stringify(model.columns), JSON.stringify(model.relationships), JSON.stringify(model.foreignKeys)
        );
        count++;

        // Build FK edges
        if (model.tableName) {
          for (const fk of model.foreignKeys) {
            const [targetTable, targetColumn] = fk.target.split('.');
            if (targetTable && targetColumn) {
              insertFk.run(model.tableName, fk.column, targetTable, targetColumn);
            }
          }
        }
      }
    }
  })();

  return count;
}

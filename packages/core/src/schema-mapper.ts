// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { getConfig, getResolvedPaths, getProjectRoot } from './config.ts';

export interface SchemaModel {
  name: string;
  tableName: string;
  fields: SchemaField[];
}

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  isRelation: boolean;
}

export interface ColumnUsage {
  file: string;
  line: number;
  usage: string;
}

export interface SchemaMismatch {
  table: string;
  codeColumn: string;
  actualColumns: string[];
  files: string[];
  severity: 'CRITICAL' | 'HIGH';
}

/**
 * Parse the Prisma schema file and extract all models with their fields.
 */
export function parsePrismaSchema(): SchemaModel[] {
  const schemaPath = getResolvedPaths().prismaSchemaPath;
  if (!existsSync(schemaPath)) {
    throw new Error(`Prisma schema not found at ${schemaPath}`);
  }

  const source = readFileSync(schemaPath, 'utf-8');
  const models: SchemaModel[] = [];
  const sourceLines = source.split('\n');

  // Parse models by tracking brace depth instead of regex
  let i = 0;
  while (i < sourceLines.length) {
    const line = sourceLines[i].trim();
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);

    if (modelMatch) {
      const modelName = modelMatch[1];
      const fields: SchemaField[] = [];
      let braceDepth = 1;
      i++;

      const bodyLines: string[] = [];
      while (i < sourceLines.length && braceDepth > 0) {
        const bodyLine = sourceLines[i];
        for (const ch of bodyLine) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }
        if (braceDepth > 0) {
          bodyLines.push(bodyLine);
        }
        i++;
      }

      for (const bodyLine of bodyLines) {
        const trimmed = bodyLine.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

        // Parse field: fieldName Type? @annotations
        // Must handle large whitespace padding in the schema
        const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?)?(\[\])?\s*(.*)?$/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const fieldType = fieldMatch[2];
          const nullable = !!fieldMatch[3];
          const annotations = fieldMatch[5] || '';

          // Skip @relation fields (they're virtual)
          const isRelation = annotations.includes('@relation') || fieldType[0] === fieldType[0].toUpperCase() && !['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Decimal', 'BigInt', 'Bytes'].includes(fieldType);

          fields.push({
            name: fieldName,
            type: fieldType + (fieldMatch[4] || '') + (nullable ? '?' : ''),
            nullable,
            isRelation,
          });
        }
      }

      // Derive table name from @@map or use model name directly (Prisma convention)
      const body = bodyLines.join('\n');
      const mapMatch = body.match(/@@map\("([^"]+)"\)/);
      const tableName = mapMatch ? mapMatch[1] : toSnakeCase(modelName);

      models.push({ name: modelName, tableName, fields });
    } else {
      i++;
    }
  }

  return models;
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Find all references to a table's columns in router files.
 */
export function findColumnUsageInRouters(tableName: string): Map<string, ColumnUsage[]> {
  const usage = new Map<string, ColumnUsage[]>();
  const routersDir = getResolvedPaths().routersDir;

  if (!existsSync(routersDir)) return usage;

  scanDirectory(routersDir, tableName, usage);
  return usage;
}

function scanDirectory(dir: string, tableName: string, usage: Map<string, ColumnUsage[]>): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, tableName, usage);
    } else if (entry.name.endsWith('.ts')) {
      scanFile(fullPath, tableName, usage);
    }
  }
}

function scanFile(absPath: string, tableName: string, usage: Map<string, ColumnUsage[]>): void {
  try {
    const source = readFileSync(absPath, 'utf-8');

    // Check if this file references the table
    if (!source.includes(tableName)) return;

    const relPath = absPath.slice(getProjectRoot().length + 1);
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for property access patterns: tableName.columnName or { columnName: ... } near table references
      // Pattern 1: where: { columnName: value }
      const whereMatch = line.match(/(\w+)\s*:\s*(?:\{|[^,}]+)/g);
      if (whereMatch) {
        for (const m of whereMatch) {
          const colName = m.split(':')[0].trim();
          if (colName && !['where', 'data', 'select', 'orderBy', 'include', 'const', 'let', 'return', 'if', 'else', 'async', 'await'].includes(colName)) {
            if (!usage.has(colName)) usage.set(colName, []);
            usage.get(colName)!.push({ file: relPath, line: i + 1, usage: line.trim() });
          }
        }
      }
    }
  } catch {
    // Skip unreadable
  }
}

/**
 * Detect column name mismatches between code and schema.
 */
export function detectMismatches(models: SchemaModel[]): SchemaMismatch[] {
  const mismatches: SchemaMismatch[] = [];

  const knownMismatches = getConfig().knownMismatches ?? {};

  for (const [tableName, wrongColumns] of Object.entries(knownMismatches)) {
    const model = models.find(m => m.tableName === tableName);
    if (!model) continue;

    const actualColumnNames = model.fields.map(f => f.name);

    for (const [wrongCol, correctCol] of Object.entries(wrongColumns)) {
      // Search for the wrong column name in code
      const routersDir = getResolvedPaths().routersDir;
      const files = findFilesUsingColumn(routersDir, wrongCol, tableName);

      if (files.length > 0) {
        mismatches.push({
          table: tableName,
          codeColumn: wrongCol,
          actualColumns: actualColumnNames,
          files,
          severity: 'CRITICAL',
        });
      }
    }
  }

  return mismatches;
}

function findFilesUsingColumn(dir: string, column: string, tableName: string): string[] {
  const result: string[] = [];
  if (!existsSync(dir)) return result;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findFilesUsingColumn(fullPath, column, tableName));
    } else if (entry.name.endsWith('.ts')) {
      try {
        const source = readFileSync(fullPath, 'utf-8');
        // Only flag if both the table name and wrong column are in the file
        if (source.includes(tableName) && source.includes(column)) {
          result.push(fullPath.slice(getProjectRoot().length + 1));
        }
      } catch {
        // Skip
      }
    }
  }

  return result;
}

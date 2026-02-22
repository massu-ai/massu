// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Memory database connection factory.
 *
 * Split into three files (P3-001 remediation):
 * - memory-db.ts     -- Connection factory (this file)
 * - memory-schema.ts -- Schema DDL (initMemorySchema)
 * - memory-queries.ts -- All CRUD query functions
 */

import Database from 'better-sqlite3';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getResolvedPaths } from './config.ts';
import { initMemorySchema } from './memory-schema.ts';

// Re-export all query functions and types so existing importers continue to work.
// New code should import directly from './memory-queries.ts'.
export * from './memory-queries.ts';

// ============================================================
// Memory Database Connection Factory
// ============================================================

/** Tracks which database paths have already been initialized to avoid redundant DDL. */
const initializedPaths = new Set<string>();

/**
 * Connection to the memory SQLite database.
 * Stores session memory, observations, and observability data.
 */
export function getMemoryDb(): Database.Database {
  const dbPath = getResolvedPaths().memoryDbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (!initializedPaths.has(dbPath)) {
    initMemorySchema(db);
    initializedPaths.add(dbPath);
  }
  return db;
}

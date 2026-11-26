// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE ONE fixture for "a memory.db as an older massu left it" (plan 2026-07-23 P8-007/008):
 * auto_vacuum=0, many free pages, and session_summaries written one row per turn, including
 * the two loss shapes measured on a real store on 2026-11-25 — an older row holding a
 * `complete` and a `next_steps` the newest row lacks, and two rows in the same second.
 *
 * The calling test file must mock `../config.ts` so getResolvedPaths().memoryDbPath follows
 * `setMemoryDbPath` (vitest applies a file's vi.mock to this helper's imports too).
 */

import { mkdtempSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMemoryDb, createSession } from '../../memory-db.ts';

export const LEGACY_SEED_ROWS_KEPT = 1000;

export function legacyMemoryStore(roots: string[], setMemoryDbPath: (p: string) => void): string {
  const d = mkdtempSync(join(tmpdir(), 'massu-legacy-store-'));
  roots.push(d);
  const path = join(d, 'memory.db');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA auto_vacuum = 0; CREATE TABLE legacy_seed (x TEXT);');
  raw.close();
  setMemoryDbPath(path);
  const db = getMemoryDb(); // an EXISTING file: the schema is applied, the mode stays 0
  try {
    createSession(db, 's1');
    createSession(db, 's2');
    const ins = db.prepare(
      `INSERT INTO session_summaries (session_id, request, next_steps, plan_progress, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, 'x', ?)`,
    );
    ins.run('s1', 'first', 'keep these next steps', JSON.stringify({ A: 'complete' }), 100);
    ins.run('s1', 'second', null, JSON.stringify({ A: 'in_progress', B: 'in_progress' }), 200);
    ins.run('s1', 'third', '', JSON.stringify({ snapshot_type: 'pre_compact', B: 'in_progress' }), 200); // same second
    ins.run('s2', 'only', 'n2', '{}', 150);
    db.exec(
      "INSERT INTO legacy_seed SELECT hex(randomblob(1500)) FROM (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<3000) SELECT i FROM c)",
    );
    db.exec('DELETE FROM legacy_seed WHERE rowid % 3 != 0'); // leaves LEGACY_SEED_ROWS_KEPT
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return path;
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-002 (plan-living-memory-slice-1) — garbage-collect orphaned
 * `[memory-file] <name>` observations when the backing memory/*.md file
 * is deleted. Present files must be untouched; fail-open on error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMemorySchema, createSession } from '../memory-db.ts';
import {
  ingestMemoryFile,
  reconcileMemoryFileObservations,
} from '../memory-file-ingest.ts';

/** Rows that still REACH recall. Slice 4 retires by EXPIRY, so a retired row is
 *  still present (recoverable, `asOf`-queryable) but no longer live. */
function countLiveMemoryFileObs(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM observations
          WHERE title LIKE '[memory-file] %' AND expired_at IS NULL`,
      )
      .get() as { n: number }
  ).n;
}

/** Rows PRESENT at all — live or expired. Slice 4 destroys nothing, so this
 *  never goes down. */
function countMemoryFileObs(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT COUNT(*) as n FROM observations WHERE title LIKE '[memory-file] %'`)
      .get() as { n: number }
  ).n;
}

describe('P4-002: reconcileMemoryFileObservations', () => {
  let db: Database.Database;
  let memDir: string;
  const sid = 'reconcile-test-session';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initMemorySchema(db);
    createSession(db, sid);
    memDir = mkdtempSync(join(tmpdir(), 'massu-memrec-'));
  });

  afterEach(() => {
    db?.close();
    try {
      rmSync(memDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('deletes the observation for a deleted memory file, keeps present ones', () => {
    const keepPath = join(memDir, 'keep.md');
    const gonePath = join(memDir, 'gone.md');
    writeFileSync(keepPath, '---\ntype: discovery\n---\nkeep body\n');
    writeFileSync(gonePath, '---\ntype: discovery\n---\ngone body\n');

    ingestMemoryFile(db, sid, keepPath);
    ingestMemoryFile(db, sid, gonePath);
    expect(countMemoryFileObs(db)).toBe(2);

    // Delete the backing file, then reconcile.
    rmSync(gonePath);
    const retired = reconcileMemoryFileObservations(db, memDir);
    expect(retired).toBe(1);
    expect(countLiveMemoryFileObs(db), 'the orphan no longer reaches recall').toBe(1);
    expect(countMemoryFileObs(db), 'but nothing was DESTROYED (A-11: expire, never delete)').toBe(2);

    const remaining = db
      .prepare(
        `SELECT title FROM observations WHERE title LIKE '[memory-file] %' AND expired_at IS NULL`,
      )
      .get() as { title: string };
    expect(remaining.title).toBe('[memory-file] keep');
  });

  it('respects a custom frontmatter name (does not GC a live file with a custom name)', () => {
    const p = join(memDir, 'file-basename.md');
    writeFileSync(p, '---\nname: custom-name\ntype: discovery\n---\nbody\n');
    ingestMemoryFile(db, sid, p);
    expect(countMemoryFileObs(db)).toBe(1);

    // The observation title uses the frontmatter name, and the file still
    // exists, so reconcile must NOT delete it.
    const deleted = reconcileMemoryFileObservations(db, memDir);
    expect(deleted).toBe(0);
    expect(countMemoryFileObs(db)).toBe(1);
  });

  it('EXPIRES (never deletes) memory-file observations when the directory is empty but readable', () => {
    const p = join(memDir, 'temp.md');
    writeFileSync(p, '---\ntype: discovery\n---\nbody\n');
    ingestMemoryFile(db, sid, p);
    rmSync(p);

    const retired = reconcileMemoryFileObservations(db, memDir);
    expect(retired).toBe(1);
    expect(countLiveMemoryFileObs(db), 'retired from recall').toBe(0);
    expect(countMemoryFileObs(db), 'but still recoverable — A-11 expires, never deletes').toBe(1);
  });

  it('A-01: a NONEXISTENT memory dir changes NOTHING (it used to wipe the whole projection)', () => {
    // THIS TEST PREVIOUSLY ASSERTED THE BUG. It was named "returns 0 and does not
    // throw" while asserting `expect(deleted).toBe(1)` — i.e. it codified the
    // unbounded wipe (D3) as intended behavior, and its own title contradicted
    // what it checked. A missing directory is the normal state of a fresh clone,
    // an unsynced machine, or a cwd-derived path mismatch; it is NOT evidence
    // that the human deleted their memories.
    const p = join(memDir, 'temp.md');
    writeFileSync(p, '---\ntype: discovery\n---\nbody\n');
    ingestMemoryFile(db, sid, p);

    const retired = reconcileMemoryFileObservations(db, join(memDir, 'nonexistent-subdir'));

    expect(retired, 'a missing directory must be a NO-OP').toBe(0);
    expect(countLiveMemoryFileObs(db), 'the memory must survive untouched').toBe(1);
  });

  it('is idempotent (second run deletes nothing new)', () => {
    const p = join(memDir, 'x.md');
    writeFileSync(p, '---\ntype: discovery\n---\nbody\n');
    ingestMemoryFile(db, sid, p);
    rmSync(p);

    expect(reconcileMemoryFileObservations(db, memDir)).toBe(1);
    expect(reconcileMemoryFileObservations(db, memDir)).toBe(0);
  });
});

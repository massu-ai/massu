// A-01 (D3) + A-11 (P5-001): the reconcile path can no longer destroy memory.
//
// TWO defects locked out here:
//
// D3 — the unbounded wipe. `reconcileMemoryFileObservations` treated "no live
// files" as "every memory was deleted" and ran an UNQUALIFIED
// `DELETE FROM observations WHERE title LIKE '[memory-file] %'`. But an absent or
// unreadable memory dir is not evidence of deletion: it is the normal state of a
// fresh clone, an unsynced machine, a CI container, or a locked-down $HOME — and
// the dir path is derived from cwd, so a path mismatch produced it too. This runs
// at EVERY session start (hooks/session-start.ts:81-82). One missing directory
// retired the entire projected corpus.
//
// P5-001 — it was a hard DELETE. Now it is an EXPIRE: reversible, still
// `asOf`-queryable, and self-healing via resurrect-on-contact. These were the last
// two hard deletes in the codebase; their removal empties the no-hard-delete
// ALLOWLIST (A-12).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs';

import { initMemorySchema, createSession, MEMORY_FILE_TITLE_PREFIX } from '../memory-db.ts';
import {
  ingestMemoryFile,
  reconcileMemoryFileObservations,
} from '../memory-file-ingest.ts';

function memFile(dir: string, name: string): string {
  const p = join(dir, `${name}.md`);
  writeFileSync(
    p,
    `---\nname: ${name}\ndescription: d\nmetadata:\n  type: feedback\n---\n\nBody of ${name}.\n`,
    'utf-8',
  );
  return p;
}

function liveCount(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM observations WHERE title LIKE ? AND expired_at IS NULL`,
      )
      .get(`${MEMORY_FILE_TITLE_PREFIX}%`) as { n: number }
  ).n;
}

function totalCount(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM observations WHERE title LIKE ?`)
      .get(`${MEMORY_FILE_TITLE_PREFIX}%`) as { n: number }
  ).n;
}

describe('memory-file reconcile safety (A-01, A-11)', () => {
  let db: Database.Database;
  let root: string;
  let memDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-reconcile-'));
    memDir = join(root, 'memory');
    mkdirSync(memDir);
    db = new Database(join(root, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
    for (const n of ['a_law', 'b_law', 'c_law']) {
      ingestMemoryFile(db, 'S1', memFile(memDir, n));
    }
    expect(liveCount(db), 'precondition: 3 projected rows').toBe(3);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { chmodSync(memDir, 0o755); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('an ABSENT memory dir changes NOTHING (this is the wipe that used to happen)', () => {
    rmSync(memDir, { recursive: true, force: true });

    const changed = reconcileMemoryFileObservations(db, memDir);

    expect(changed, 'a missing directory must be a no-op, not a mass retirement').toBe(0);
    expect(liveCount(db), 'all 3 memories must survive a missing directory').toBe(3);
  });

  it('an UNREADABLE memory dir changes NOTHING', () => {
    chmodSync(memDir, 0o000);
    let changed: number;
    try {
      changed = reconcileMemoryFileObservations(db, memDir);
    } finally {
      chmodSync(memDir, 0o755);
    }
    // If the platform/user can still read it (e.g. running as root), the dir is
    // readable and all 3 files are live => 0 changes either way. The invariant
    // asserted is the same: nothing is retired.
    expect(changed, 'an unreadable directory is unknowable — no-op').toBe(0);
    expect(liveCount(db), 'all 3 memories must survive an unreadable directory').toBe(3);
  });

  it('a file genuinely deleted is EXPIRED, not DELETED — the row survives and is recoverable', () => {
    rmSync(join(memDir, 'b_law.md'));

    const changed = reconcileMemoryFileObservations(db, memDir);

    expect(changed, 'exactly the one orphan is retired').toBe(1);
    expect(liveCount(db), 'the other two stay live').toBe(2);
    expect(totalCount(db), 'NOTHING is destroyed — the row is still there, expired').toBe(3);

    const row = db
      .prepare(`SELECT expired_at FROM observations WHERE title = ?`)
      .get(`${MEMORY_FILE_TITLE_PREFIX}b_law`) as { expired_at: string | null };
    expect(row.expired_at, 'the orphan is expired').not.toBeNull();
  });

  it('an emptied-but-readable dir expires (reversibly) rather than deleting', () => {
    for (const n of ['a_law', 'b_law', 'c_law']) rmSync(join(memDir, `${n}.md`));

    const changed = reconcileMemoryFileObservations(db, memDir);

    expect(changed).toBe(3);
    expect(liveCount(db), 'all retired...').toBe(0);
    expect(totalCount(db), '...but NONE destroyed — every row is still recoverable').toBe(3);
  });

  it('RESURRECT-ON-CONTACT: restoring the file brings the memory back', () => {
    rmSync(join(memDir, 'b_law.md'));
    reconcileMemoryFileObservations(db, memDir);
    expect(liveCount(db)).toBe(2);

    // The human restores it (git checkout, undo, re-sync).
    ingestMemoryFile(db, 'S1', memFile(memDir, 'b_law'));

    expect(liveCount(db), 'the file is back, so the memory is back').toBe(3);
    expect(totalCount(db), 'and no duplicate row was created').toBe(3);
  });

  it('reconcile is idempotent — running it twice retires nothing extra', () => {
    rmSync(join(memDir, 'b_law.md'));
    expect(reconcileMemoryFileObservations(db, memDir)).toBe(1);
    expect(
      reconcileMemoryFileObservations(db, memDir),
      'an already-expired row must not be re-expired',
    ).toBe(0);
  });
});

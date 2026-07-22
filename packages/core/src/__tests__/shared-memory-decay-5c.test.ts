// Slice 5 — C-05: an accepted cross-repo memory decays NORMALLY. It is NOT granted
// Slice 4's file-backed decay exemption — the exemption is the human's FILE on disk
// (Slice 4 Law 2), and a cross-repo memory has none. Non-vacuous: a genuinely
// file-backed row IS exempt in the same run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  initMemorySchema,
  createSession,
  setMemoryMeta,
  expireOldLowValueObservations,
  USAGE_COUNTER_ARMED_KEY,
  MEMORY_FILE_TITLE_PREFIX,
} from '../memory-db.ts';

const NOW = 1_752_000_000;
const OLD = NOW - 200 * 86400; // 200 days old — well past retention

function open(): Database.Database {
  const db = new Database(':memory:');
  initMemorySchema(db);
  createSession(db, 'S1');
  // Arm the usage counter well in the past so warmup has elapsed.
  setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(NOW - 100 * 86400));
  return db;
}

function insertObs(db: Database.Database, title: string, origin: string, evidence: string | null): number {
  const r = db
    .prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, origin, evidence, created_at, created_at_epoch, valid_from_epoch, ingested_at_epoch)
       VALUES ('S1','discovery',?,?,1,?,?, '2026-01-01T00:00:00Z', ?, ?, ?)`,
    )
    .run(title, 'body', origin, evidence, OLD, OLD, OLD);
  return Number(r.lastInsertRowid);
}

describe('Slice 5 C-05 — accepted cross-repo rows decay normally', () => {
  let db: Database.Database;
  beforeEach(() => (db = open()));
  afterEach(() => db.close());

  const opts = { retentionDays: 90, importanceFloor: 1, protectedTypes: [] as string[], usageWarmupDays: 0, nowEpochSec: NOW };

  it('an old, low-value accepted cross-repo row IS expired (no file-backed exemption)', () => {
    const crossId = insertObs(
      db,
      'never echo for env vars',
      'repo:11111111-1111-1111-1111-111111111111',
      JSON.stringify({ cross_repo: true, origin_repo_label: 'peer', accepted_at_epoch: OLD, record_hash: 'h' }),
    );
    // it does not wear the file-backed title prefix — so the exemption cannot apply
    const title = (db.prepare(`SELECT title FROM observations WHERE id=?`).get(crossId) as { title: string }).title;
    expect(title.startsWith(MEMORY_FILE_TITLE_PREFIX)).toBe(false);

    expireOldLowValueObservations(db, opts);

    const expired = db.prepare(`SELECT expired_at_epoch FROM observations WHERE id=?`).get(crossId) as { expired_at_epoch: number | null };
    expect(expired.expired_at_epoch).not.toBeNull(); // decayed like any local row
  });

  it('(control) a genuinely file-backed row is EXEMPT in the same run', () => {
    const fileId = insertObs(db, `${MEMORY_FILE_TITLE_PREFIX}my-note`, 'local', null);
    expireOldLowValueObservations(db, opts);
    const row = db.prepare(`SELECT expired_at_epoch FROM observations WHERE id=?`).get(fileId) as { expired_at_epoch: number | null };
    expect(row.expired_at_epoch).toBeNull(); // the file on disk is the human's standing assertion
  });
});

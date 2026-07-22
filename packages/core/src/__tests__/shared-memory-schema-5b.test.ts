// Slice 5 — B-01/B-04 schema foundations (cross-repo surfacing).
//
// Verifies the additive, dormant-by-default schema that the share/import/accept
// pipeline stands on:
//   • observations.shareable — the per-decision SHARE opt-in, DEFAULT 0 (fail-closed:
//     no pre-existing or machine-written row is shareable until a human says so).
//   • shared_memory_pending — the inbox landing table; the sole home of a verified-
//     but-unaccepted cross-repo record (B-04) and its verbatim envelope bytes (B-05).
//   • audit_log accepts the seven B-10 cross-repo event types and still rejects an
//     unknown one (the CHECK vocabulary was extended in all three copies).
// Migration is idempotent and repairs a pre-5B DB (PRAGMA-guarded ADD COLUMN).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  initMemorySchema,
  migrateSharedMemoryFor5B,
  createSession,
} from '../memory-db.ts';

const SHARED_EVENTS = [
  'shared_memory_exported',
  'shared_memory_export_refused',
  'shared_memory_imported',
  'shared_memory_dropped',
  'shared_memory_accepted',
  'shared_memory_refused',
  'shared_memory_revoked',
] as const;

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Slice 5 B-01/B-04 — shared-memory schema', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initMemorySchema(db);
    createSession(db, 'S1');
  });
  afterEach(() => db.close());

  it('B-01: observations.shareable exists and defaults to 0', () => {
    expect(cols(db, 'observations')).toContain('shareable');
    db.prepare(
      `INSERT INTO observations (session_id, type, title, detail, created_at, created_at_epoch)
       VALUES ('S1','decision','t','d','2026-07-21T00:00:00Z', 1)`,
    ).run();
    const r = db.prepare(`SELECT shareable FROM observations WHERE title='t'`).get() as { shareable: number };
    expect(r.shareable).toBe(0);
  });

  it('B-04: shared_memory_pending exists with the pipeline columns and a UNIQUE record_hash', () => {
    const c = cols(db, 'shared_memory_pending');
    for (const name of [
      'record_hash', 'origin_repo_id', 'origin_repo_label', 'envelope_raw', 'record_json',
      'received_at_epoch', 'accepted_at_epoch', 'refused_at_epoch', 'expired_at_epoch',
    ]) {
      expect(c, `shared_memory_pending.${name}`).toContain(name);
    }
    const ins = db.prepare(
      `INSERT INTO shared_memory_pending (record_hash, origin_repo_id, origin_repo_label, envelope_raw, record_json, received_at_epoch)
       VALUES (?,?,?,?,?,?)`,
    );
    ins.run('hash1', 'repo-a', 'repo_a', '{}', '{}', 1);
    expect(() => ins.run('hash1', 'repo-a', 'repo_a', '{}', '{}', 2)).toThrow(); // UNIQUE(record_hash)
  });

  it('B-10: audit_log accepts all seven cross-repo events and rejects an unknown one', () => {
    const ins = db.prepare(`INSERT INTO audit_log (session_id, event_type, actor) VALUES ('S1', ?, 'ai')`);
    for (const ev of SHARED_EVENTS) expect(() => ins.run(ev), ev).not.toThrow();
    expect(() => ins.run('shared_memory_not_a_real_event')).toThrow(); // CHECK holds
    expect(db.prepare(`SELECT COUNT(*) n FROM audit_log`).get()).toMatchObject({ n: SHARED_EVENTS.length });
  });

  it('S-5 rollback: an INSERT without origin gets DEFAULT local (an older core stays correct)', () => {
    // The added columns are additive + defaulted, so a core that never learned about
    // `origin` writes a row that is correctly LOCAL — never a NULL/foreign origin.
    db.prepare(
      `INSERT INTO observations (session_id, type, title, detail, created_at, created_at_epoch)
       VALUES ('S1','decision','legacy write','d','2026-07-21T00:00:00Z', 1)`,
    ).run();
    const r = db.prepare(`SELECT origin, shareable FROM observations WHERE title='legacy write'`).get() as { origin: string; shareable: number };
    expect(r.origin).toBe('local');
    expect(r.shareable).toBe(0);
  });

  it('migration is idempotent — a second run changes nothing', () => {
    const before = cols(db, 'observations').length;
    migrateSharedMemoryFor5B(db);
    migrateSharedMemoryFor5B(db);
    expect(cols(db, 'observations').length).toBe(before);
    expect(cols(db, 'observations').filter((c) => c === 'shareable')).toHaveLength(1);
  });

  it('repairs a pre-5B DB: an observations table without shareable gains it (rows default 0)', () => {
    // A DB created before 5B: a minimal observations table with no shareable column.
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL,
        title TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO observations (session_id, type, title, detail, created_at, created_at_epoch)
       VALUES ('S1','decision','pre','body','2026-01-01T00:00:00Z', 1)`,
    ).run();
    expect(cols(legacy, 'observations')).not.toContain('shareable');

    migrateSharedMemoryFor5B(legacy);

    expect(cols(legacy, 'observations')).toContain('shareable');
    const r = legacy.prepare(`SELECT shareable FROM observations WHERE title='pre'`).get() as { shareable: number };
    expect(r.shareable).toBe(0); // existing rows are un-shareable, fail-closed
    expect(cols(legacy, 'shared_memory_pending')).toContain('record_hash');
    legacy.close();
  });
});

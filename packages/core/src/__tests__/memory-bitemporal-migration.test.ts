// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-living-memory-slice-2-temporal-model P7-002: bi-temporal schema tests.
// Verifies the additive columns exist after initMemorySchema, new rows are
// stamped "valid now / never expired", the one-time backfill of pre-existing
// rows is correct + idempotent, and the epoch companions use SECONDS (matching
// created_at_epoch) so asOf range predicates work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession, addObservation } from '../memory-db.ts';
import { storeDecision } from '../adr-generator.ts';

function mkDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const BITEMPORAL_COLS = [
  'valid_from', 'valid_to', 'ingested_at', 'expired_at',
  'valid_from_epoch', 'valid_to_epoch', 'ingested_at_epoch', 'expired_at_epoch',
  'superseded_by',
];

function colNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('bi-temporal migration (P7-002)', () => {
  let db: Database.Database;
  beforeEach(() => { db = mkDb(); initMemorySchema(db); createSession(db, 's1'); });
  afterEach(() => { db.close(); });

  it('adds all nine bi-temporal columns to observations and architecture_decisions', () => {
    const obs = colNames(db, 'observations');
    const ad = colNames(db, 'architecture_decisions');
    for (const c of BITEMPORAL_COLS) {
      expect(obs, `observations.${c}`).toContain(c);
      expect(ad, `architecture_decisions.${c}`).toContain(c);
    }
  });

  it('stamps a new observation "valid now, never expired" with epoch in SECONDS', () => {
    const id = addObservation(db, 's1', 'decision', 'Use X', 'we chose X');
    const row = db.prepare(
      `SELECT valid_from, ingested_at, valid_from_epoch, ingested_at_epoch, valid_to, expired_at, superseded_by, created_at_epoch FROM observations WHERE id = ?`,
    ).get(id) as Record<string, unknown>;
    expect(row.valid_from).not.toBeNull();
    expect(row.ingested_at).not.toBeNull();
    // epoch companions equal created_at_epoch (SECONDS, ~10-digit not 13-digit ms)
    expect(row.valid_from_epoch).toBe(row.created_at_epoch);
    expect(row.ingested_at_epoch).toBe(row.created_at_epoch);
    expect(String(row.valid_from_epoch).length).toBeLessThanOrEqual(10);
    // live: no expiry / no successor
    expect(row.valid_to).toBeNull();
    expect(row.expired_at).toBeNull();
    expect(row.superseded_by).toBeNull();
  });

  it('stamps a new architecture_decision valid-now (epoch seconds derived from created_at)', () => {
    const id = storeDecision(db, {
      title: 'DB choice', context: '', decision: 'better-sqlite3 over node:sqlite',
      alternatives: ['better-sqlite3', 'node:sqlite'], consequences: '', sessionId: 's1',
    });
    const row = db.prepare(
      `SELECT valid_from_epoch, ingested_at_epoch, expired_at, status FROM architecture_decisions WHERE id = ?`,
    ).get(id) as Record<string, unknown>;
    expect(row.valid_from_epoch).not.toBeNull();
    expect(row.ingested_at_epoch).toBe(row.valid_from_epoch);
    expect(String(row.valid_from_epoch).length).toBeLessThanOrEqual(10); // seconds
    expect(row.expired_at).toBeNull();
    expect(row.status).toBe('accepted');
  });

  it('backfills a pre-existing (pre-migration) row to valid-now and is idempotent', () => {
    // Simulate a row written before the migration: NULL temporal columns.
    db.prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, recurrence_count, created_at, created_at_epoch)
       VALUES ('s1','feature','old row','x',3,1,'2026-01-01T00:00:00.000Z', 1767225600)`,
    ).run();
    const before = db.prepare(`SELECT id, valid_from_epoch FROM observations WHERE title='old row'`).get() as { id: number; valid_from_epoch: number | null };
    expect(before.valid_from_epoch).toBeNull();

    // Re-run schema init → backfill fires.
    initMemorySchema(db);
    const after = db.prepare(`SELECT valid_from_epoch, ingested_at_epoch, valid_to_epoch, expired_at_epoch FROM observations WHERE id=?`).get(before.id) as Record<string, number | null>;
    expect(after.valid_from_epoch).toBe(1767225600); // = created_at_epoch (seconds)
    expect(after.ingested_at_epoch).toBe(1767225600);
    expect(after.valid_to_epoch).toBeNull();
    expect(after.expired_at_epoch).toBeNull();

    // Idempotent: a second init changes nothing.
    const changed = db.prepare(`UPDATE observations SET valid_from_epoch = valid_from_epoch WHERE id=?`).run(before.id);
    expect(changed.changes).toBe(1); // sanity: row exists
    initMemorySchema(db);
    const again = db.prepare(`SELECT valid_from_epoch FROM observations WHERE id=?`).get(before.id) as { valid_from_epoch: number };
    expect(again.valid_from_epoch).toBe(1767225600);
  });
});

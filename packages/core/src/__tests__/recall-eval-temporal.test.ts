// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-living-memory-slice-2-temporal-model P6-001: temporal recall eval.
// Deterministic (FTS/BM25 only — no embedder): a superseded fact is NOT surfaced
// as current, its successor IS; includeSuperseded annotates it; and an asOf query
// reconstructs the belief state at a past instant. Also asserts no regression to
// non-temporal recall (a live row still surfaces).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession, addObservation, markRecordSuperseded } from '../memory-db.ts';
import { hybridSearch } from '../memory-hybrid-search.ts';

function mkDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  createSession(db, 's1');
  return db;
}

/** Force a row's event/transaction "arrival" epoch (seconds) for deterministic asOf tests. */
function setArrival(db: Database.Database, id: number, epochSec: number): void {
  db.prepare(
    `UPDATE observations SET created_at_epoch=?, valid_from_epoch=?, ingested_at_epoch=? WHERE id=?`,
  ).run(epochSec, epochSec, epochSec, id);
}

describe('temporal recall eval (P6-001)', () => {
  let db: Database.Database;
  let aId: number; // the superseded fact ("deploy with Vercel")
  let bId: number; // the successor ("deploy with the massu-deploy script")
  const T0 = 1_700_000_000; // A's arrival (seconds)
  const T_SUPER = T0 + 100; // B's arrival + A's supersede instant

  beforeEach(() => {
    db = mkDb();
    aId = addObservation(db, 's1', 'decision', 'deploy with Vercel', 'we deploy the website with Vercel');
    bId = addObservation(db, 's1', 'decision', 'deploy with script', 'we switched to the massu-deploy script instead');
    setArrival(db, aId, T0);
    setArrival(db, bId, T_SUPER); // B arrives 100s after A
    // B supersedes A at T_SUPER (UPDATE, not delete)
    markRecordSuperseded(db, 'observations', aId, bId, T_SUPER);
  });
  afterEach(() => { db.close(); });

  it('default recall surfaces the successor and NOT the superseded fact', () => {
    const res = hybridSearch(db, null, { queryText: 'deploy website', sources: ['observation'], limit: 8 });
    const ids = res.map((r) => r.id);
    expect(ids).toContain(bId);
    expect(ids).not.toContain(aId);
  });

  it('includeSuperseded surfaces the superseded fact WITH an annotation', () => {
    const res = hybridSearch(db, null, { queryText: 'deploy website', sources: ['observation'], limit: 8, includeSuperseded: true });
    const a = res.find((r) => r.id === aId);
    expect(a, 'superseded row present when includeSuperseded').toBeTruthy();
    expect(a!.snippet).toMatch(/superseded on .* by #/);
    expect(a!.snippet).toContain(`#${bId}`);
  });

  it('asOf BEFORE the supersede reconstructs the old belief (A), not the successor', () => {
    const asOfMs = (T0 + 50) * 1000; // after A arrived, before B arrived / A expired
    const res = hybridSearch(db, null, { queryText: 'deploy website', sources: ['observation'], limit: 8, asOf: asOfMs });
    const ids = res.map((r) => r.id);
    expect(ids).toContain(aId); // A was the current belief then
    expect(ids).not.toContain(bId); // B had not arrived yet
  });

  it('asOf AFTER the supersede returns the successor, not the retired fact', () => {
    const asOfMs = (T_SUPER + 50) * 1000;
    const res = hybridSearch(db, null, { queryText: 'deploy website', sources: ['observation'], limit: 8, asOf: asOfMs });
    const ids = res.map((r) => r.id);
    expect(ids).toContain(bId);
    expect(ids).not.toContain(aId);
  });

  it('no-regression: a live (never-superseded) observation still surfaces by default', () => {
    const cId = addObservation(db, 's1', 'feature', 'add CSV export', 'export dashboard data as CSV');
    const res = hybridSearch(db, null, { queryText: 'CSV export dashboard', sources: ['observation'], limit: 8 });
    expect(res.map((r) => r.id)).toContain(cId);
  });
});

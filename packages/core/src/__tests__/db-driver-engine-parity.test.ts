// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * M-006 (plan-massu-resilience-layer2, CR-69) — PERMANENT dual-engine data-integrity
 * parity regression test. Any future divergence between `node:sqlite` and
 * `better-sqlite3` fails CI, not just the one-time spike.
 *
 * The query+table corpus is DERIVED FROM REALITY at test time
 * (`feedback_drift_guard_filesystem_derived_over_static`): the temp DB is built with
 * massu's OWN schema SoT (`initMemorySchema`), then EVERY table/FTS5 vtable found in
 * `sqlite_master` is enumerated and exercised on BOTH engines. A static ~20-query
 * snapshot would fail-open the moment a Slice adds a table; deriving the corpus means
 * any table/column/query Slices 2-5 introduce (bi-temporal, consolidation counters,
 * projection metadata, cross-repo candidate tables, embedding BLOBs) is AUTOMATICALLY
 * exercised on both engines with no edit here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, type MassuDatabase } from '../db-driver.ts';
import { initMemorySchema, addObservation } from '../memory-db.ts';
import { float32ToBlob } from '../memory-vector.ts';

let workDir: string;
let dbPath: string;

function openEngine(engine: 'node-sqlite' | 'better-sqlite3', readonly = false): MassuDatabase {
  process.env.MASSU_DB_ENGINE = engine === 'better-sqlite3' ? 'better-sqlite3' : 'node-sqlite';
  return openDatabase(dbPath, readonly ? { readonly: true } : {});
}

/** Normalize a row for cross-engine deepEqual: plain values, BLOB→hex, bigint→tagged. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Uint8Array) out[k] = 'BLOB:' + Buffer.from(v).toString('hex');
    else if (typeof v === 'bigint') out[k] = 'BIG:' + v.toString();
    else out[k] = v;
  }
  return out;
}
// Order-independent: sort by JSON so identical row SETS compare equal regardless of
// any engine-internal traversal order.
function normalizeRows(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => JSON.stringify(normalizeRow(r))).sort();
}

interface DerivedQuery {
  label: string;
  sql: string;
  params: unknown[];
}

/** Enumerate the corpus from the LIVE schema: SELECT * per table + MATCH per FTS5 vtable. */
function deriveCorpus(db: MassuDatabase): DerivedQuery[] {
  const objs = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string | null }>;
  const queries: DerivedQuery[] = [];
  for (const { name, sql } of objs) {
    const isFts5 = !!sql && /USING\s+fts5/i.test(sql);
    if (isFts5) {
      // FTS5 virtual table — MATCH a seeded term (and an empty-result term for good measure).
      for (const term of ['parity', 'zzznomatchzzz']) {
        queries.push({
          label: `match:${name}:${term}`,
          sql: `SELECT rowid FROM "${name}" WHERE "${name}" MATCH ? ORDER BY rowid`,
          params: [term],
        });
      }
    } else {
      // Regular table (incl. FTS shadow tables) — full-table read, order-independent compare.
      queries.push({ label: `scan:${name}`, sql: `SELECT * FROM "${name}"`, params: [] });
    }
  }
  return queries;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'massu-engine-parity-'));
  dbPath = join(workDir, 'memory.db');
  // Build the file with massu's OWN schema SoT via the default engine, then seed real data.
  const db = openEngine('node-sqlite');
  initMemorySchema(db);
  // FK is ON (bs3-faithful default + how getMemoryDb runs) — seed the parent session
  // row before observations, mirroring the real session-start → observation flow.
  db.prepare(
    'INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)',
  ).run('sess-parity', new Date().toISOString(), Math.floor(Date.now() / 1000));
  const oid1 = addObservation(db, 'sess-parity', 'decision', 'parity milestone', 'engine parity across node:sqlite and better-sqlite3', { importance: 4 });
  addObservation(db, 'sess-parity', 'incident_near_miss', 'blob roundtrip', 'vectors must survive parity intact', { importance: 3 });
  addObservation(db, 'sess-parity', 'cr_violation', 'unrelated title', 'no keyword here', { importance: 2 });
  // A real embedding BLOB (exercises Uint8Array vs Buffer BLOB parity).
  const vec = new Float32Array([0.1, -0.2, 0.3, 0.4]);
  db.prepare(
    'INSERT INTO observation_embeddings (observation_id, chunk_ix, model_id, dim, vec, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(oid1, 0, 'test-model', vec.length, float32ToBlob(vec), new Date().toISOString());
  db.close();
});

afterAll(() => {
  delete process.env.MASSU_DB_ENGINE;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('dual-engine data-integrity parity (M-006, derived corpus)', () => {
  it('every table + FTS5 vtable in the live schema returns identical rows on both engines', () => {
    const nod = openEngine('node-sqlite', true);
    const bs3 = openEngine('better-sqlite3', true);
    try {
      const corpus = deriveCorpus(nod);
      // The corpus MUST cover the real schema — a floor well above the plan's ≥20, and it
      // GROWS automatically as Slices add tables (derived, never a frozen snapshot).
      expect(corpus.length).toBeGreaterThanOrEqual(20);

      let ftsMatchCount = 0;
      let blobChecked = false;
      for (const q of corpus) {
        const a = normalizeRows(nod.prepare(q.sql).all(...q.params) as Array<Record<string, unknown>>);
        const b = normalizeRows(bs3.prepare(q.sql).all(...q.params) as Array<Record<string, unknown>>);
        expect(b, `engine divergence on ${q.label}`).toEqual(a);
        if (q.label.startsWith('match:') && a.length > 0) ftsMatchCount++;
        if (q.label === 'scan:observation_embeddings' && a.some((r) => r.includes('BLOB:'))) blobChecked = true;
      }
      // Prove the corpus actually exercised the hard cases (anti-vacuity): a real FTS5
      // MATCH returned rows on both engines, and a BLOB column was compared as bytes.
      expect(ftsMatchCount, 'at least one FTS5 MATCH must return rows on both engines').toBeGreaterThan(0);
      expect(blobChecked, 'the embedding BLOB column must have been byte-compared').toBe(true);
    } finally {
      nod.close();
      bs3.close();
    }
  });
});

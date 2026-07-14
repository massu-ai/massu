// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-003 (plan-living-memory-slice-1) — hybrid search ranking.
 * Covers: BM25-only (FTS) mode, recency/importance shaping, source filtering,
 * cosine fusion when a query vector is present, and deterministic ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession, addObservation } from '../memory-db.ts';
import { initKnowledgeSchema } from '../knowledge-db.ts';
import { hybridSearch } from '../memory-hybrid-search.ts';
import { float32ToBlob, l2normalize } from '../memory-vector.ts';

const NOW = Date.parse('2026-07-11T00:00:00Z');
const DAY = 86_400_000;

function seedMem(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  createSession(db, 's1');
  return db;
}

describe('P1-003: hybridSearch (FTS-only / no query vector)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedMem();
  });
  afterEach(() => db?.close());

  it('ranks a BM25-matching observation above unrelated ones', () => {
    addObservation(db, 's1', 'decision', 'login fail fast when no terminal', 'guard isTTY and bound stdin so non-interactive login never hangs', { importance: 5 });
    addObservation(db, 's1', 'feature', 'unrelated dashboard tweak', 'button styling', { importance: 3 });

    const results = hybridSearch(db, null, {
      queryText: 'make login fail fast when there is no terminal',
      queryVec: null,
      sources: ['observation'],
      now: NOW,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('login fail fast');
    expect(results[0].source).toBe('observation');
  });

  it('returns empty when there are no candidates and query has no matches on an empty store', () => {
    const results = hybridSearch(db, null, {
      queryText: 'nonexistent topic xyzzy',
      queryVec: null,
      sources: ['observation'],
      now: NOW,
    });
    expect(results).toEqual([]);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 10; i++) {
      addObservation(db, 's1', 'discovery', `login note ${i}`, `login detail ${i}`, { importance: 3 });
    }
    const results = hybridSearch(db, null, {
      queryText: 'login',
      queryVec: null,
      sources: ['observation'],
      limit: 3,
      now: NOW,
    });
    expect(results.length).toBe(3);
  });

  it('recency shaping: newer of two equal-importance BM25 matches ranks higher', () => {
    const old = addObservation(db, 's1', 'discovery', 'login retry logic', 'login detail', { importance: 3 });
    const recent = addObservation(db, 's1', 'discovery', 'login retry handling', 'login detail', { importance: 3 });
    // Backdate the first observation ~180 days.
    db.prepare('UPDATE observations SET created_at_epoch = ? WHERE id = ?').run(
      Math.floor((NOW - 180 * DAY) / 1000),
      old,
    );
    db.prepare('UPDATE observations SET created_at_epoch = ? WHERE id = ?').run(
      Math.floor((NOW - 1 * DAY) / 1000),
      recent,
    );

    const results = hybridSearch(db, null, {
      queryText: 'login retry',
      queryVec: null,
      sources: ['observation'],
      now: NOW,
    });
    expect(results[0].id).toBe(recent);
  });

  it('deterministic ordering on a fixed fixture', () => {
    addObservation(db, 's1', 'decision', 'alpha login topic', 'aaa', { importance: 4 });
    addObservation(db, 's1', 'decision', 'beta login topic', 'bbb', { importance: 4 });
    const a = hybridSearch(db, null, { queryText: 'login topic', queryVec: null, sources: ['observation'], now: NOW });
    const b = hybridSearch(db, null, { queryText: 'login topic', queryVec: null, sources: ['observation'], now: NOW });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

describe('P1-003: hybridSearch (with query vector / cosine fusion)', () => {
  let db: Database.Database;
  const MODEL = 'test-model';
  const DIM = 4;

  beforeEach(() => {
    db = seedMem();
  });
  afterEach(() => db?.close());

  function embedRow(obsId: number, vec: number[]) {
    const norm = l2normalize(Float32Array.from(vec));
    db.prepare(
      `INSERT INTO observation_embeddings (observation_id, model_id, dim, vec) VALUES (?, ?, ?, ?)`,
    ).run(obsId, MODEL, DIM, float32ToBlob(norm));
  }

  it('boosts the row whose embedding is closest to the query vector', () => {
    const near = addObservation(db, 's1', 'discovery', 'login topic near', 'login', { importance: 3 });
    const far = addObservation(db, 's1', 'discovery', 'login topic far', 'login', { importance: 3 });
    embedRow(near, [1, 0, 0, 0]);
    embedRow(far, [0, 0, 0, 1]);

    const results = hybridSearch(db, null, {
      queryText: 'login topic',
      queryVec: l2normalize(Float32Array.from([1, 0, 0, 0])),
      modelId: MODEL,
      dim: DIM,
      sources: ['observation'],
      now: NOW,
    });
    expect(results[0].id).toBe(near);
  });

  it('skips embeddings whose model_id/dim mismatch (falls back to BM25)', () => {
    const a = addObservation(db, 's1', 'discovery', 'login topic aaa', 'login', { importance: 3 });
    // Wrong model_id — must be ignored, no throw.
    db.prepare(
      `INSERT INTO observation_embeddings (observation_id, model_id, dim, vec) VALUES (?, ?, ?, ?)`,
    ).run(a, 'other-model', DIM, float32ToBlob(l2normalize(Float32Array.from([1, 0, 0, 0]))));

    const results = hybridSearch(db, null, {
      queryText: 'login topic',
      queryVec: l2normalize(Float32Array.from([1, 0, 0, 0])),
      modelId: MODEL,
      dim: DIM,
      sources: ['observation'],
      now: NOW,
    });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(a);
  });
});

describe('P1-003: hybridSearch (knowledge chunks + failure classes)', () => {
  let memDb: Database.Database;
  let kDb: Database.Database;

  beforeEach(() => {
    memDb = seedMem();
    kDb = new Database(':memory:');
    kDb.pragma('foreign_keys = ON');
    initKnowledgeSchema(kDb);
  });
  afterEach(() => {
    memDb?.close();
    kDb?.close();
  });

  it('surfaces a knowledge chunk matching the query', () => {
    const now = new Date().toISOString();
    const docId = Number(
      kDb
        .prepare(
          `INSERT INTO knowledge_documents (file_path, category, title, content_hash, indexed_at, indexed_at_epoch)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('/x.md', 'pattern', 'X', 'h', now, Math.floor(NOW / 1000)).lastInsertRowid,
    );
    kDb.prepare(
      `INSERT INTO knowledge_chunks (document_id, chunk_type, heading, content) VALUES (?, ?, ?, ?)`,
    ).run(docId, 'section', 'Node 26 ABI break', 'better-sqlite3 native module broke on node 26');

    const results = hybridSearch(memDb, kDb, {
      queryText: 'node 26 native module abi',
      queryVec: null,
      sources: ['knowledge_chunk'],
      now: NOW,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('knowledge_chunk');
  });

  it('surfaces a failure class matching the query (LIKE source, no FTS)', () => {
    memDb
      .prepare(
        `INSERT INTO failure_classes (name, description, known_message) VALUES (?, ?, ?)`,
      )
      .run('validate-key-500', 'deployed edge bundle drift caused 500 on every key', 'async compare crash');

    const results = hybridSearch(memDb, null, {
      queryText: 'validate key 500 deploy drift',
      queryVec: null,
      sources: ['failure_class'],
      now: NOW,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('failure_class');
  });
});

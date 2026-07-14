// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2-001 / P5-001 (plan-living-memory-slice-2a-embedder): embedding writer +
 * sweep. Embedder is mocked for determinism (fail-open contract is exercised
 * separately in memory-embedder.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mutable mock state shared with the hoisted vi.mock factory.
const mockState = vi.hoisted(() => ({
  returnNull: false,
  active: { modelId: 'mock-embed', dim: 4 } as { modelId: string; dim: number } | null,
}));

vi.mock('../memory-embedder.ts', async (importOriginal) => {
  // Spread the REAL module first. A factory that lists only the exports it knows about
  // silently makes every OTHER export `undefined` — so when A-04 added
  // `chunkForEmbedding`, the sweep called undefined, threw, and its fail-open catch
  // swallowed it: the sweep embedded NOTHING and four tests failed with "expected 0".
  // The chunker is pure, so the real one is exactly what we want under test.
  const actual = await importOriginal<typeof import('../memory-embedder.ts')>();
  return {
    ...actual,
    EMBED_MODEL_ID: 'mock-embed',
    EMBED_DIM: 4,
    getActiveEmbedModel: () => (mockState.returnNull ? null : mockState.active),
    embed: async () => (mockState.returnNull ? null : Float32Array.from([1, 0, 0, 0])),
    embedBatch: async (texts: string[]) =>
      texts.map((t) =>
        mockState.returnNull || !t.trim()
          ? null
          : Float32Array.from([t.length % 7, 1, 0, 0]),
      ),
  };
});

import {
  initMemorySchema,
  createSession,
  addObservation,
  embedMissingObservations,
  upsertObservationEmbedding,
} from '../memory-db.ts';

function seed(n: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  createSession(db, 's');
  for (let i = 0; i < n; i++) {
    addObservation(db, 's', 'decision', `title ${i}`, `detail body number ${i}`, { importance: 3 });
  }
  return db;
}

function embCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) c FROM observation_embeddings').get() as { c: number }).c;
}

describe('P2-001: embedMissingObservations sweep', () => {
  beforeEach(() => {
    mockState.returnNull = false;
    mockState.active = { modelId: 'mock-embed', dim: 4 };
  });

  it('embeds all rows on the first sweep', async () => {
    const db = seed(10);
    const res = await embedMissingObservations(db);
    expect(res.embedded).toBe(10);
    expect(embCount(db)).toBe(10);
    db.close();
  });

  it('a re-run on a fully-embedded store embeds nothing (idempotent)', async () => {
    const db = seed(10);
    await embedMissingObservations(db);
    const res2 = await embedMissingObservations(db);
    expect(res2.embedded).toBe(0);
    expect(embCount(db)).toBe(10);
    db.close();
  });

  it('resume via limit embeds each row exactly once', async () => {
    const db = seed(10);
    const r1 = await embedMissingObservations(db, { limit: 4 });
    expect(r1.embedded).toBe(4);
    expect(embCount(db)).toBe(4);
    const r2 = await embedMissingObservations(db, { limit: 4 });
    expect(r2.embedded).toBe(4);
    expect(embCount(db)).toBe(8);
    const r3 = await embedMissingObservations(db);
    expect(r3.embedded).toBe(2);
    expect(embCount(db)).toBe(10);
    // No duplicates — PK is observation_id.
    const distinct = (
      db.prepare('SELECT COUNT(DISTINCT observation_id) c FROM observation_embeddings').get() as {
        c: number;
      }
    ).c;
    expect(distinct).toBe(10);
    db.close();
  });

  it('a null-returning embedder writes nothing and does not throw', async () => {
    mockState.returnNull = true;
    const db = seed(5);
    const res = await embedMissingObservations(db);
    expect(res.embedded).toBe(0);
    expect(embCount(db)).toBe(0);
    db.close();
  });

  it('all stored rows carry the active (model_id, dim) tag', async () => {
    const db = seed(3);
    await embedMissingObservations(db);
    const rows = db
      .prepare('SELECT model_id, dim FROM observation_embeddings')
      .all() as Array<{ model_id: string; dim: number }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.model_id === 'mock-embed' && r.dim === 4)).toBe(true);
    db.close();
  });

  it('upsertObservationEmbedding writes a decodable BLOB', async () => {
    const db = seed(1);
    const id = (db.prepare('SELECT id FROM observations LIMIT 1').get() as { id: number }).id;
    upsertObservationEmbedding(db, id, Float32Array.from([0.5, 0.5, 0.5, 0.5]), 'mock-embed', 4);
    const row = db
      .prepare('SELECT model_id, dim, vec FROM observation_embeddings WHERE observation_id = ?')
      .get(id) as { model_id: string; dim: number; vec: Buffer };
    expect(row.model_id).toBe('mock-embed');
    expect(row.dim).toBe(4);
    expect(row.vec.byteLength).toBe(16);
    db.close();
  });
});

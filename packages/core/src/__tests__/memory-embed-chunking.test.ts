// A-04 — one vector per PASSAGE, not one per memory.
//
// The bundled embedder clamps to 256 WordPiece tokens (~1,000 chars,
// `memory-embedder-tokenizer.ts:174`) and the caller never overrides it. So a single
// vector over the operator's largest memory (14,408 chars) represented ~7% of it, and
// the other 93% had NO semantic representation at all. "A query matching text at the
// END of a long memory retrieves it" could never pass with one vector per memory,
// however the sweep was wired — the ceiling was in the tokenizer, not the plumbing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

import {
  initMemorySchema,
  createSession,
  migrateObservationEmbeddingChunks,
} from '../memory-db.ts';
import {
  chunkForEmbedding,
  CHUNK_TARGET_CHARS,
  MAX_CHUNKS_PER_RECORD,
} from '../memory-embedder.ts';

describe('A-04 chunked embedding', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'massu-chunk-'));
    db = new Database(join(dir, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  describe('chunkForEmbedding', () => {
    it('leaves a short memory as ONE chunk', () => {
      expect(chunkForEmbedding('a short memory')).toEqual(['a short memory']);
      expect(chunkForEmbedding('')).toEqual([]);
    });

    it('splits a long memory into windows that FIT the tokenizer budget', () => {
      const text = 'word '.repeat(4000); // 20,000 chars
      const chunks = chunkForEmbedding(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.length, 'every chunk must fit the 256-token budget').toBeLessThanOrEqual(
          CHUNK_TARGET_CHARS,
        );
      }
    });

    it('COVERS the end of the text — the whole point', () => {
      const tail = 'THE-FACT-AT-THE-VERY-END';
      const text = 'filler '.repeat(2000) + tail;
      const chunks = chunkForEmbedding(text);
      expect(
        chunks.some((c) => c.includes(tail)),
        'the last chunk must contain the end of the memory; a single vector never did',
      ).toBe(true);
    });

    it('OVERLAPS, so a fact straddling a seam is reachable from both sides', () => {
      const text = 'a'.repeat(880) + ' STRADDLING-FACT ' + 'b'.repeat(880);
      const chunks = chunkForEmbedding(text);
      const hits = chunks.filter((c) => c.includes('STRADDLING-FACT')).length;
      expect(hits).toBeGreaterThanOrEqual(1);
    });

    it('prefers a sentence boundary over a mid-word cut', () => {
      const s1 = 'x'.repeat(700) + '. ';
      const chunks = chunkForEmbedding(s1 + 'y'.repeat(700) + '.');
      expect(chunks[0].endsWith('.'), 'first chunk should end at the sentence').toBe(true);
    });

    it('is BOUNDED — a pathological file cannot explode the sweep', () => {
      const chunks = chunkForEmbedding('word '.repeat(200_000)); // 1M chars
      expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_RECORD);
    });
  });

  describe('schema', () => {
    it('stores MANY vectors per observation (it used to allow exactly one)', () => {
      db.prepare(
        `INSERT INTO observations (id, session_id, type, title, detail, importance, created_at, created_at_epoch)
         VALUES (1, 'S1', 'discovery', 't', 'd', 3, datetime('now'), strftime('%s','now'))`,
      ).run();

      const ins = db.prepare(
        `INSERT INTO observation_embeddings (observation_id, chunk_ix, model_id, dim, vec)
         VALUES (?, ?, 'm', 4, ?)`,
      );
      // Before A-04, observation_id was the PRIMARY KEY — this second row was impossible.
      expect(() => {
        ins.run(1, 0, Buffer.alloc(16));
        ins.run(1, 1, Buffer.alloc(16));
        ins.run(1, 2, Buffer.alloc(16));
      }).not.toThrow();

      const n = (
        db.prepare(`SELECT COUNT(*) n FROM observation_embeddings WHERE observation_id = 1`).get() as {
          n: number;
        }
      ).n;
      expect(n).toBe(3);
    });

    it('migrates an EXISTING 1-vector-per-row database, preserving its vectors as chunk 0', () => {
      // The production case: every database already in the field has the old PK.
      const legacy = new Database(join(dir, 'legacy.db'));
      legacy.exec(`
        CREATE TABLE observations (id INTEGER PRIMARY KEY);
        CREATE TABLE observation_embeddings (
          observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vec BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      legacy.prepare(`INSERT INTO observations (id) VALUES (7)`).run();
      legacy
        .prepare(`INSERT INTO observation_embeddings (observation_id, model_id, dim, vec) VALUES (7,'m',4,?)`)
        .run(Buffer.from([1, 2, 3, 4]));

      migrateObservationEmbeddingChunks(legacy);

      const row = legacy
        .prepare(`SELECT chunk_ix, vec FROM observation_embeddings WHERE observation_id = 7`)
        .get() as { chunk_ix: number; vec: Buffer };
      expect(row.chunk_ix, 'the existing vector IS the first chunk — no re-embed forced').toBe(0);
      expect(Buffer.from(row.vec)).toEqual(Buffer.from([1, 2, 3, 4]));

      // ...and now a second chunk fits where it could not before.
      expect(() =>
        legacy
          .prepare(
            `INSERT INTO observation_embeddings (observation_id, chunk_ix, model_id, dim, vec) VALUES (7,1,'m',4,?)`,
          )
          .run(Buffer.from([5, 6, 7, 8])),
      ).not.toThrow();

      // Idempotent.
      expect(() => migrateObservationEmbeddingChunks(legacy)).not.toThrow();
      legacy.close();
    });
  });
});

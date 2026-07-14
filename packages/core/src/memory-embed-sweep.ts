// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P2-001 (plan-living-memory-slice-2a-embedder): the ONE structural embedding
// writer + sweep. Rather than N insertions at the 7 addObservation call sites,
// a single generic `runEmbedSweep` selects rows lacking a matching
// (model_id, dim) embedding, batches them through the fail-open embedder, and
// upserts the resulting Float32 BLOBs into the companion table.
//
// Properties:
//   - Fail-open: a null-returning embedder writes nothing and never throws.
//   - Resumable: a `<meta>` cursor (embed_sweep_cursor_<table>) lets an
//     interrupted backfill resume without re-scanning embedded rows.
//   - Time-boxable: `budgetMs` bounds wall time; `limit` bounds rows embedded.
//   - Idempotent: a re-run on a fully-embedded store is a near no-op (the
//     NOT-EXISTS filter returns zero candidate rows before any model load).
//
// Table-specific SQL lives in memory-db.ts / knowledge-db.ts (the thin named
// wrappers); the loop lives here ONCE (DRY / testable).
// ============================================================

import type Database from 'better-sqlite3';
import {
  embedBatch,
  getActiveEmbedModel,
  chunkForEmbedding,
  type ActiveEmbedModel,
} from './memory-embedder.ts';
import { float32ToBlob } from './memory-vector.ts';

/** A candidate row to embed: its primary key + the text to embed. */
export interface SweepRow {
  id: number;
  text: string;
}

export interface EmbedSweepConfig {
  /** Companion embedding table, e.g. 'observation_embeddings'. */
  embeddingTable: string;
  /** FK column in the embedding table, e.g. 'observation_id'. */
  idCol: string;
  /** Meta table holding the resumable cursor ('memory_meta' | 'knowledge_meta'). */
  metaTable: string;
  /** Source table, e.g. 'observations' (used only for the cursor key). */
  sourceLabel: string;
  /**
   * Select up to `batchSize` candidate rows with primary key > `cursor` that
   * lack a matching embedding. When `model` is null (active tier not yet
   * resolved) select rows with NO embedding row at all; when non-null select
   * rows with no embedding for that exact (model_id, dim).
   */
  /**
   * A-04 — embed one vector per PASSAGE, not one per record. Only for tables whose
   * schema carries `chunk_ix` (observation_embeddings). The embedder clamps at 256
   * WordPiece tokens, so a single vector over a long memory represents only its first
   * ~1,000 chars; without chunking, "find the passage deep inside this memory" is
   * impossible by construction.
   */
  chunked?: boolean;
  selectMissing: (
    db: Database.Database,
    cursor: number,
    model: ActiveEmbedModel | null,
    batchSize: number,
  ) => SweepRow[];
}

export interface EmbedSweepOpts {
  /** Wall-time budget in ms (session-end passes a small one). Unbounded if unset. */
  budgetMs?: number;
  /** Max rows to embed this run. Unbounded if unset. */
  limit?: number;
  /** DB pagination + transaction granularity (default 16). */
  batchSize?: number;
}

export interface EmbedSweepResult {
  embedded: number;
  scanned: number;
}

const KNOWN_META_TABLES = new Set(['memory_meta', 'knowledge_meta']);

function readCursor(db: Database.Database, metaTable: string, key: string): number {
  if (!KNOWN_META_TABLES.has(metaTable)) return 0;
  try {
    const row = db.prepare(`SELECT value FROM ${metaTable} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    const n = row ? Number(row.value) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(db: Database.Database, metaTable: string, key: string, value: number): void {
  if (!KNOWN_META_TABLES.has(metaTable)) return;
  try {
    db.prepare(`INSERT OR REPLACE INTO ${metaTable} (key, value) VALUES (?, ?)`).run(
      key,
      String(value),
    );
  } catch {
    // Best-effort: cursor is a perf optimization, not correctness-critical.
  }
}

/**
 * Run the embedding sweep for one companion table. Never throws — any failure
 * degrades to "embedded fewer rows" and returns the partial count.
 */
export async function runEmbedSweep(
  db: Database.Database,
  cfg: EmbedSweepConfig,
  opts: EmbedSweepOpts = {},
): Promise<EmbedSweepResult> {
  const batchSize = Math.max(1, opts.batchSize ?? 16);
  const limit = opts.limit ?? Infinity;
  const budgetMs = opts.budgetMs;
  const start = Date.now();
  const cursorKey = `embed_sweep_cursor_${cfg.sourceLabel}`;

  let embedded = 0;
  let scanned = 0;
  // Pre-resolved active model (e.g. the CLI probes once before calling so a
  // model switch re-embeds mismatched rows from iteration 1).
  let active: ActiveEmbedModel | null = getActiveEmbedModel();
  let cursor = readCursor(db, cfg.metaTable, cursorKey);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (embedded >= limit) break;
      if (budgetMs !== undefined && Date.now() - start >= budgetMs) break;

      const remaining = limit === Infinity ? batchSize : Math.min(batchSize, limit - embedded);
      const rows = cfg.selectMissing(db, cursor, active, Math.max(1, remaining));
      if (rows.length === 0) {
        // Clean completion of this pass — reset the cursor so a future run does
        // a fresh NOT-EXISTS scan (self-healing for newly-added rows).
        writeCursor(db, cfg.metaTable, cursorKey, 0);
        break;
      }

      // A-04 — CHUNKED sweeps embed one vector per PASSAGE, not one per record.
      //
      // The embedder clamps to 256 WordPiece tokens (~1,000 chars), so a single vector
      // over a 14K-char memory represents ~7% of it and the rest has no semantic
      // representation at all. Chunking is the only way "find the passage deep inside
      // this long memory" can work, however the sweep is wired.
      const units: Array<{ id: number; chunkIx: number; text: string }> = [];
      for (const r of rows) {
        if (cfg.chunked) {
          const parts = chunkForEmbedding(r.text);
          if (parts.length === 0) continue;
          parts.forEach((text, chunkIx) => units.push({ id: r.id, chunkIx, text }));
        } else {
          units.push({ id: r.id, chunkIx: 0, text: r.text });
        }
      }

      const vecs = await embedBatch(units.map((u) => u.text));
      // Resolve the active tag from the same producer the query path reads.
      if (!active) active = getActiveEmbedModel();
      if (!active) {
        // Embedder unavailable (Tier 2 / disabled) — cannot tag. Fail-open:
        // stop WITHOUT advancing the cursor so a future run (with a working
        // embedder) resumes from the same point.
        break;
      }

      const tx = db.transaction(() => {
        // Clear this record's PRIOR chunks first. A memory that SHRANK would otherwise
        // keep its stale tail chunks forever, and those orphans would keep scoring in
        // recall — a max-pool over stale passages resurrects deleted text.
        // (These are derived vectors, not memory: the no-hard-delete rule governs
        // observations/architecture_decisions/sessions/memory_files, not this cache.)
        const del = cfg.chunked
          ? db.prepare(
              `DELETE FROM ${cfg.embeddingTable}
                WHERE ${cfg.idCol} = ? AND model_id = ? AND dim = ?`,
            )
          : null;
        // Only the chunked table HAS a chunk_ix column — the knowledge sweep's table
        // does not, and referencing a column it lacks would break that path entirely.
        const stmt = cfg.chunked
          ? db.prepare(
              `INSERT OR REPLACE INTO ${cfg.embeddingTable}
                 (${cfg.idCol}, chunk_ix, model_id, dim, vec, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            )
          : db.prepare(
              `INSERT OR REPLACE INTO ${cfg.embeddingTable}
                 (${cfg.idCol}, model_id, dim, vec, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))`,
            );

        const cleared = new Set<number>();
        const embeddedIds = new Set<number>();
        for (let i = 0; i < units.length; i++) {
          const v = vecs[i];
          if (!v) continue; // per-item fail-open — skip nulls
          const u = units[i];
          if (del && !cleared.has(u.id)) {
            del.run(u.id, active!.modelId, active!.dim);
            cleared.add(u.id);
          }
          if (cfg.chunked) {
            stmt.run(u.id, u.chunkIx, active!.modelId, active!.dim, float32ToBlob(v));
          } else {
            stmt.run(u.id, active!.modelId, active!.dim, float32ToBlob(v));
          }
          embeddedIds.add(u.id);
        }
        // `embedded` counts RECORDS, not chunks, so the caller's `limit` keeps meaning
        // "how many memories to embed this pass".
        embedded += embeddedIds.size;
      });
      tx();

      scanned += rows.length;
      cursor = rows[rows.length - 1].id; // advance past the whole batch (incl. nulls)
      writeCursor(db, cfg.metaTable, cursorKey, cursor);
    }
  } catch {
    // Fail-open: return whatever was embedded so far.
  }

  return { embedded, scanned };
}

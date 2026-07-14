// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import Database from 'better-sqlite3';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getConfig, getResolvedPaths } from './config.ts';
import { float32ToBlob } from './memory-vector.ts';
import {
  runEmbedSweep,
  type SweepRow,
  type EmbedSweepOpts,
  type EmbedSweepResult,
} from './memory-embed-sweep.ts';

/**
 * Connection to Massu Knowledge's SQLite database.
 * Stores indexed .claude/ knowledge: rules, patterns, incidents, verifications, cross-references.
 * Separate from codegraph.db (CodeGraph data) and memory.db (session memory).
 */
export function getKnowledgeDb(): Database.Database {
  const dbPath = getResolvedPaths().knowledgeDbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initKnowledgeSchema(db);
  return db;
}

export function initKnowledgeSchema(db: Database.Database): void {
  db.exec(`
    -- Core document chunks (parsed from .claude/**/*.md)
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      indexed_at_epoch INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kd_filepath ON knowledge_documents(file_path);
    CREATE INDEX IF NOT EXISTS idx_kd_category ON knowledge_documents(category);

    -- Structured chunks within documents
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      chunk_type TEXT NOT NULL CHECK(chunk_type IN (
        'section', 'table_row', 'code_block', 'rule', 'incident', 'pattern', 'command', 'mismatch'
      )),
      heading TEXT,
      content TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      metadata TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_kc_doc ON knowledge_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_kc_type ON knowledge_chunks(chunk_type);
    CREATE INDEX IF NOT EXISTS idx_kc_heading ON knowledge_chunks(heading);

    -- Canonical Rules index
    CREATE TABLE IF NOT EXISTS knowledge_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT UNIQUE NOT NULL,
      rule_text TEXT NOT NULL,
      vr_type TEXT,
      reference_path TEXT,
      severity TEXT DEFAULT 'HIGH',
      prevention_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_kr_id ON knowledge_rules(rule_id);
  `);

  // P-M-036 (plan-stage-d-medium-sweep): add `source` column to knowledge_rules
  // so customer-authored `governance_rules:` entries from massu.config.yaml
  // are distinguishable from framework-shipped CR-* definitions. SQLite's
  // ALTER TABLE ADD COLUMN has no IF NOT EXISTS variant; PRAGMA-introspect.
  const rulesCols = db
    .prepare(`PRAGMA table_info(knowledge_rules)`)
    .all() as Array<{ name: string }>;
  if (!rulesCols.some((c) => c.name === 'source')) {
    db.exec(
      `ALTER TABLE knowledge_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'framework'`,
    );
  }

  db.exec(`

    -- Verification Requirements index
    CREATE TABLE IF NOT EXISTS knowledge_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vr_type TEXT UNIQUE NOT NULL,
      command TEXT NOT NULL,
      expected TEXT NOT NULL,
      use_when TEXT NOT NULL,
      catches TEXT,
      category TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_kv_type ON knowledge_verifications(vr_type);
    CREATE INDEX IF NOT EXISTS idx_kv_category ON knowledge_verifications(category);

    -- Incident index
    CREATE TABLE IF NOT EXISTS knowledge_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_num INTEGER UNIQUE NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      gap_found TEXT NOT NULL,
      prevention TEXT NOT NULL,
      cr_added TEXT,
      root_cause TEXT,
      user_quote TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ki_num ON knowledge_incidents(incident_num);
    CREATE INDEX IF NOT EXISTS idx_ki_type ON knowledge_incidents(type);
    CREATE INDEX IF NOT EXISTS idx_ki_cr ON knowledge_incidents(cr_added);

    -- Schema mismatch quick lookup
    -- P-H013 (plan-stage-c-high-batch): the source column no longer has a
    -- SQL DEFAULT. Previously the value was a JS template-literal
    -- interpolation baked into the customer SQLite at schema creation
    -- time, so later config changes were ignored. Default is now applied
    -- at INSERT time via getConfig().conventions.knowledgeSourceFiles[0]
    -- in knowledge-indexer.ts -- a runtime config lookup that reflects
    -- the customers current config.
    CREATE TABLE IF NOT EXISTS knowledge_schema_mismatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      wrong_column TEXT NOT NULL,
      correct_column TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ksm_table ON knowledge_schema_mismatches(table_name);

    -- Cross-reference graph
    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ke_source ON knowledge_edges(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_ke_target ON knowledge_edges(target_type, target_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_unique ON knowledge_edges(source_type, source_id, target_type, target_id, edge_type);

    -- Staleness tracking
    CREATE TABLE IF NOT EXISTS knowledge_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // FTS5 in separate exec (can fail if schema mismatch on existing table)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        heading, content, chunk_type, file_path
      );

      CREATE TRIGGER IF NOT EXISTS kc_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(rowid, heading, content, chunk_type, file_path)
        SELECT new.id, new.heading, new.content, new.chunk_type, kd.file_path
        FROM knowledge_documents kd WHERE kd.id = new.document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS kc_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, heading, content, chunk_type, file_path)
        SELECT 'delete', old.id, old.heading, old.content, old.chunk_type, kd.file_path
        FROM knowledge_documents kd WHERE kd.id = old.document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS kc_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, heading, content, chunk_type, file_path)
        SELECT 'delete', old.id, old.heading, old.content, old.chunk_type, kd.file_path
        FROM knowledge_documents kd WHERE kd.id = old.document_id;
        INSERT INTO knowledge_fts(rowid, heading, content, chunk_type, file_path)
        SELECT new.id, new.heading, new.content, new.chunk_type, kd.file_path
        FROM knowledge_documents kd WHERE kd.id = new.document_id;
      END;
    `);
  } catch {
    // FTS5 table may already exist with different schema — not fatal
  }

  // ============================================================
  // P1-001 (plan-living-memory-slice-1): embedding companion table for
  // knowledge_chunks. Same design as observation_embeddings in memory-db.ts:
  // a separate droppable table keyed 1:1 to the chunk, storing the
  // (model_id, dim) provenance so mismatched vectors are skippable, and an
  // L2-normalized Float32 little-endian BLOB.
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kc_emb_model ON knowledge_chunk_embeddings(model_id);
  `);
}

// ============================================================
// P2-001 (plan-living-memory-slice-2a-embedder): knowledge-chunk embedding
// writer + sweep. The knowledge-DB half of the ONE structural embed writer;
// the generic loop lives in memory-embed-sweep.ts.
// ============================================================

/**
 * Upsert an L2-normalized embedding for a knowledge chunk into
 * `knowledge_chunk_embeddings` (1:1, keyed by chunk_id), storing the
 * (model_id, dim) provenance.
 */
export function upsertChunkEmbedding(
  db: Database.Database,
  chunkId: number,
  vec: Float32Array,
  modelId: string,
  dim: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO knowledge_chunk_embeddings (chunk_id, model_id, dim, vec, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(chunkId, modelId, dim, float32ToBlob(vec));
}

/** Build the embed text for a knowledge chunk (heading + content). */
function chunkEmbedText(heading: string | null, content: string): string {
  const h = (heading ?? '').trim();
  const c = (content ?? '').trim();
  return h ? `${h}. ${c}` : c;
}

/**
 * Embed all knowledge chunks lacking a matching (model_id, dim) embedding.
 * Fail-open, resumable, and time-boxable — see runEmbedSweep.
 */
export async function embedMissingChunks(
  db: Database.Database,
  opts: EmbedSweepOpts = {},
): Promise<EmbedSweepResult> {
  return runEmbedSweep(
    db,
    {
      embeddingTable: 'knowledge_chunk_embeddings',
      idCol: 'chunk_id',
      metaTable: 'knowledge_meta',
      sourceLabel: 'knowledge_chunk',
      selectMissing: (d, cursor, model, batchSize): SweepRow[] => {
        const rows = model
          ? (d
              .prepare(
                `SELECT c.id AS id, c.heading AS heading, c.content AS content
                 FROM knowledge_chunks c
                 WHERE c.id > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM knowledge_chunk_embeddings e
                     WHERE e.chunk_id = c.id AND e.model_id = ? AND e.dim = ?
                   )
                 ORDER BY c.id LIMIT ?`,
              )
              .all(cursor, model.modelId, model.dim, batchSize) as Array<{
              id: number;
              heading: string | null;
              content: string;
            }>)
          : (d
              .prepare(
                `SELECT c.id AS id, c.heading AS heading, c.content AS content
                 FROM knowledge_chunks c
                 WHERE c.id > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM knowledge_chunk_embeddings e WHERE e.chunk_id = c.id
                   )
                 ORDER BY c.id LIMIT ?`,
              )
              .all(cursor, batchSize) as Array<{
              id: number;
              heading: string | null;
              content: string;
            }>);
        return rows.map((r) => ({ id: r.id, text: chunkEmbedText(r.heading, r.content) }));
      },
    },
    opts,
  );
}

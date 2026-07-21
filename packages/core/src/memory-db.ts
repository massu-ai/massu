// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// @scanner-allow:large-file
// P-M-031 (plan-stage-d-medium-sweep): this file is currently 1633 LOC and
// exceeds the 1000 LOC cap enforced by pattern-scanner Check 21. The
// structural drift-guard (Check 21 itself, shipped in 1.11.0) prevents any
// NEW file from exceeding the cap without an explicit allowlist marker.
// The mechanical decomposition into memory-db/{schema,sessions,...}.ts
// sub-modules is deferred to Stage E so the security-critical P-M items
// ship un-coupled from a high-risk refactor across 30+ exported helpers
// and 600+ tests that import from this module's surface. Removing this
// marker requires shipping the sub-module split — there is no alternative
// escape path.

import type Database from 'better-sqlite3';
import { openDatabase } from './lib/sqlite-loader.ts';
import { resolve, dirname, basename } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getConfig, getResolvedPaths, getProjectRoot } from './config.ts';
import { float32ToBlob } from './memory-vector.ts';
import { backupBeforeSchemaChange } from './db-backup.ts';
// Layer 2: the funnel-telemetry cap. Trims TELEMETRY only and announces the trim —
// learned rules live under the lease/ack contract and are never dropped.
import { capTelemetry, migrateRuleDelivery } from './rule-delivery.ts';
// D-11: rule candidates are rows, not loose files.
import { ensureRuleCandidatesTable } from './rule-candidate-store.ts';
import { recordHookFailure } from './hooks/lib/hook-failure-signal.ts';
import {
  runEmbedSweep,
  type SweepRow,
  type EmbedSweepOpts,
  type EmbedSweepResult,
} from './memory-embed-sweep.ts';

/**
 * Sanitize a user-provided query string for use with SQLite FTS5 MATCH.
 * Wraps each token in double quotes to treat them as literals,
 * preventing FTS5 operator injection (AND, OR, NOT, NEAR, *, etc.).
 */
export function sanitizeFts5Query(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '""';
  // Remove any existing double quotes, then wrap each whitespace-separated token
  const tokens = trimmed.replace(/"/g, '').split(/\s+/).filter(Boolean);
  return tokens.map(t => `"${t}"`).join(' ');
}

/**
 * Like {@link sanitizeFts5Query} but joins tokens with the FTS5 `OR` operator
 * so a natural-language query recalls documents matching ANY term (recall-
 * oriented) rather than ALL terms (implicit-AND, precision-oriented). Used by
 * the hybrid-search candidate channel (plan-living-memory-slice-1) where a
 * downstream ranker (BM25 × recency × importance × RRF) re-orders the recalled
 * set — so wide candidate recall + precise ranking beats strict AND matching.
 *
 * Short/common tokens (< 3 chars) are dropped to cut stopword noise. Returns
 * '""' when nothing usable remains (caller then skips the BM25 channel).
 */
export function sanitizeFts5QueryOr(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '""';
  const tokens = trimmed
    .replace(/"/g, '')
    .split(/\s+/)
    .filter((t) => t.replace(/[^a-zA-Z0-9]/g, '').length >= 3);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// ============================================================
// P1-001: Memory Database Schema
// ============================================================

/**
 * The memory schema's version. **BUMP THIS whenever the DDL below changes** (a new
 * table, column, index, or trigger).
 *
 * It is the trigger for the pre-DDL backup (incident 2026-07-13). It lives in
 * `PRAGMA user_version`, deliberately: that pragma is readable BEFORE any table exists,
 * so it works on a database whose schema is broken — which is precisely the case we
 * must survive. A version row inside a table would be unreadable at exactly the moment
 * we need it.
 *
 * A drift-guard (`db-backup-schema-version-drift-guard.test.ts`) fingerprints the DDL
 * text and FAILS if it changed without this constant being bumped — otherwise a future
 * schema change would skip its backup silently, which is the whole bug class.
 *
 * v1 = the schema as of 2026-07-13 (the first version to carry a backup gate at all).
 */
export const MEMORY_SCHEMA_VERSION = 1;

/**
 * Connection to the memory SQLite database.
 * Stores session memory, observations, and observability data.
 */
export function getMemoryDb(): Database.Database {
  const dbPath = getResolvedPaths().memoryDbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // INCIDENT 2026-07-13: adding ONE table to the live 135 MB memory.db corrupted it —
  // "invalid rootpage" — and every query failed. It was recovered only because a copy
  // happened to exist, taken earlier in the same session for an unrelated reason.
  // "We got lucky" is not a control.
  //
  // So: before this process is allowed to run DDL against an EXISTING database, take a
  // verified snapshot. Gated on the schema VERSION, not on every open — a 197 MB
  // VACUUM INTO on all 10 DB-touching hooks, on every tool call, would be absurd. The
  // backup fires only when the schema is genuinely about to change, which is exactly
  // when the risk exists.
  const preExisting = existsSync(dbPath);

  const db = openDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const onDisk = db.pragma('user_version', { simple: true }) as number;
  if (preExisting && onDisk !== MEMORY_SCHEMA_VERSION) {
    // Fail-OPEN (a failed backup must never take the user's session down) but LOUD
    // (G-2: broken may never be quiet). Every existing database has user_version 0, so
    // the first open after this ships takes one backup — correctly: those databases
    // have never had one.
    backupBeforeSchemaChange(getProjectRoot(), dbPath, (err) =>
      recordHookFailure('memory-db:pre-ddl-backup', err, { dbPath, onDisk }),
    );
  }

  initMemorySchema(db);

  if (onDisk !== MEMORY_SCHEMA_VERSION) {
    db.pragma(`user_version = ${MEMORY_SCHEMA_VERSION}`);
  }
  return db;
}

/**
 * P-E-014 (plan-stage-e-low-info-sweep, wave1-hooks:F-HOOK-009).
 *
 * Tool-cost-event retention policy: 90 days. Without this the
 * `tool_cost_events` table grows unbounded — customers running for
 * months accumulate multi-GB memory.db files.
 *
 * Exported for the session-start hook to call once per session
 * (cheap; uses idx_tce_created index). Returns the number of rows
 * deleted so callers can log.
 */
export const TOOL_COST_EVENTS_RETENTION_DAYS = 90;

export function pruneToolCostEvents(db: Database.Database): number {
  const result = db.prepare(
    `DELETE FROM tool_cost_events WHERE created_at < datetime('now', '-' || ? || ' days')`
  ).run(TOOL_COST_EVENTS_RETENTION_DAYS);
  return result.changes;
}

/**
 * plan-v0.2-interactive-rule-approval P-C-001: Audit-log event_type CHECK
 * extension migration.
 *
 * SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`. Extending the CHECK
 * constraint to add the three new interactive-funnel event types
 * (`rule_candidate_emitted`, `rule_promoted`, `rule_dismissed`) requires
 * the canonical 12-step recreate procedure:
 *   1. Detect old CHECK via sqlite_master.
 *   2. PRAGMA foreign_keys = OFF (recreate would cascade-delete sessions).
 *   3. BEGIN TRANSACTION.
 *   4. CREATE TABLE audit_log_new with the 9-value CHECK.
 *   5. INSERT INTO audit_log_new SELECT * FROM audit_log.
 *   6. DROP TABLE audit_log.
 *   7. ALTER TABLE audit_log_new RENAME TO audit_log.
 *   8. Recreate indexes on the new table.
 *   9. COMMIT.
 *  10. PRAGMA foreign_keys = ON.
 *  11. (Idempotent — re-running on a current-schema DB is a no-op.)
 *  12. Verified by `audit-log-event-type-migration.test.ts` (P-C-001 acceptance).
 *
 * Rollback path (committed alongside as
 * `packages/core/src/migrations/down/2026-05-20-audit-log-event-type-revert.sql`):
 * re-run with the 6 original values, DELETEing any rows whose event_type is
 * one of the 3 new values BEFORE the INSERT SELECT.
 */
/**
 * A-04 — widen `observation_embeddings` from 1-vector-per-observation to
 * 1-vector-per-CHUNK. Idempotent: a no-op once `chunk_ix` exists.
 *
 * Existing vectors are preserved as `chunk_ix = 0` (they ARE the first chunk — the
 * first ~256 tokens is exactly what the old single vector covered), so no re-embed is
 * forced; the sweep fills in the missing chunks on its next pass.
 */
export function migrateObservationEmbeddingChunks(db: Database.Database): void {
  const cols = db.pragma('table_info(observation_embeddings)') as Array<{ name: string }>;
  if (cols.length === 0) return; // table absent; the CREATE above already has chunk_ix
  if (cols.some((c) => c.name === 'chunk_ix')) return; // already migrated

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec(`
      CREATE TABLE observation_embeddings_new (
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        chunk_ix INTEGER NOT NULL DEFAULT 0,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (observation_id, model_id, dim, chunk_ix)
      );
      INSERT INTO observation_embeddings_new
        (observation_id, chunk_ix, model_id, dim, vec, created_at)
        SELECT observation_id, 0, model_id, dim, vec, created_at FROM observation_embeddings;
      DROP TABLE observation_embeddings;
      ALTER TABLE observation_embeddings_new RENAME TO observation_embeddings;
      CREATE INDEX IF NOT EXISTS idx_obs_emb_model ON observation_embeddings(model_id);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * B-00 — the columns 4B needs on a database that already exists.
 *
 * `CREATE TABLE IF NOT EXISTS` adds NO columns to a table that is already there.
 * Every machine that soaked 4A already has `memory_files` and `observations`, so
 * without this migration every 4B query throws `no such column` — and it throws
 * INSIDE the renderer's write transaction, i.e. mid-way through writing to the
 * operator's irreplaceable corpus.
 *
 * `observations.origin` is the SOURCE-row flag (B-10/F-08/N-03). It is deliberately
 * NOT on `memory_files`: that table is the OUTPUT projection, and a row exists there
 * only for a file that has ALREADY been rendered. A memory synced from another repo
 * (Slice 5) arrives as an `observations` row with no `memory_files` row at all, so a
 * gate reading the projection would check a row that does not exist and never fire.
 *
 * Idempotent: re-running on a migrated DB is a no-op (PRAGMA table_info guard).
 */
export function migrateMemoryFilesFor4B(db: Database.Database): void {
  const ADDITIONS: ReadonlyArray<{ table: string; name: string; decl: string }> = [
    // The renderer's authorship credential (OD-1). NULL on every pre-existing row,
    // which is the safe direction: no MAC ⇒ unverifiable ⇒ the file is HUMAN.
    { table: 'memory_files', name: 'massu_render_mac', decl: 'TEXT' },
    // F-15 stickiness: once a file is human, only `massu memory adopt` reverses it.
    { table: 'memory_files', name: 'adopted_human_at_epoch', decl: 'INTEGER' },
    // OD-2: a CACHE of `.massu-tombstones.jsonl`. The ledger is the source of truth.
    { table: 'memory_files', name: 'tombstoned_at_epoch', decl: 'INTEGER' },
    { table: 'memory_files', name: 'origin', decl: "TEXT NOT NULL DEFAULT 'local'" },
    { table: 'memory_files', name: 'render_suppressed', decl: 'INTEGER NOT NULL DEFAULT 0' },
    // N-03 — the SOURCE row. This is the one F-08 actually requires.
    { table: 'observations', name: 'origin', decl: "TEXT NOT NULL DEFAULT 'local'" },
  ];

  for (const add of ADDITIONS) {
    const cols = db.prepare(`PRAGMA table_info(${add.table})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue; // table absent; the CREATE above already has it
    if (cols.some((c) => c.name === add.name)) continue; // already migrated
    db.exec(`ALTER TABLE ${add.table} ADD COLUMN ${add.name} ${add.decl}`);
  }
}

export function migrateAuditLogCheckExtension(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'")
    .get() as { sql: string } | undefined;
  if (!row) return; // No table yet; CREATE TABLE block already used new CHECK.

  // ARCH-06 fix: prefer a CHECK clause-shape parse over fragile substring
  // match. Parse the IN (...) clause of the event_type CHECK constraint
  // and verify all 9 expected values are present. If they are, the
  // migration is already applied — return without rewriting the table.
  const expected = [
    'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
    'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed',
    // A-19/N-02 — without these the memory-file events throw a CHECK violation.
    // In the ingest path the throw is swallowed by a bare catch, so observability
    // silently produces NOTHING; in the renderer's transaction it ROLLS BACK a
    // legitimate render. This migration is what lets an EXISTING db accept them.
    'memory_file_ingested', 'memory_file_expired', 'memory_file_adopted_human',
    'memory_file_rendered', 'memory_file_render_refused', 'memory_file_tombstoned',
  ];
  const checkClauseMatch = row.sql.match(/event_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*event_type\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
  if (checkClauseMatch) {
    const values = (checkClauseMatch[1].match(/'([^']+)'/g) ?? []).map(s => s.slice(1, -1));
    if (expected.every(v => values.includes(v))) return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec(`
      CREATE TABLE audit_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now')),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
          'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed',
          'memory_file_ingested', 'memory_file_expired', 'memory_file_adopted_human',
          'memory_file_rendered', 'memory_file_render_refused', 'memory_file_tombstoned'
        )),
        actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
        model_id TEXT,
        file_path TEXT,
        change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
        rules_in_effect TEXT,
        approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
        evidence TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO audit_log_new SELECT * FROM audit_log;
      DROP TABLE audit_log;
      ALTER TABLE audit_log_new RENAME TO audit_log;
      CREATE INDEX IF NOT EXISTS idx_al_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_al_file ON audit_log(file_path);
      CREATE INDEX IF NOT EXISTS idx_al_event ON audit_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_al_timestamp ON audit_log(timestamp DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_rule_promoted
        ON audit_log (event_type, json_extract(metadata, '$.prompt_hash'))
        WHERE event_type = 'rule_promoted';
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function initMemorySchema(db: Database.Database): void {
  db.exec(`
    -- Sessions table (linked to Claude Code session IDs)
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL DEFAULT 'my-project',
      git_branch TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT,
      ended_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'abandoned')) NOT NULL DEFAULT 'active',
      plan_file TEXT,
      plan_phase TEXT,
      task_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);

    -- Observations table (structured knowledge from tool usage)
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'decision', 'bugfix', 'feature', 'refactor', 'discovery',
        'cr_violation', 'vr_check', 'pattern_compliance', 'failed_attempt',
        'file_change', 'incident_near_miss'
      )),
      title TEXT NOT NULL,
      detail TEXT,
      files_involved TEXT DEFAULT '[]',
      plan_item TEXT,
      cr_rule TEXT,
      vr_type TEXT,
      evidence TEXT,
      importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
      recurrence_count INTEGER NOT NULL DEFAULT 1,
      original_tokens INTEGER DEFAULT 0,
      -- B-10/F-08/N-03: the SOURCE-row provenance flag. The renderer refuses any
      -- row whose origin is not 'local' BEFORE it computes a path, mints a
      -- credential, or takes a snapshot. A Slice-5 synced memory arrives here with
      -- origin='team' and must never reach disk without CR-55's gates.
      origin TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_plan_item ON observations(plan_item);
    CREATE INDEX IF NOT EXISTS idx_observations_cr_rule ON observations(cr_rule);
    CREATE INDEX IF NOT EXISTS idx_observations_importance ON observations(importance DESC);
  `);

  // FTS5 tables - create separately to handle "already exists" gracefully
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, detail, evidence,
        content='observations',
        content_rowid='id'
      );
    `);
  } catch (_e) {
    // FTS5 table may already exist with different schema - ignore
  }

  // FTS5 sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, detail, evidence)
      VALUES (new.id, new.title, new.detail, new.evidence);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, detail, evidence)
      VALUES ('delete', old.id, old.title, old.detail, old.evidence);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, detail, evidence)
      VALUES ('delete', old.id, old.title, old.detail, old.evidence);
      INSERT INTO observations_fts(rowid, title, detail, evidence)
      VALUES (new.id, new.title, new.detail, new.evidence);
    END;
  `);

  // Session summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      decisions TEXT,
      completed TEXT,
      failed_attempts TEXT,
      next_steps TEXT,
      files_created TEXT DEFAULT '[]',
      files_modified TEXT DEFAULT '[]',
      verification_results TEXT DEFAULT '{}',
      plan_progress TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_session ON session_summaries(session_id);
  `);

  // User prompts
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `);
  } catch (_e) {
    // FTS5 table may already exist
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;

    CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
      VALUES ('delete', old.id, old.prompt_text);
    END;
  `);

  // Metadata
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ============================================================
  // Retrieval-usage counters (P1-001, plan-living-memory-slice-3-consolidation)
  //
  // Which memories actually reach the model's context. This is the signal the
  // consolidation pass uses to reweight (promote what earns its keep) and to
  // expire (retire what never once proved useful) — so it MUST be honest:
  //
  //   - Keyed (source, record_id): HybridSearchResult.id is unique only PER
  //     SOURCE (memory-hybrid-search.ts:34-42), never globally.
  //   - `memory_usage_sessions` caps a record at ONE hit per session. A raw
  //     per-recall counter would measure session VERBOSITY, not usefulness —
  //     one long session about topic X would hand the same 8 rows +30 hits.
  //   - `hits_windowed` DECAYS each consolidation pass, so usefulness has to be
  //     SUSTAINED. Without decay, a single accidental retrieval in 2026 would
  //     grant a junk row permanent immunity from expiry, forever.
  //   - `last_reweight_epoch` is the idempotency watermark: the demotion
  //     predicate ("old + never retrieved") stays TRUE after a demotion, so
  //     without this a second run one minute later would demote the same row
  //     again (3 -> 2 -> 1) and the pass would not be idempotent.
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_usage (
      source TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      hits_windowed REAL NOT NULL DEFAULT 0,
      last_hit_epoch INTEGER,
      last_reweight_epoch INTEGER,
      PRIMARY KEY (source, record_id)
    );

    CREATE TABLE IF NOT EXISTS memory_usage_sessions (
      source TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (source, record_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_usage_hits
      ON memory_usage(source, hits_windowed DESC);
  `);

  // ============================================================
  // Observability tables (P1-001, P1-002)
  // ============================================================

  // P1-001: Conversation turns (full session replay)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_response TEXT,
      tool_calls_json TEXT,
      tool_call_count INTEGER DEFAULT 0,
      model_used TEXT,
      duration_ms INTEGER,
      prompt_tokens INTEGER,
      response_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      created_at_epoch INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ct_session ON conversation_turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_ct_created ON conversation_turns(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ct_turn ON conversation_turns(session_id, turn_number);
  `);

  // P1-002: Tool call details (analytics)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input_summary TEXT,
      tool_input_size INTEGER,
      tool_output_size INTEGER,
      tool_success INTEGER DEFAULT 1,
      duration_ms INTEGER,
      files_involved TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      created_at_epoch INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tcd_session ON tool_call_details(session_id);
    CREATE INDEX IF NOT EXISTS idx_tcd_tool ON tool_call_details(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tcd_created ON tool_call_details(created_at DESC);
  `);

  // P1-003: FTS5 index for conversation turns
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
        user_prompt,
        assistant_response,
        content=conversation_turns,
        content_rowid=id
      );
    `);
  } catch (_e) {
    // FTS5 table may already exist with different schema
  }

  // FTS5 sync triggers for conversation_turns
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ct_fts_insert AFTER INSERT ON conversation_turns BEGIN
      INSERT INTO conversation_turns_fts(rowid, user_prompt, assistant_response)
      VALUES (new.id, new.user_prompt, new.assistant_response);
    END;

    CREATE TRIGGER IF NOT EXISTS ct_fts_delete AFTER DELETE ON conversation_turns BEGIN
      INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_prompt, assistant_response)
      VALUES ('delete', old.id, old.user_prompt, old.assistant_response);
    END;

    CREATE TRIGGER IF NOT EXISTS ct_fts_update AFTER UPDATE ON conversation_turns BEGIN
      INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_prompt, assistant_response)
      VALUES ('delete', old.id, old.user_prompt, old.assistant_response);
      INSERT INTO conversation_turns_fts(rowid, user_prompt, assistant_response)
      VALUES (new.id, new.user_prompt, new.assistant_response);
    END;
  `);

  // ============================================================
  // PLAN-02 Enhancement Tables (Analytics, Governance, Security, Team, Regression)
  // ============================================================

  // P1-001: Quality scores per session
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL DEFAULT 'my-project',
      score INTEGER NOT NULL DEFAULT 100,
      security_score INTEGER NOT NULL DEFAULT 100,
      architecture_score INTEGER NOT NULL DEFAULT 100,
      coupling_score INTEGER NOT NULL DEFAULT 100,
      test_score INTEGER NOT NULL DEFAULT 100,
      rule_compliance_score INTEGER NOT NULL DEFAULT 100,
      observations_total INTEGER NOT NULL DEFAULT 0,
      bugs_found INTEGER NOT NULL DEFAULT 0,
      bugs_fixed INTEGER NOT NULL DEFAULT 0,
      vr_checks_passed INTEGER NOT NULL DEFAULT 0,
      vr_checks_failed INTEGER NOT NULL DEFAULT 0,
      incidents_triggered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sqs_session ON session_quality_scores(session_id);
    CREATE INDEX IF NOT EXISTS idx_sqs_project ON session_quality_scores(project);
  `);

  // P1-002: Cost tracking per session
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL DEFAULT 'my-project',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      model TEXT,
      duration_minutes REAL NOT NULL DEFAULT 0.0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sc_session ON session_costs(session_id);
  `);

  // P1-002: Feature cost attribution
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fc_feature ON feature_costs(feature_key);
    CREATE INDEX IF NOT EXISTS idx_fc_session ON feature_costs(session_id);
  `);

  // P1-003: Prompt effectiveness outcomes
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_category TEXT NOT NULL DEFAULT 'feature',
      word_count INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'partial', 'failure', 'abandoned')),
      corrections_needed INTEGER NOT NULL DEFAULT 0,
      follow_up_prompts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_po_session ON prompt_outcomes(session_id);
    CREATE INDEX IF NOT EXISTS idx_po_category ON prompt_outcomes(prompt_category);
  `);

  // P2-001: Compliance audit log
  // plan-v0.2-interactive-rule-approval P-C-001 / P-C-003:
  //   CHECK constraint extended from 6 → 9 event_type values to support the
  //   interactive rule-approval funnel (`rule_candidate_emitted`,
  //   `rule_promoted`, `rule_dismissed`). Fresh DBs pick up the 9-value list
  //   via this CREATE; existing DBs are migrated via
  //   `migrateAuditLogCheckExtension()` below (SQLite has no ALTER CONSTRAINT).
  //   The UNIQUE INDEX on (event_type, json_extract(metadata, '$.prompt_hash'))
  //   WHERE event_type='rule_promoted' is the §5 idempotency lock: a second
  //   approve of the same prompt_hash is a no-op.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
        'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed',
        'memory_file_ingested', 'memory_file_expired', 'memory_file_adopted_human',
        'memory_file_rendered', 'memory_file_render_refused', 'memory_file_tombstoned'
      )),
      actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
      model_id TEXT,
      file_path TEXT,
      change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
      rules_in_effect TEXT,
      approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
      evidence TEXT,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_al_session ON audit_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_al_file ON audit_log(file_path);
    CREATE INDEX IF NOT EXISTS idx_al_event ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_al_timestamp ON audit_log(timestamp DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_rule_promoted
      ON audit_log (event_type, json_extract(metadata, '$.prompt_hash'))
      WHERE event_type = 'rule_promoted';
  `);

  // G-2 (plan-silent-failure-remediation): HOOK HEALTH.
  // A hook may fail; a hook may NOT fail silently. Every hook's outer catch now
  // writes here (and to .massu/hook-failures.jsonl, and to stderr) instead of
  // exiting 0 with zero bytes written.
  //
  // WHY: all 18 hooks were fired against a destroyed DB. All 18 exited 0. Not one
  // wrote a byte anywhere. post-tool-use then died on 96% of real tool calls for
  // months — 251,956 tool calls, 0 observations — and nothing, anywhere, said so.
  // Read by `massu doctor`, the Guardian hook-health watcher, and the reality gate
  // (which FAILS THE BUILD if this table is non-empty).
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hook TEXT NOT NULL,
      error TEXT NOT NULL,
      context_json TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hook_health_hook ON hook_health(hook);
    CREATE INDEX IF NOT EXISTS idx_hook_health_time ON hook_health(occurred_at DESC);
  `);

  // plan-v0.2-interactive-rule-approval P-C-002: Signal blacklist for the
  // dismissal-loop downweighting (rule-candidate-detector.ts reads this map
  // via the user-prompt hook). Per-signal dismissal count; >=5 → permanent
  // blacklist (signal contributes 0 points).
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_outcomes_signal_blacklist (
      signal TEXT PRIMARY KEY,
      dismissal_count INTEGER NOT NULL DEFAULT 0,
      first_dismissed_at TEXT DEFAULT (datetime('now')),
      last_dismissed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_psb_count
      ON prompt_outcomes_signal_blacklist(dismissal_count DESC);
  `);

  // P-C-001 migration: extend audit_log CHECK constraint on existing DBs
  // that pre-date the 9-value enum. Idempotent — no-op when CHECK is current.
  migrateAuditLogCheckExtension(db);

  // ============================================================
  // A-02 — `memory_files`: the LOSSLESS mirror of the markdown corpus.
  //
  // The `observations` row stays as the recall/search PROJECTION (title +
  // detail). The FILE ITSELF lives here, whole.
  //
  // Why `raw` and not just a parsed body: today's ingest destroys bytes BEFORE
  // the 500-char clamp (`.trim()`), and re-serializing YAML loses key order,
  // comments, and quoting style. 45 of the operator's 69 memories carry
  // `[[wiki-links]]` that no code parses. The ONLY way a round-trip is lossless
  // by construction is to keep the verbatim bytes and parse into projections
  // ADDITIONALLY, never INSTEAD.
  //
  // Identity is the PATH, not the frontmatter `name`:
  //   - `name` is human-editable, NOT unique, and 3 real memories contain a '/'.
  //   - COLLATE NOCASE because macOS and Windows fold case: `Foo.md` and `foo.md`
  //     are ONE file on disk, and the store must not believe they are two.
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      raw TEXT NOT NULL,
      frontmatter_json TEXT,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      ingest_schema_version INTEGER NOT NULL DEFAULT 1,
      massu_authored INTEGER NOT NULL DEFAULT 0,
      massu_render_mac TEXT,
      adopted_human_at_epoch INTEGER,
      tombstoned_at_epoch INTEGER,
      origin TEXT NOT NULL DEFAULT 'local',
      render_suppressed INTEGER NOT NULL DEFAULT 0,
      observation_id INTEGER,
      synced_at_epoch INTEGER,
      expired_at_epoch INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mf_hash ON memory_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_mf_expired ON memory_files(expired_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_mf_obs ON memory_files(observation_id);
  `);

  // P2-002: Validation results
  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      validation_type TEXT NOT NULL,
      passed INTEGER NOT NULL DEFAULT 1,
      details TEXT,
      rules_violated TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vr_session ON validation_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_vr_file ON validation_results(file_path);
  `);

  // P2-003: Architecture decisions
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT,
      decision TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'superseded', 'deprecated')),
      alternatives TEXT,
      consequences TEXT,
      affected_files TEXT,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ad_session ON architecture_decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_ad_status ON architecture_decisions(status);
  `);

  // P3-001: Security scores per file
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      risk_score INTEGER NOT NULL DEFAULT 0,
      findings TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ss_session ON security_scores(session_id);
    CREATE INDEX IF NOT EXISTS idx_ss_file ON security_scores(file_path);
  `);

  // P3-002: Dependency assessments
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependency_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name TEXT NOT NULL,
      version TEXT,
      risk_score INTEGER NOT NULL DEFAULT 0,
      vulnerabilities INTEGER NOT NULL DEFAULT 0,
      last_publish_days INTEGER,
      weekly_downloads INTEGER,
      license TEXT,
      bundle_size_kb INTEGER,
      previous_removals INTEGER NOT NULL DEFAULT 0,
      assessed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_da_package ON dependency_assessments(package_name);
  `);

  // P4-001: Developer expertise
  db.exec(`
    CREATE TABLE IF NOT EXISTS developer_expertise (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      developer_id TEXT NOT NULL,
      module TEXT NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      observation_count INTEGER NOT NULL DEFAULT 0,
      expertise_score INTEGER NOT NULL DEFAULT 0,
      last_active TEXT DEFAULT (datetime('now')),
      UNIQUE(developer_id, module)
    );
    CREATE INDEX IF NOT EXISTS idx_de_developer ON developer_expertise(developer_id);
    CREATE INDEX IF NOT EXISTS idx_de_module ON developer_expertise(module);
  `);

  // P4-001: Shared observations for team knowledge
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER,
      developer_id TEXT NOT NULL,
      project TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      file_path TEXT,
      module TEXT,
      severity INTEGER NOT NULL DEFAULT 3,
      is_shared INTEGER NOT NULL DEFAULT 0,
      shared_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_so_developer ON shared_observations(developer_id);
    CREATE INDEX IF NOT EXISTS idx_so_file ON shared_observations(file_path);
    CREATE INDEX IF NOT EXISTS idx_so_module ON shared_observations(module);
  `);

  // PB-006/PB-016 (plan-2026-05-28-team-shared-rule-promotion): outbound stores
  // for team-shared rule promotions / revocations. The applier's publish branch
  // (PB-005) enqueues a row here on a Team seat after a successful local
  // promotion; the session-end hook (PB-006) drains them into the /sync payload's
  // `rule_promotions[]` / `rule_revocations[]`. UNIQUE(prompt_hash) makes
  // re-enqueue idempotent; the server upsert + client dedup make a double-send
  // harmless (T4).
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_promotion_outbound (
      prompt_hash TEXT PRIMARY KEY,
      destination TEXT NOT NULL,
      draft_text TEXT NOT NULL,
      score REAL,
      signals_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      -- PA3-004 (Phase 3 Stream A): hardened-destination publish carries the
      -- publisher's review attestation so the server CHECK (hardened rows need a
      -- review_attestation) is satisfiable. hardened=0 for the Phase-2 rows.
      hardened INTEGER NOT NULL DEFAULT 0,
      review_attestation_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS team_revocation_outbound (
      prompt_hash TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // P1-002 (plan-2026-06-01-auto-learning-analytics-dashboard): outbound store
  // for the promotion FUNNEL events (proposed/shown/approved/dismissed) that
  // power the auto-learning analytics dashboard. Unlike team_promotion_outbound
  // (idempotent per prompt_hash), this is APPEND-ONLY: a single prompt_hash can
  // accrue many events (and repeats of the same type — e.g. `shown` twice), so
  // the PK is an autoincrement id, not the prompt_hash. Drained at session end
  // into SyncPayload.rule_promotion_events[]; the server attests org_id/user_id
  // (`revoked` is NOT here — it's already a tombstone on promoted_rules.revoked_at).
  // Privacy: metadata only, never draft_text/detail/secrets.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_promotion_events_outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rpe_outbound_created ON rule_promotion_events_outbound(created_at);
  `);

  // CR-9 latent-bug fix (surfaced during PB-006/H5 implementation): the local
  // telemetry sink `analytics_events` was INSERTed-into in two places
  // (dequeuePendingSync P-H012 give-up event + recordTelemetry H5 dropped-envelope
  // event) but NEVER created in any schema — both inserts silently no-op'd inside
  // their try/catch, leaving the observability channel dead. Create it here so the
  // telemetry is real (matches the "may not exist in older schemas" comments,
  // which assumed current schemas DO have it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
  `);

  // P4-001: Knowledge conflicts
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      developer_a TEXT NOT NULL,
      developer_b TEXT NOT NULL,
      conflict_type TEXT NOT NULL DEFAULT 'concurrent_edit',
      resolved INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kc_file ON knowledge_conflicts(file_path);
  `);

  // P4-002: Feature health tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL UNIQUE,
      health_score INTEGER NOT NULL DEFAULT 100,
      tests_passing INTEGER NOT NULL DEFAULT 0,
      tests_failing INTEGER NOT NULL DEFAULT 0,
      test_coverage_pct REAL,
      modifications_since_test INTEGER NOT NULL DEFAULT 0,
      last_modified TEXT,
      last_tested TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fh_feature ON feature_health(feature_key);
    CREATE INDEX IF NOT EXISTS idx_fh_health ON feature_health(health_score);
  `);

  // ============================================================
  // Hook Tables (cost-tracker.ts, quality-event.ts)
  // ============================================================

  // Tool-level cost events (one row per tool call)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_cost_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      estimated_input_tokens INTEGER DEFAULT 0,
      estimated_output_tokens INTEGER DEFAULT 0,
      model TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tce_session ON tool_cost_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_tce_tool ON tool_cost_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tce_created ON tool_cost_events(created_at DESC);
  `);

  // Quality signal events (test failures, type errors, build failures)
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_qe_session ON quality_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_qe_event_type ON quality_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_qe_created ON quality_events(created_at DESC);
  `);

  // ============================================================
  // Cloud Sync: Pending sync queue (offline resilience)
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_sync_created ON pending_sync(created_at ASC);
  `);

  // ============================================================
  // P3-005: License cache table
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS license_cache (
      api_key_hash TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      last_validated TEXT NOT NULL,
      features TEXT DEFAULT '[]'
    );
  `);

  // P-M-023 (plan-stage-d-medium-sweep): in-place schema upgrade — store the
  // entire signed /validate-key wire payload so cache reads can re-verify
  // the Ed25519 signature. Closes the bug class where a user could edit
  // tier/valid_until directly in SQLite to grant arbitrary tier. The signed
  // payload is the only authoritative source; the plain columns are read
  // only as a back-compat fallback for rows written before this migration.
  //
  // SQLite's ALTER TABLE ... ADD COLUMN does not support IF NOT EXISTS, so
  // we PRAGMA-introspect and add only when missing. Idempotent across
  // repeated initMemorySchema calls.
  const licenseCacheCols = db
    .prepare(`PRAGMA table_info(license_cache)`)
    .all() as Array<{ name: string }>;
  if (!licenseCacheCols.some((c) => c.name === 'signed_payload_json')) {
    db.exec(
      `ALTER TABLE license_cache ADD COLUMN signed_payload_json TEXT NOT NULL DEFAULT ''`,
    );
  }

  // PA3-004 (Phase 3 Stream A): additive hardened-promotion columns on the
  // outbound queue for existing local DBs (CREATE TABLE IF NOT EXISTS does not
  // add columns to a pre-existing table). PRAGMA-introspect + ADD COLUMN, the
  // same idempotent pattern as signed_payload_json above.
  const outboundCols = db
    .prepare(`PRAGMA table_info(team_promotion_outbound)`)
    .all() as Array<{ name: string }>;
  if (!outboundCols.some((c) => c.name === 'hardened')) {
    db.exec(`ALTER TABLE team_promotion_outbound ADD COLUMN hardened INTEGER NOT NULL DEFAULT 0`);
  }
  if (!outboundCols.some((c) => c.name === 'review_attestation_json')) {
    db.exec(`ALTER TABLE team_promotion_outbound ADD COLUMN review_attestation_json TEXT`);
  }

  // P1-002 (plan-living-memory-slice-3-consolidation): consolidation stamp on
  // `sessions`. Same PRAGMA-introspect + ADD COLUMN idiom as above.
  //
  // `consolidated_status` distinguishes two very different outcomes:
  //   'summarized' — the session's turns were distilled into a durable lesson.
  //   'no_turns'   — the turns were ALREADY hard-pruned (server.ts prunes
  //                  conversation_turns at 7 days) before consolidation ever
  //                  saw them. Without this stamp such a session matches no
  //                  MAX(turn epoch) predicate, so it would be rescanned
  //                  forever while its lesson is silently lost. Stamping it
  //                  retires it from the scan AND makes the loss COUNTABLE
  //                  (ConsolidationResult.sessionsMissed -> a Guardian warning,
  //                  instead of a green heartbeat over a lossy pass).
  const sessionCols = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols.some((c) => c.name === 'consolidated_at')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN consolidated_at TEXT`);
  }
  if (!sessionCols.some((c) => c.name === 'consolidated_at_epoch')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN consolidated_at_epoch INTEGER`);
  }
  if (!sessionCols.some((c) => c.name === 'consolidated_status')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN consolidated_status TEXT`);
  }

  // ============================================================
  // P1-001..003 (plan-living-memory-slice-2-temporal-model): bi-temporal
  // validity on the two accumulating memory stores (observations +
  // architecture_decisions). Zep-style four timestamps + a successor link:
  //   valid_from / valid_to   = EVENT time (when the fact became / stopped being true)
  //   ingested_at / expired_at = TRANSACTION time (when we recorded / retracted it)
  //   superseded_by            = id of the successor record (supersede-don't-delete)
  // Each timestamp is stored TWICE: a human/display TEXT column and an
  // epoch-SECONDS INTEGER companion (mirroring created_at + created_at_epoch,
  // which this codebase stores in SECONDS — hybrid-search does epoch*1000 to
  // get ms). ALL range/asOf predicates compare the *_epoch INTEGER columns —
  // comparing a TEXT column to a numeric literal would make SQLite do a broken
  // string compare. NULL valid_to/expired_at = "still valid / live". SQLite ADD
  // COLUMN has no IF NOT EXISTS, so PRAGMA-introspect + add-when-missing,
  // idempotent across repeated initMemorySchema calls.
  const BITEMPORAL_COLUMNS: Array<{ name: string; type: string }> = [
    { name: 'valid_from', type: 'TEXT' },
    { name: 'valid_to', type: 'TEXT' },
    { name: 'ingested_at', type: 'TEXT' },
    { name: 'expired_at', type: 'TEXT' },
    { name: 'valid_from_epoch', type: 'INTEGER' },
    { name: 'valid_to_epoch', type: 'INTEGER' },
    { name: 'ingested_at_epoch', type: 'INTEGER' },
    { name: 'expired_at_epoch', type: 'INTEGER' },
    { name: 'superseded_by', type: 'INTEGER' },
  ];
  for (const table of ['observations', 'architecture_decisions']) {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    for (const col of BITEMPORAL_COLUMNS) {
      if (!cols.some((c) => c.name === col.name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
      }
    }
  }
  // One-time, idempotent backfill of pre-existing rows to "valid now, never
  // expired" (WHERE valid_from_epoch IS NULL makes re-runs 0-row no-ops).
  // observations already carry created_at_epoch (seconds); architecture_decisions
  // store only a created_at TEXT in datetime('now') format, so derive its epoch
  // via strftime('%s', …) which already returns SECONDS (no *1000).
  db.exec(`
    UPDATE observations
       SET valid_from = created_at,
           ingested_at = created_at,
           valid_from_epoch = created_at_epoch,
           ingested_at_epoch = created_at_epoch
     WHERE valid_from_epoch IS NULL;
  `);
  db.exec(`
    UPDATE architecture_decisions
       SET valid_from = created_at,
           ingested_at = created_at,
           valid_from_epoch = CAST(strftime('%s', created_at) AS INTEGER),
           ingested_at_epoch = CAST(strftime('%s', created_at) AS INTEGER)
     WHERE valid_from_epoch IS NULL AND created_at IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observations_expired ON observations(expired_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_ad_expired ON architecture_decisions(expired_at_epoch);
  `);
  // Temporal stamping is done at INSERT time in addObservation()/storeDecision()
  // GATED on the columns actually existing (memoryTableHasTemporal below), NOT
  // via an AFTER INSERT trigger: a self-UPDATE trigger fires the external-content
  // FTS5 sync trigger and corrupts the FTS index ("database disk image is
  // malformed"). Column-gated INSERT keeps a single write statement, no FTS
  // churn, and leaves callers/tests on a pre-temporal table working untouched.

  // ============================================================
  // Failure Classification: Taxonomy of known failure patterns
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      diff_patterns TEXT NOT NULL DEFAULT '[]',
      file_patterns TEXT NOT NULL DEFAULT '[]',
      prompt_keywords TEXT NOT NULL DEFAULT '[]',
      incidents TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL DEFAULT '[]',
      scanner_checks TEXT NOT NULL DEFAULT '[]',
      known_message TEXT NOT NULL DEFAULT '',
      needs_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fc_name ON failure_classes(name);
    CREATE INDEX IF NOT EXISTS idx_fc_needs_review ON failure_classes(needs_review);
  `);

  // ============================================================
  // P1-001 (plan-living-memory-slice-1): embedding companion table.
  // A separate table (not a column on observations) keeps the embedding a
  // clean, droppable concern and avoids touching the hot observation write
  // path. Each row stores the model_id + dim it was produced with so a model
  // change can never silently mix incompatible vectors — the hybrid search
  // skips rows whose (model_id, dim) don't match the active query embedder.
  // The vector is an L2-normalized Float32 little-endian BLOB.
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_embeddings (
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      chunk_ix INTEGER NOT NULL DEFAULT 0,
      model_id TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (observation_id, model_id, dim, chunk_ix)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_emb_model ON observation_embeddings(model_id);
  `);

  // A-04 — one vector per CHUNK, not per memory.
  //
  // The table was `observation_id INTEGER PRIMARY KEY` — strictly ONE vector per
  // observation. But the embedder clamps to 256 WordPiece tokens (~1,000 chars), so a
  // single vector covered ~7% of the operator's longest memory and the other 93% had
  // no semantic representation at all. One vector per memory makes "find the passage
  // deep inside this long memory" impossible BY CONSTRUCTION, no matter how the sweep
  // is wired.
  //
  // Widening the PK requires a table rebuild — `CREATE TABLE IF NOT EXISTS` will not
  // alter a table that already exists, and every database in the field already has it.
  migrateObservationEmbeddingChunks(db);

  // B-00 — the 4B columns. MUST run on every open: a DB created by 4A has
  // `memory_files` and `observations` already, and CREATE TABLE IF NOT EXISTS
  // will never add a column to them. Idempotent; a no-op once applied.
  migrateMemoryFilesFor4B(db);

  // D-11 (Layer 2): rule candidates are ROWS. Before this they existed only as
  // loose JSON on disk, so the product could not answer "has anything ever been
  // promoted?" — and the answer, for its entire life, was no.
  ensureRuleCandidatesTable(db);

  // Layer 2: the lease/ack bookkeeping on the outbound stores. A learned rule is
  // deleted ONLY on a confirmed server receipt (rule-delivery.ts).
  migrateRuleDelivery(db);
}

// ============================================================
// Cloud Sync: Queue Functions
// ============================================================

/**
 * Enqueue a sync payload for later retry.
 */
export function enqueueSyncPayload(db: Database.Database, payload: string): void {
  db.prepare('INSERT INTO pending_sync (payload) VALUES (?)').run(payload);
}

// ============================================================
// Team-shared promotion outbound stores + cursor + telemetry
// (PB-005 / PB-006 / PB-016, plan-2026-05-28-team-shared-rule-promotion)
// ============================================================

const MAX_DRAFT_TEXT_LEN = 16_384; // H4 client mirror — server enforces 16 KB cap too.

export interface TeamPromotionOutbound {
  prompt_hash: string;
  destination: string;
  draft_text: string;
  score?: number;
  signals?: unknown[];
  content_hash: string;
  /** PA3-004: true for a hardened (executable-destination) publish. Default false. */
  hardened?: boolean;
  /** PA3-004: publisher's review attestation (required server-side for hardened rows). */
  review_attestation?: unknown;
}

/**
 * Generic key/value read from `memory_meta`. Returns `null` when absent.
 * Used by the team-shared pull path for the monotonic `seq` cursor (H2).
 */
export function getMemoryMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** Generic key/value upsert into `memory_meta`. */
export function setMemoryMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run(key, value);
}

// ============================================================
// P2-001 (plan-living-memory-slice-2a-embedder): observation embedding writer +
// sweep. These are the memory-DB half of the ONE structural embed writer; the
// generic loop lives in memory-embed-sweep.ts.
// ============================================================

/**
 * Upsert an L2-normalized embedding for an observation into
 * `observation_embeddings` (1:1, keyed by observation_id). Stores the
 * (model_id, dim) provenance so the hybrid search can skip mismatched vectors.
 */
export function upsertObservationEmbedding(
  db: Database.Database,
  observationId: number,
  vec: Float32Array,
  modelId: string,
  dim: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO observation_embeddings (observation_id, model_id, dim, vec, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(observationId, modelId, dim, float32ToBlob(vec));
}

/** Build the embed text for an observation (title + detail). */
function observationEmbedText(title: string, detail: string | null): string {
  const t = (title ?? '').trim();
  const d = (detail ?? '').trim();
  return d ? `${t}. ${d}` : t;
}

/**
 * Embed all observations lacking a matching (model_id, dim) embedding. Fail-open,
 * resumable, and time-boxable — see runEmbedSweep. Returns {embedded, scanned}.
 */
export async function embedMissingObservations(
  db: Database.Database,
  opts: EmbedSweepOpts = {},
): Promise<EmbedSweepResult> {
  return runEmbedSweep(
    db,
    {
      embeddingTable: 'observation_embeddings',
      idCol: 'observation_id',
      metaTable: 'memory_meta',
      sourceLabel: 'observation',
      // A-04: memory bodies are now stored WHOLE (up to ~14K chars). One vector per
      // memory would cover only its first ~1,000 chars.
      chunked: true,
      selectMissing: (d, cursor, model, batchSize): SweepRow[] => {
        const rows = model
          ? (d
              .prepare(
                `SELECT o.id AS id, o.title AS title, o.detail AS detail
                 FROM observations o
                 WHERE o.id > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM observation_embeddings e
                     WHERE e.observation_id = o.id AND e.model_id = ? AND e.dim = ?
                   )
                 ORDER BY o.id LIMIT ?`,
              )
              .all(cursor, model.modelId, model.dim, batchSize) as Array<{
              id: number;
              title: string;
              detail: string | null;
            }>)
          : (d
              .prepare(
                `SELECT o.id AS id, o.title AS title, o.detail AS detail
                 FROM observations o
                 WHERE o.id > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM observation_embeddings e WHERE e.observation_id = o.id
                   )
                 ORDER BY o.id LIMIT ?`,
              )
              .all(cursor, batchSize) as Array<{
              id: number;
              title: string;
              detail: string | null;
            }>);
        return rows.map((r) => ({ id: r.id, text: observationEmbedText(r.title, r.detail) }));
      },
    },
    opts,
  );
}

/**
 * Enqueue a team-shared promotion for outbound sync (PB-005 publish branch).
 * `draft_text` is bounded to 16 KB (H4 client mirror) before storage. Idempotent
 * on `prompt_hash` (INSERT OR REPLACE) so re-promoting the same rule re-queues a
 * single row, not duplicates.
 */
export function enqueueTeamPromotion(db: Database.Database, promo: TeamPromotionOutbound): void {
  db.prepare(`
    INSERT OR REPLACE INTO team_promotion_outbound
      (prompt_hash, destination, draft_text, score, signals_json, content_hash, hardened, review_attestation_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    promo.prompt_hash,
    promo.destination,
    promo.draft_text.slice(0, MAX_DRAFT_TEXT_LEN),
    promo.score ?? null,
    JSON.stringify(promo.signals ?? []),
    promo.content_hash,
    promo.hardened ? 1 : 0,
    promo.review_attestation !== undefined ? JSON.stringify(promo.review_attestation) : null,
  );
}

// REMOVED (Layer 2): `drainTeamPromotions` — a SELECT-then-DELETE that destroyed a
// promoted rule the moment it was read, before anyone knew whether it had been
// delivered. Deleted rather than deprecated: a destructive drain that still exists
// is a destructive drain someone will call again. Use `leaseLearning` /
// `ackLearning` / `nackLearning` in rule-delivery.ts — a rule is deleted ONLY when
// the server confirms receipt. Enforced by tests/rule-delivery-no-destructive-drain.

/**
 * Enqueue a publisher-initiated revocation (PB-016 / H3). Idempotent on
 * `prompt_hash`. Drained into `rule_revocations[]` at session end.
 */
export function enqueueTeamRevocation(db: Database.Database, promptHash: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO team_revocation_outbound (prompt_hash, created_at)
    VALUES (?, datetime('now'))
  `).run(promptHash);
}

// REMOVED (Layer 2): `drainTeamRevocations` — same destructive SELECT-then-DELETE.
// Superseded by the lease/ack contract in rule-delivery.ts.

/**
 * Read the CR-53 effectiveness signal for a promoted rule (P1-002a). Returns the
 * canonical `recurrence_count` from the single `rule_promoted` audit_log row for
 * `promptHash` (the UNIQUE index on (event_type, metadata.prompt_hash) guarantees
 * at most one). Returns `null` when no such row exists — so the synced
 * `promoted_rules.recurrence_count` column stays NULL rather than a fake 0.
 *
 * This is the canonical CR-53 counter (audit_log metadata.recurrence_count,
 * bumped by recurrence-incrementer.ts) — NOT the failure-title `observations`
 * counter, which is keyed differently and is not the promotion effectiveness
 * signal.
 */
export function getRecurrenceCountForPromptHash(
  db: Database.Database,
  promptHash: string,
): number | null {
  try {
    const row = db.prepare(`
      SELECT json_extract(metadata, '$.recurrence_count') AS rc
      FROM audit_log
      WHERE event_type = 'rule_promoted'
        AND json_extract(metadata, '$.prompt_hash') = ?
      LIMIT 1
    `).get(promptHash) as { rc: number | null } | undefined;
    if (!row || row.rc === null || row.rc === undefined) return null;
    return Number(row.rc);
  } catch {
    return null;
  }
}

/**
 * The four non-revoke funnel event types (P1-002). This is the CLIENT-EMITTER
 * surface of the enum drift-guard (P1-004): it MUST stay byte-identical to the
 * server ingest allowlist, the migration 046 CHECK, and the dashboard reader.
 */
export type RulePromotionEventType = 'proposed' | 'shown' | 'approved' | 'dismissed';

/** A single funnel event queued for outbound sync (P1-002). Metadata only. */
export interface RulePromotionEventOutbound {
  prompt_hash: string;
  event_type: RulePromotionEventType;
  /** ISO timestamp of the transition. */
  created_at: string;
  /** Metadata only — never draft_text/detail/secrets. */
  metadata?: Record<string, unknown>;
}

/**
 * Append-only funnel events multiply faster than the per-promotion team stores
 * (≥4 events per candidate lifecycle), so the drain LIMIT is higher than the
 * team stores' 1000. The OUTBOX cap bounds worst-case local growth for a Team
 * seat whose cloud sync is disabled (it enqueues but never drains) — newest rows
 * are kept (L4). The drain deletes ONLY the rows it returned, so a tail beyond
 * the LIMIT is carried to the next session rather than silently lost (L3).
 */
const FUNNEL_EVENT_DRAIN_LIMIT = 5000;
const FUNNEL_EVENT_OUTBOX_CAP = 20000;

/**
 * Enqueue a promotion-funnel event for outbound sync (P1-002). APPEND-ONLY: a
 * prompt_hash may accrue many events. Best-effort + non-throwing so a funnel-
 * capture failure never breaks the calling hook/applier path. Callers gate on
 * Team+ entitlement BEFORE calling (org-scoped analytics is a Team feature).
 */
export function enqueueRulePromotionEvent(
  db: Database.Database,
  ev: RulePromotionEventOutbound,
): void {
  try {
    db.prepare(`
      INSERT INTO rule_promotion_events_outbound
        (prompt_hash, event_type, metadata_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      ev.prompt_hash,
      ev.event_type,
      JSON.stringify(ev.metadata ?? {}),
      ev.created_at,
    );
    // L4: bound local growth on a seat that never syncs. This trims funnel
    // TELEMETRY only — never a learned rule (see rule-delivery.ts for why that
    // distinction is load-bearing). `capTelemetry` announces the trim instead of
    // performing it silently.
    capTelemetry(db, FUNNEL_EVENT_OUTBOX_CAP);
  } catch (err) {
    // S-9: still non-throwing (a telemetry failure must not break the promotion
    // that triggered it) — but NO LONGER SILENT. An empty catch here is what made
    // "the funnel is broken" and "there was nothing to record" indistinguishable.
    process.stderr.write(
      `[massu] WARNING: failed to record promotion-funnel event ` +
        `(${ev.event_type} / ${ev.prompt_hash}): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// REMOVED (Layer 2): `drainRulePromotionEvents` — the SELECT-then-DELETE whose
// docstring promised that "on sync failure the whole payload is re-enqueued to
// pending_sync, so draining here is safe". It was not safe. `pending_sync` DISCARDS
// after 10 retries, so the events were deleted here, queued, retried against an
// HTTP 401, and then destroyed. The docstring was a capability claim nobody probed.
// Superseded by the lease/ack contract in rule-delivery.ts.

/**
 * Best-effort telemetry insert into `analytics_events` (H5 observability). Used
 * by the team-shared pull path so a dropped/anomalous envelope is visible on the
 * dashboard rather than failing silently. Never throws.
 */
export function recordTelemetry(
  db: Database.Database,
  eventType: string,
  data: Record<string, unknown>,
): void {
  try {
    db.prepare(`
      INSERT INTO analytics_events (event_type, event_data, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(eventType, JSON.stringify(data));
  } catch {
    // analytics_events may not exist in older schemas — best-effort.
  }
}

function safeJsonArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Parse a JSON value, returning undefined on any parse error (PA3-004). */
function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Dequeue pending sync items (oldest first).
 *
 * P-H012 (plan-stage-c-high-batch): when items exceed retry_count >= 10
 * they are discarded — but the discard now emits a stderr warning AND
 * inserts an analytics_events telemetry row so the customer can detect
 * silent cloud-sync failure (e.g., invalid API key for >10 sync cycles).
 * Previously this was a silent DELETE; customers lost all queued
 * observations with no visibility.
 */
/**
 * Pull learned rules out of about-to-be-discarded `pending_sync` payloads and put
 * them back into their durable outbound stores (Layer 2). Returns how many rules
 * were rescued.
 *
 * Re-enqueue is idempotent: `team_promotion_outbound` / `team_revocation_outbound`
 * are keyed by prompt_hash (INSERT OR REPLACE), so rescuing a rule that is already
 * queued is a no-op rather than a duplicate.
 *
 * FAIL LOUD, NEVER SILENT: if a rescue itself fails we say so on stderr. The one
 * thing we must never do is delete the payload while pretending the rule survived.
 */
function rescueLearningFromStalePayloads(
  db: Database.Database,
  stale: Array<{ id: number; payload: string }>,
): number {
  let rescued = 0;
  for (const item of stale) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(item.payload) as Record<string, unknown>;
    } catch {
      continue; // Unparseable payload cannot contain a recoverable rule.
    }
    try {
      const promotions = Array.isArray(payload.rule_promotions) ? payload.rule_promotions : [];
      for (const p of promotions as TeamPromotionOutbound[]) {
        enqueueTeamPromotion(db, p);
        rescued++;
      }
      const revocations = Array.isArray(payload.rule_revocations) ? payload.rule_revocations : [];
      for (const r of revocations as Array<{ prompt_hash?: string }>) {
        if (typeof r?.prompt_hash === 'string') {
          enqueueTeamRevocation(db, r.prompt_hash);
          rescued++;
        }
      }
      const events = Array.isArray(payload.rule_promotion_events)
        ? payload.rule_promotion_events
        : [];
      for (const e of events as RulePromotionEventOutbound[]) {
        enqueueRulePromotionEvent(db, e);
      }
    } catch (err) {
      process.stderr.write(
        `[massu] WARNING: failed to rescue learned rules from give-up payload ${item.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return rescued;
}

export function dequeuePendingSync(
  db: Database.Database,
  limit: number = 10
): Array<{ id: number; payload: string; retry_count: number }> {
  // First, discard items that have exceeded max retries.
  //
  // LAYER 2 — RESCUE BEFORE DISCARD. This DELETE is the shredder that destroyed 17
  // of the 18 promotion events ever created: a payload carrying a promoted rule was
  // retried 10 times against an HTTP 401 and then silently deleted. Learned rules
  // are the product; they are NEVER discarded. New payloads no longer carry them
  // (cloud-sync strips them — they live under the lease/ack contract instead), but
  // payloads queued by an OLDER build still can. So before deleting anything, we
  // pull any learned rules back out into their durable outbound stores, where they
  // will be retried forever. Sessions/observations remain best-effort and are
  // discarded here, loudly, as before.
  const stale = db.prepare(
    'SELECT id, retry_count, last_error, payload FROM pending_sync WHERE retry_count >= 10 LIMIT 10000'
  ).all() as Array<{ id: number; retry_count: number; last_error: string | null; payload: string }>;
  if (stale.length > 0) {
    const rescued = rescueLearningFromStalePayloads(db, stale);
    const ids = stale.map(s => s.id);
    db.prepare(`DELETE FROM pending_sync WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    if (rescued > 0) {
      process.stderr.write(
        `[massu] RESCUED ${rescued} learned rule(s) from ${stale.length} give-up payload(s) — ` +
        `they were re-queued for delivery, NOT discarded.\n`,
      );
    }
    // P-H012: stderr warning so the customer's terminal sees what happened.
    const lastErrors = [...new Set(stale.map(s => s.last_error).filter(Boolean))];
    process.stderr.write(
      `[massu] WARNING: ${stale.length} cloud-sync queue item(s) discarded after 10+ retries. ` +
      `Likely cause: invalid API key or unreachable endpoint. ` +
      `Recent errors: ${lastErrors.slice(0, 3).join('; ') || '(none recorded)'}\n`,
    );
    // P-H012: telemetry event for dashboard surfacing. Use the analytics_events
    // sink that already exists in memory-db (see addObservation pattern).
    try {
      db.prepare(`
        INSERT INTO analytics_events (event_type, event_data, created_at)
        VALUES (?, ?, datetime('now'))
      `).run(
        'cloud_sync_giveup',
        JSON.stringify({
          discarded_count: stale.length,
          recent_errors: lastErrors.slice(0, 3),
        }),
      );
    } catch {
      // analytics_events may not exist in older schemas — best-effort.
    }
  }

  return db.prepare(
    'SELECT id, payload, retry_count FROM pending_sync ORDER BY created_at ASC LIMIT ?'
  ).all(limit) as Array<{ id: number; payload: string; retry_count: number }>;
}

/**
 * Remove a successfully synced item from the queue.
 */
export function removePendingSync(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM pending_sync WHERE id = ?').run(id);
}

/**
 * Increment retry count and record the last error for a failed sync attempt.
 */
export function incrementRetryCount(db: Database.Database, id: number, error: string): void {
  db.prepare(
    'UPDATE pending_sync SET retry_count = retry_count + 1, last_error = ? WHERE id = ?'
  ).run(error, id);
}

// ============================================================
// P1-002: Database Access Functions (19 functions)
// ============================================================

/**
 * Auto-assign importance score based on observation type and optional VR result.
 * Scale: 5=decision/failed_attempt, 4=cr_violation/vr_check(FAIL),
 * 3=feature/bugfix, 2=vr_check(PASS)/refactor, 1=file_change/discovery
 */
export function assignImportance(type: string, vrResult?: string): number {
  switch (type) {
    case 'decision':
    case 'failed_attempt':
      return 5;
    case 'cr_violation':
    case 'incident_near_miss':
      return 4;
    case 'vr_check':
      return vrResult === 'PASS' ? 2 : 4;
    case 'pattern_compliance':
      return vrResult === 'PASS' ? 2 : 4;
    case 'feature':
    case 'bugfix':
      return 3;
    case 'refactor':
      return 2;
    case 'file_change':
    case 'discovery':
      return 1;
    default:
      return 3;
  }
}

/**
 * Derive task_id from plan file path.
 * Sessions working on the same plan file share a task_id.
 */
export function autoDetectTaskId(planFile: string | null | undefined): string | null {
  if (!planFile) return null;
  // Use the plan filename without extension as task_id
  // e.g., "/path/to/2026-01-30-massu-memory.md" -> "2026-01-30-massu-memory"
  const base = basename(planFile);
  return base.replace(/\.md$/, '');
}

export interface CreateSessionOpts {
  branch?: string;
  planFile?: string;
}

/**
 * Create a session (INSERT OR IGNORE for idempotency).
 */
export function createSession(db: Database.Database, sessionId: string, opts?: CreateSessionOpts): void {
  const now = new Date();
  const taskId = autoDetectTaskId(opts?.planFile);
  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, git_branch, plan_file, task_id, started_at, started_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, opts?.branch ?? null, opts?.planFile ?? null, taskId, now.toISOString(), Math.floor(now.getTime() / 1000));
}

/**
 * End a session by updating status and ended_at.
 */
export function endSession(db: Database.Database, sessionId: string, status: 'completed' | 'abandoned' = 'completed'): void {
  const now = new Date();
  db.prepare(`
    UPDATE sessions SET status = ?, ended_at = ?, ended_at_epoch = ? WHERE session_id = ?
  `).run(status, now.toISOString(), Math.floor(now.getTime() / 1000), sessionId);
}

export interface AddObservationOpts {
  filesInvolved?: string[];
  planItem?: string;
  crRule?: string;
  vrType?: string;
  evidence?: string;
  importance?: number;
  originalTokens?: number;
}

/**
 * Insert an observation into the memory DB.
 */
/**
 * Cached check for whether a table carries the bi-temporal columns
 * (plan-living-memory-slice-2-temporal-model). Keyed by connection so a
 * production DB (initMemorySchema ran → columns present) stamps temporal values
 * at INSERT, while a hand-rolled pre-temporal table (some tests) is left alone.
 */
const _temporalColCache = new WeakMap<Database.Database, Map<string, boolean>>();
export function memoryTableHasTemporal(db: Database.Database, table: string): boolean {
  let perDb = _temporalColCache.get(db);
  if (!perDb) {
    perDb = new Map();
    _temporalColCache.set(db, perDb);
  }
  let has = perDb.get(table);
  if (has === undefined) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      has = cols.some((c) => c.name === 'valid_from_epoch');
    } catch {
      has = false;
    }
    perDb.set(table, has);
  }
  return has;
}

export function addObservation(
  db: Database.Database,
  sessionId: string,
  type: string,
  title: string,
  detail: string | null,
  opts?: AddObservationOpts
): number {
  const now = new Date();
  const importance = opts?.importance ?? assignImportance(type, opts?.evidence?.includes('PASS') ? 'PASS' : undefined);
  const iso = now.toISOString();
  const epochSec = Math.floor(now.getTime() / 1000);
  // Bi-temporal: a new observation is "valid now, never expired" (event +
  // transaction time both start at creation). Stamped here ONLY when the columns
  // exist (see memoryTableHasTemporal) so pre-temporal test tables keep working.
  let result: Database.RunResult;
  if (memoryTableHasTemporal(db, 'observations')) {
    result = db.prepare(`
      INSERT INTO observations (session_id, type, title, detail, files_involved, plan_item, cr_rule, vr_type, evidence, importance, original_tokens, created_at, created_at_epoch, valid_from, ingested_at, valid_from_epoch, ingested_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, type, title, detail,
      JSON.stringify(opts?.filesInvolved ?? []),
      opts?.planItem ?? null,
      opts?.crRule ?? null,
      opts?.vrType ?? null,
      opts?.evidence ?? null,
      importance,
      opts?.originalTokens ?? 0,
      iso, epochSec, iso, iso, epochSec, epochSec
    );
  } else {
    result = db.prepare(`
      INSERT INTO observations (session_id, type, title, detail, files_involved, plan_item, cr_rule, vr_type, evidence, importance, original_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, type, title, detail,
      JSON.stringify(opts?.filesInvolved ?? []),
      opts?.planItem ?? null,
      opts?.crRule ?? null,
      opts?.vrType ?? null,
      opts?.evidence ?? null,
      importance,
      opts?.originalTokens ?? 0,
      iso, epochSec
    );
  }
  return Number(result.lastInsertRowid);
}

/**
 * Supersede-don't-delete (plan-living-memory-slice-2-temporal-model): mark an
 * existing memory record as superseded by a successor. This is an UPDATE, never
 * a DELETE — the old row stays queryable ("what did we believe on date X") but
 * is excluded from current recall. Sets event-time `valid_to`, transaction-time
 * `expired_at`, and the `superseded_by` link; for architecture_decisions it also
 * flips `status` to 'superseded'. `nowEpochSec` defaults to the current second
 * (injectable for deterministic tests). Returns true iff a live row was expired.
 */
export function markRecordSuperseded(
  db: Database.Database,
  table: 'observations' | 'architecture_decisions',
  recordId: number,
  successorId: number,
  nowEpochSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const iso = new Date(nowEpochSec * 1000).toISOString();
  const statusClause = table === 'architecture_decisions' ? `, status = 'superseded'` : '';
  // Only expire a row that is still live (expired_at IS NULL) and is not the
  // successor itself — idempotent + self-supersede-safe.
  const res = db
    .prepare(
      `UPDATE ${table}
          SET valid_to = ?, expired_at = ?, valid_to_epoch = ?, expired_at_epoch = ?, superseded_by = ?${statusClause}
        WHERE id = ? AND expired_at IS NULL AND id != ?`,
    )
    .run(iso, iso, nowEpochSec, nowEpochSec, successorId, recordId, successorId);
  return res.changes > 0;
}

export interface SessionSummary {
  request?: string;
  investigated?: string;
  decisions?: string;
  completed?: string;
  failedAttempts?: string;
  nextSteps?: string;
  filesCreated?: string[];
  filesModified?: string[];
  verificationResults?: Record<string, string>;
  planProgress?: Record<string, string>;
}

/**
 * Insert a session summary.
 */
export function addSummary(db: Database.Database, sessionId: string, summary: SessionSummary): void {
  const now = new Date();
  db.prepare(`
    INSERT INTO session_summaries (session_id, request, investigated, decisions, completed, failed_attempts, next_steps, files_created, files_modified, verification_results, plan_progress, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    summary.request ?? null,
    summary.investigated ?? null,
    summary.decisions ?? null,
    summary.completed ?? null,
    summary.failedAttempts ?? null,
    summary.nextSteps ?? null,
    JSON.stringify(summary.filesCreated ?? []),
    JSON.stringify(summary.filesModified ?? []),
    JSON.stringify(summary.verificationResults ?? {}),
    JSON.stringify(summary.planProgress ?? {}),
    now.toISOString(),
    Math.floor(now.getTime() / 1000)
  );
}

/**
 * Insert a user prompt.
 */
export function addUserPrompt(db: Database.Database, sessionId: string, text: string, promptNumber: number): void {
  const now = new Date();
  db.prepare(`
    INSERT INTO user_prompts (session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, text, promptNumber, now.toISOString(), Math.floor(now.getTime() / 1000));
}

export interface SearchOpts {
  type?: string;
  crRule?: string;
  dateFrom?: string;
  limit?: number;
}

/**
 * FTS5 search on observations + user_prompts.
 */
export function searchObservations(db: Database.Database, query: string, opts?: SearchOpts): Array<{
  id: number;
  type: string;
  title: string;
  created_at: string;
  session_id: string;
  importance: number;
  rank: number;
}> {
  const limit = opts?.limit ?? 20;
  let sql = `
    SELECT o.id, o.type, o.title, o.created_at, o.session_id, o.importance,
           rank
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
  `;
  const params: (string | number)[] = [sanitizeFts5Query(query)];

  if (opts?.type) {
    sql += ' AND o.type = ?';
    params.push(opts.type);
  }
  if (opts?.crRule) {
    sql += ' AND o.cr_rule = ?';
    params.push(opts.crRule);
  }
  if (opts?.dateFrom) {
    sql += ' AND o.created_at >= ?';
    params.push(opts.dateFrom);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as Array<{
    id: number;
    type: string;
    title: string;
    created_at: string;
    session_id: string;
    importance: number;
    rank: number;
  }>;
}

/**
 * Get recent observations, optionally filtered by session.
 */
export function getRecentObservations(db: Database.Database, limit: number = 20, sessionId?: string): Array<{
  id: number;
  type: string;
  title: string;
  detail: string | null;
  importance: number;
  created_at: string;
  session_id: string;
}> {
  if (sessionId) {
    return db.prepare(`
      SELECT id, type, title, detail, importance, created_at, session_id
      FROM observations WHERE session_id = ?
      ORDER BY created_at_epoch DESC LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: number; type: string; title: string; detail: string | null;
      importance: number; created_at: string; session_id: string;
    }>;
  }
  return db.prepare(`
    SELECT id, type, title, detail, importance, created_at, session_id
    FROM observations
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(limit) as Array<{
    id: number; type: string; title: string; detail: string | null;
    importance: number; created_at: string; session_id: string;
  }>;
}

/**
 * Get recent session summaries.
 */
export function getSessionSummaries(db: Database.Database, limit: number = 10): Array<{
  session_id: string;
  request: string | null;
  completed: string | null;
  failed_attempts: string | null;
  plan_progress: string;
  created_at: string;
}> {
  return db.prepare(`
    SELECT session_id, request, completed, failed_attempts, plan_progress, created_at
    FROM session_summaries
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(limit) as Array<{
    session_id: string; request: string | null; completed: string | null;
    failed_attempts: string | null; plan_progress: string; created_at: string;
  }>;
}

/**
 * Get complete timeline for a session.
 */
export function getSessionTimeline(db: Database.Database, sessionId: string): {
  session: Record<string, unknown> | null;
  observations: Array<Record<string, unknown>>;
  summary: Record<string, unknown> | null;
  prompts: Array<Record<string, unknown>>;
} {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  const observations = db.prepare('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC').all(sessionId) as Array<Record<string, unknown>>;
  const summary = db.prepare('SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1').get(sessionId) as Record<string, unknown> | undefined;
  const prompts = db.prepare('SELECT * FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC').all(sessionId) as Array<Record<string, unknown>>;

  return {
    session: session ?? null,
    observations,
    summary: summary ?? null,
    prompts,
  };
}

/**
 * Get failed attempt observations.
 */
export function getFailedAttempts(db: Database.Database, query?: string, limit: number = 20): Array<{
  id: number;
  title: string;
  detail: string | null;
  session_id: string;
  recurrence_count: number;
  created_at: string;
}> {
  if (query) {
    return db.prepare(`
      SELECT o.id, o.title, o.detail, o.session_id, o.recurrence_count, o.created_at
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.type = 'failed_attempt'
      ORDER BY o.recurrence_count DESC, rank LIMIT ?
    `).all(sanitizeFts5Query(query), limit) as Array<{
      id: number; title: string; detail: string | null; session_id: string;
      recurrence_count: number; created_at: string;
    }>;
  }
  return db.prepare(`
    SELECT id, title, detail, session_id, recurrence_count, created_at
    FROM observations WHERE type = 'failed_attempt'
    ORDER BY recurrence_count DESC, created_at_epoch DESC LIMIT ?
  `).all(limit) as Array<{
    id: number; title: string; detail: string | null; session_id: string;
    recurrence_count: number; created_at: string;
  }>;
}

/**
 * Search decision observations.
 */
export function getDecisionsAbout(db: Database.Database, query: string, limit: number = 20): Array<{
  id: number;
  title: string;
  detail: string | null;
  session_id: string;
  created_at: string;
}> {
  return db.prepare(`
    SELECT o.id, o.title, o.detail, o.session_id, o.created_at
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ? AND o.type = 'decision'
    ORDER BY rank LIMIT ?
  `).all(sanitizeFts5Query(query), limit) as Array<{
    id: number; title: string; detail: string | null; session_id: string;
    created_at: string;
  }>;
}

// ============================================================
// Retention: supersede-EXPIRE, never hard-delete
// (P1-003 + P1-004 + P5-001, plan-living-memory-slice-3-consolidation)
//
// This replaces the blanket hard-delete of every observation past a cutoff
// that ran on EVERY server start. That delete was value-blind: a hard-won
// architectural decision, a correction the operator gave twice, and an
// incident near-miss were all destroyed at 90 days exactly like trivia — which
// made Slice 2's supersede-don't-delete guarantee false in production.
// (Slice 2 left the IOU in no-hard-delete-memory-drift-guard.test.ts.)
//
// A row is now retired ONLY when it is old AND low-importance AND an
// unprotected type AND not a consolidation-authored lesson AND has never once
// been retrieved — and even then it is EXPIRED (an UPDATE, reversible, still
// reachable via hybridSearch({asOf})), never erased.
// ============================================================

/** Marker on consolidation-authored session lessons (they are never expired). */
export const CONSOLIDATION_LESSON_EVIDENCE = 'consolidation:session-summary';

/** Title prefix of an observation that PROJECTS a `memory/*.md` file on disk. */
export const MEMORY_FILE_TITLE_PREFIX = '[memory-file] ';

/**
 * SQL LIKE pattern for the above. Bind it; never interpolate.
 *
 * File-backed observations are EXEMPT from automatic value-decay (demotion in
 * stageReweight, expiry here). The file on disk is the human's standing
 * assertion that the memory is live, and a usage counter may not overrule it:
 * these rows are a PROJECTION of the file, so their reachability is reconciled
 * from the file, never inferred from how often they happened to be retrieved.
 *
 * Without this exemption an ingested memory file — `type` defaults to
 * 'discovery' (unprotected) and importance to 4, with no usage hits — is
 * demoted 4→3→2 after `retentionDays` and then expired, going permanently
 * invisible to recall while the file sits untouched on disk. Re-ingesting it
 * cannot revive it (ingest never cleared `expired_at`). That is silent,
 * irreversible memory loss aimed squarely at the memories consulted least.
 */
export const MEMORY_FILE_TITLE_LIKE = `${MEMORY_FILE_TITLE_PREFIX}%`;

/** `memory_meta` key: when the retrieval counter first went live. */
export const USAGE_COUNTER_ARMED_KEY = 'usage_counter_armed_epoch';

/**
 * Arm the retrieval counter (idempotent — only writes the first time).
 * Returns the armed epoch (seconds).
 *
 * THE COLD-START GUARD (P1-004). `memory_usage` did not exist before this
 * slice, so on the FIRST run after upgrade every pre-existing row has zero
 * hits. A naive "expire what was never retrieved" would therefore look at the
 * operator's entire history, conclude nobody had ever used any of it, and
 * expire nearly all of it on day one. Arming a start epoch — and refusing to
 * expire ANYTHING until the counter has been observing for `warmupDays` — gives
 * every row, old or new, a real window in which a retrieval can prove it useful
 * BEFORE expiry is armed at all.
 */
export function armUsageCounter(db: Database.Database, nowEpochSec?: number): number {
  const existing = getMemoryMeta(db, USAGE_COUNTER_ARMED_KEY);
  if (existing) {
    const n = Number(existing);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const now = nowEpochSec ?? Math.floor(Date.now() / 1000);
  setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now));
  return now;
}

/** Has the retrieval counter observed usage for at least `warmupDays`? */
export function usageWarmupElapsed(
  db: Database.Database,
  warmupDays: number,
  nowEpochSec?: number,
): boolean {
  const armed = getMemoryMeta(db, USAGE_COUNTER_ARMED_KEY);
  if (!armed) return false; // never armed -> expiry stays disarmed
  const armedEpoch = Number(armed);
  if (!Number.isFinite(armedEpoch) || armedEpoch <= 0) return false;
  const now = nowEpochSec ?? Math.floor(Date.now() / 1000);
  return now - armedEpoch >= warmupDays * 86400;
}

export interface ExpireOptions {
  retentionDays: number;
  importanceFloor: number;
  protectedTypes: readonly string[];
  usageWarmupDays: number;
  /**
   * Grace period. A row that was DEMOTED to the floor must survive at least
   * this long before it becomes expiry-eligible, so a retrieval has a real
   * chance to rescue it.
   *
   * Without this the pass could demote a row (importance 3 -> 2) and then, on a
   * run a minute later, expire it at the floor — "value-aware" in name only.
   * Ordering expire-before-reweight alone does NOT fix that: it only defers the
   * kill by one pass, not by any actual time. (Caught by the idempotency test.)
   */
  reweightIntervalDays?: number;
  nowEpochSec?: number;
}

/**
 * Expire (NOT delete) old, low-value, never-retrieved observations.
 * Returns the number of rows expired. Zero while the counter is still warming.
 */
export function expireOldLowValueObservations(
  db: Database.Database,
  opts: ExpireOptions,
): number {
  const now = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);

  // Cold-start guard: expiry is DISARMED until the usage counter has had a
  // real observation window. This is the single most important line in the
  // slice — without it the first run would gut the store.
  if (!usageWarmupElapsed(db, opts.usageWarmupDays, now)) return 0;

  const cutoffEpoch = now - opts.retentionDays * 86400;

  // `protectedTypes` is OPERATOR-SUPPLIED CONFIG -> bind with placeholders.
  // Never interpolate a config-driven list into SQL.
  const typePlaceholders = opts.protectedTypes.length
    ? opts.protectedTypes.map(() => '?').join(',')
    : "''";

  // Derive the timestamp from `now` (NOT SQL datetime('now')) so a caller-
  // supplied clock — the tests simulate "31 days later" — writes consistent
  // text + epoch values. Same convention as markRecordSuperseded.
  const iso = new Date(now * 1000).toISOString();

  const result = db
    .prepare(
      `UPDATE observations
          SET expired_at = ?,
              expired_at_epoch = ?,
              valid_to = ?,
              valid_to_epoch = ?
        WHERE expired_at IS NULL
          AND created_at_epoch < ?
          AND importance <= ?
          AND type NOT IN (${typePlaceholders})
          AND COALESCE(evidence, '') != ?
          -- A file-backed row mirrors a file the human still keeps on disk.
          -- Value-decay may never retire it; only the file's removal can.
          AND title NOT LIKE ?
          AND NOT EXISTS (
                SELECT 1 FROM memory_usage u
                 WHERE u.source = 'observation'
                   AND u.record_id = observations.id
                   AND u.hit_count > 0
              )
          AND NOT EXISTS (
                -- The grace period: a row demoted within the last cadence
                -- window is NOT yet expirable, so being pushed to the floor can
                -- never be immediately fatal.
                SELECT 1 FROM memory_usage u
                 WHERE u.source = 'observation'
                   AND u.record_id = observations.id
                   AND u.last_reweight_epoch IS NOT NULL
                   AND u.last_reweight_epoch > ?
              )`,
    )
    .run(
      iso,
      now,
      iso,
      now,
      cutoffEpoch,
      opts.importanceFloor,
      ...opts.protectedTypes,
      CONSOLIDATION_LESSON_EVIDENCE,
      MEMORY_FILE_TITLE_LIKE,
      now - (opts.reweightIntervalDays ?? 1) * 86400,
    );

  return result.changes;
}

/**
 * Startup retention pass. Kept as `pruneOldObservations` for its existing
 * callers, but it now EXPIRES rather than deletes (P5-001). Returns the count
 * expired.
 */
export function pruneOldObservations(db: Database.Database, opts: ExpireOptions): number {
  return expireOldLowValueObservations(db, opts);
}

// ============================================================
// Retrieval-usage writers (P1-001 / P4-002)
// ============================================================

/** One record the recall hook actually SHOWED to the model. */
export interface RecallHit {
  source: string;
  id: number;
}

/**
 * Record that these records were surfaced into the model's context this turn.
 *
 * Counts at most ONE hit per (record, session) — see the memory_usage comment:
 * a raw counter would measure how chatty a session was, not how useful a
 * memory is. Callers pass ONLY the records that were actually rendered (see
 * selectRecallItems), never the full candidate set.
 */
export function recordRecallHits(
  db: Database.Database,
  sessionId: string,
  hits: readonly RecallHit[],
  nowEpochSec?: number,
): number {
  if (!hits.length) return 0;
  const now = nowEpochSec ?? Math.floor(Date.now() / 1000);
  let recorded = 0;

  const claim = db.prepare(
    `INSERT OR IGNORE INTO memory_usage_sessions (source, record_id, session_id)
     VALUES (?, ?, ?)`,
  );
  const bump = db.prepare(
    `INSERT INTO memory_usage (source, record_id, hit_count, hits_windowed, last_hit_epoch)
     VALUES (?, ?, 1, 1, ?)
     ON CONFLICT(source, record_id) DO UPDATE SET
       hit_count     = hit_count + 1,
       hits_windowed = hits_windowed + 1,
       last_hit_epoch = excluded.last_hit_epoch`,
  );

  const tx = db.transaction(() => {
    for (const h of hits) {
      // First-in-this-session wins; a repeat in the same session is a no-op.
      if (claim.run(h.source, h.id, sessionId).changes === 0) continue;
      bump.run(h.source, h.id, now);
      recorded++;
    }
  });
  tx();

  return recorded;
}

/**
 * Deduplicate failed attempts across sessions.
 * If the same failure title exists, increment recurrence_count instead of creating a duplicate.
 */
export function deduplicateFailedAttempt(
  db: Database.Database,
  sessionId: string,
  title: string,
  detail: string | null,
  opts?: AddObservationOpts
): number {
  // Check if a similar failed_attempt already exists (across all sessions)
  const existing = db.prepare(`
    SELECT id, recurrence_count FROM observations
    WHERE type = 'failed_attempt' AND title = ?
    ORDER BY created_at_epoch DESC LIMIT 1
  `).get(title) as { id: number; recurrence_count: number } | undefined;

  if (existing) {
    // Increment recurrence count and update detail if newer
    db.prepare('UPDATE observations SET recurrence_count = recurrence_count + 1, detail = COALESCE(?, detail) WHERE id = ?')
      .run(detail, existing.id);
    return existing.id;
  }

  // New failed attempt
  return addObservation(db, sessionId, 'failed_attempt', title, detail, {
    ...opts,
    importance: 5,
  });
}

/**
 * Get all sessions linked to a task/plan.
 */
export function getSessionsByTask(db: Database.Database, taskId: string): Array<{
  session_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  plan_phase: string | null;
}> {
  return db.prepare(`
    SELECT session_id, status, started_at, ended_at, plan_phase
    FROM sessions WHERE task_id = ?
    ORDER BY started_at_epoch DESC
    LIMIT 10000
  `).all(taskId) as Array<{
    session_id: string; status: string; started_at: string;
    ended_at: string | null; plan_phase: string | null;
  }>;
}

/**
 * Aggregate plan_progress across all sessions for a task.
 */
export function getCrossTaskProgress(db: Database.Database, taskId: string): Record<string, string> {
  const sessions = db.prepare(`
    SELECT session_id FROM sessions WHERE task_id = ? LIMIT 10000
  `).all(taskId) as Array<{ session_id: string }>;

  const merged: Record<string, string> = {};
  for (const session of sessions) {
    const summaries = db.prepare(`
      SELECT plan_progress FROM session_summaries WHERE session_id = ? LIMIT 10000
    `).all(session.session_id) as Array<{ plan_progress: string }>;

    for (const summary of summaries) {
      try {
        const progress = JSON.parse(summary.plan_progress) as Record<string, string>;
        for (const [key, value] of Object.entries(progress)) {
          // Later status wins (complete > in_progress > pending)
          if (!merged[key] || value === 'complete' || (value === 'in_progress' && merged[key] === 'pending')) {
            merged[key] = value;
          }
        }
      } catch (_e) {
        // Skip invalid JSON
      }
    }
  }

  return merged;
}

/**
 * Set task_id on a session for multi-session task linking.
 */
export function linkSessionToTask(db: Database.Database, sessionId: string, taskId: string): void {
  db.prepare('UPDATE sessions SET task_id = ? WHERE session_id = ?').run(taskId, sessionId);
}

// ============================================================
// Observability Functions (P2-002, P2-003, P4-001)
// ============================================================

/**
 * Insert a conversation turn into the observability table.
 * Returns the new row ID.
 */
export function addConversationTurn(
  db: Database.Database,
  sessionId: string,
  turnNumber: number,
  userPrompt: string,
  assistantResponse: string | null,
  toolCallsJson: string | null,
  toolCallCount: number,
  promptTokens: number,
  responseTokens: number
): number {
  const result = db.prepare(`
    INSERT INTO conversation_turns (session_id, turn_number, user_prompt, assistant_response, tool_calls_json, tool_call_count, prompt_tokens, response_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, turnNumber, userPrompt,
    assistantResponse ? assistantResponse.slice(0, 10000) : null,
    toolCallsJson, toolCallCount, promptTokens, responseTokens
  );
  return Number(result.lastInsertRowid);
}

/**
 * Insert a tool call detail record.
 */
export function addToolCallDetail(
  db: Database.Database,
  sessionId: string,
  turnNumber: number,
  toolName: string,
  inputSummary: string | null,
  inputSize: number,
  outputSize: number,
  success: boolean,
  filesInvolved?: string[]
): void {
  db.prepare(`
    INSERT INTO tool_call_details (session_id, turn_number, tool_name, tool_input_summary, tool_input_size, tool_output_size, tool_success, files_involved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, turnNumber, toolName,
    inputSummary ? inputSummary.slice(0, 500) : null,
    inputSize, outputSize, success ? 1 : 0,
    filesInvolved ? JSON.stringify(filesInvolved) : null
  );
}

/**
 * Get the last processed line number for incremental transcript parsing.
 */
export function getLastProcessedLine(db: Database.Database, sessionId: string): number {
  const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(`last_processed_line:${sessionId}`) as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

/**
 * Set the last processed line number for incremental transcript parsing.
 */
export function setLastProcessedLine(db: Database.Database, sessionId: string, lineNumber: number): void {
  db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run(`last_processed_line:${sessionId}`, String(lineNumber));
}

/**
 * Delete conversation turns and tool call details older than retention period.
 */
export function pruneOldConversationTurns(db: Database.Database, retentionDays: number = 90): { turnsDeleted: number; detailsDeleted: number } {
  const cutoffEpoch = Math.floor(Date.now() / 1000) - (retentionDays * 86400);
  const turnsResult = db.prepare('DELETE FROM conversation_turns WHERE created_at_epoch < ?').run(cutoffEpoch);
  const detailsResult = db.prepare('DELETE FROM tool_call_details WHERE created_at_epoch < ?').run(cutoffEpoch);
  return { turnsDeleted: turnsResult.changes, detailsDeleted: detailsResult.changes };
}

/**
 * Get conversation turns for a session (for replay).
 */
export function getConversationTurns(db: Database.Database, sessionId: string, opts?: {
  turnFrom?: number;
  turnTo?: number;
  includeToolCalls?: boolean;
}): Array<{
  id: number;
  turn_number: number;
  user_prompt: string;
  assistant_response: string | null;
  tool_calls_json: string | null;
  tool_call_count: number;
  prompt_tokens: number | null;
  response_tokens: number | null;
  created_at: string;
}> {
  let sql = 'SELECT id, turn_number, user_prompt, assistant_response, tool_calls_json, tool_call_count, prompt_tokens, response_tokens, created_at FROM conversation_turns WHERE session_id = ?';
  const params: (string | number)[] = [sessionId];

  if (opts?.turnFrom !== undefined) {
    sql += ' AND turn_number >= ?';
    params.push(opts.turnFrom);
  }
  if (opts?.turnTo !== undefined) {
    sql += ' AND turn_number <= ?';
    params.push(opts.turnTo);
  }

  sql += ' ORDER BY turn_number ASC';

  return db.prepare(sql).all(...params) as Array<{
    id: number; turn_number: number; user_prompt: string;
    assistant_response: string | null; tool_calls_json: string | null;
    tool_call_count: number; prompt_tokens: number | null;
    response_tokens: number | null; created_at: string;
  }>;
}

/**
 * Search conversation turns using FTS5.
 */
export function searchConversationTurns(db: Database.Database, query: string, opts?: {
  sessionId?: string;
  dateFrom?: string;
  dateTo?: string;
  minToolCalls?: number;
  limit?: number;
}): Array<{
  id: number;
  session_id: string;
  turn_number: number;
  user_prompt: string;
  tool_call_count: number;
  response_tokens: number | null;
  created_at: string;
  rank: number;
}> {
  const limit = opts?.limit ?? 20;
  let sql = `
    SELECT ct.id, ct.session_id, ct.turn_number, ct.user_prompt, ct.tool_call_count, ct.response_tokens, ct.created_at, rank
    FROM conversation_turns_fts
    JOIN conversation_turns ct ON conversation_turns_fts.rowid = ct.id
    WHERE conversation_turns_fts MATCH ?
  `;
  const params: (string | number)[] = [sanitizeFts5Query(query)];

  if (opts?.sessionId) {
    sql += ' AND ct.session_id = ?';
    params.push(opts.sessionId);
  }
  if (opts?.dateFrom) {
    sql += ' AND ct.created_at >= ?';
    params.push(opts.dateFrom);
  }
  if (opts?.dateTo) {
    sql += ' AND ct.created_at <= ?';
    params.push(opts.dateTo);
  }
  if (opts?.minToolCalls !== undefined) {
    sql += ' AND ct.tool_call_count >= ?';
    params.push(opts.minToolCalls);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as Array<{
    id: number; session_id: string; turn_number: number;
    user_prompt: string; tool_call_count: number;
    response_tokens: number | null; created_at: string; rank: number;
  }>;
}

/**
 * Get tool usage patterns (aggregated stats).
 */
export function getToolPatterns(db: Database.Database, opts?: {
  sessionId?: string;
  toolName?: string;
  dateFrom?: string;
  groupBy?: 'tool' | 'session' | 'day';
}): Array<Record<string, unknown>> {
  const groupBy = opts?.groupBy ?? 'tool';
  const params: (string | number)[] = [];
  let whereClause = '';
  const conditions: string[] = [];

  if (opts?.sessionId) {
    conditions.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts?.toolName) {
    conditions.push('tool_name = ?');
    params.push(opts.toolName);
  }
  if (opts?.dateFrom) {
    conditions.push('created_at >= ?');
    params.push(opts.dateFrom);
  }

  if (conditions.length > 0) {
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }

  let sql: string;
  switch (groupBy) {
    case 'session':
      sql = `SELECT session_id, COUNT(*) as call_count, COUNT(DISTINCT tool_name) as unique_tools,
             SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN tool_success = 0 THEN 1 ELSE 0 END) as failures,
             AVG(tool_output_size) as avg_output_size
             FROM tool_call_details ${whereClause}
             GROUP BY session_id ORDER BY call_count DESC`;
      break;
    case 'day':
      sql = `SELECT date(created_at) as day, COUNT(*) as call_count, COUNT(DISTINCT tool_name) as unique_tools,
             SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successes
             FROM tool_call_details ${whereClause}
             GROUP BY date(created_at) ORDER BY day DESC`;
      break;
    default: // 'tool'
      sql = `SELECT tool_name, COUNT(*) as call_count,
             SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN tool_success = 0 THEN 1 ELSE 0 END) as failures,
             AVG(tool_output_size) as avg_output_size,
             AVG(tool_input_size) as avg_input_size
             FROM tool_call_details ${whereClause}
             GROUP BY tool_name ORDER BY call_count DESC`;
      break;
  }

  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/**
 * Get session stats for observability.
 */
export function getSessionStats(db: Database.Database, opts?: {
  sessionId?: string;
  limit?: number;
}): Array<Record<string, unknown>> {
  if (opts?.sessionId) {
    // Single session stats
    const turns = db.prepare('SELECT COUNT(*) as turn_count, SUM(tool_call_count) as total_tool_calls, SUM(prompt_tokens) as total_prompt_tokens, SUM(response_tokens) as total_response_tokens FROM conversation_turns WHERE session_id = ?').get(opts.sessionId) as Record<string, unknown>;
    const toolBreakdown = db.prepare('SELECT tool_name, COUNT(*) as count FROM tool_call_details WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC').all(opts.sessionId) as Array<Record<string, unknown>>;
    const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(opts.sessionId) as Record<string, unknown> | undefined;

    return [{
      session_id: opts.sessionId,
      status: session?.status ?? 'unknown',
      started_at: session?.started_at ?? null,
      ended_at: session?.ended_at ?? null,
      ...turns,
      tool_breakdown: toolBreakdown,
    }];
  }

  const limit = opts?.limit ?? 10;
  return db.prepare(`
    SELECT s.session_id, s.status, s.started_at, s.ended_at,
           COUNT(ct.id) as turn_count,
           COALESCE(SUM(ct.tool_call_count), 0) as total_tool_calls,
           COALESCE(SUM(ct.prompt_tokens), 0) as total_prompt_tokens,
           COALESCE(SUM(ct.response_tokens), 0) as total_response_tokens
    FROM sessions s
    LEFT JOIN conversation_turns ct ON s.session_id = ct.session_id
    GROUP BY s.session_id
    ORDER BY s.started_at_epoch DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
}

/**
 * Get database size information for observability monitoring.
 */
export function getObservabilityDbSize(db: Database.Database): {
  conversation_turns_count: number;
  tool_call_details_count: number;
  observations_count: number;
  db_page_count: number;
  db_page_size: number;
  estimated_size_mb: number;
} {
  const turnsCount = (db.prepare('SELECT COUNT(*) as c FROM conversation_turns').get() as { c: number }).c;
  const detailsCount = (db.prepare('SELECT COUNT(*) as c FROM tool_call_details').get() as { c: number }).c;
  const obsCount = (db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number }).c;
  const pageCount = (db.pragma('page_count') as Array<{ page_count: number }>)[0]?.page_count ?? 0;
  const pageSize = (db.pragma('page_size') as Array<{ page_size: number }>)[0]?.page_size ?? 4096;

  return {
    conversation_turns_count: turnsCount,
    tool_call_details_count: detailsCount,
    observations_count: obsCount,
    db_page_count: pageCount,
    db_page_size: pageSize,
    estimated_size_mb: Math.round((pageCount * pageSize) / (1024 * 1024) * 100) / 100,
  };
}

// ============================================================
// Failure Classification: CRUD functions
// ============================================================

export interface FailureClass {
  id: number;
  name: string;
  description: string;
  diff_patterns: string[];
  file_patterns: string[];
  prompt_keywords: string[];
  incidents: string[];
  rules: string[];
  scanner_checks: string[];
  known_message: string;
  needs_review: boolean;
}

export interface AddFailureClassOpts {
  name: string;
  description: string;
  diffPatterns?: string[];
  filePatterns?: string[];
  promptKeywords?: string[];
  incidents?: string[];
  rules?: string[];
  scannerChecks?: string[];
  knownMessage?: string;
  needsReview?: boolean;
}

/**
 * Add a new failure class to the taxonomy.
 */
export function addFailureClass(db: Database.Database, opts: AddFailureClassOpts): number {
  const result = db.prepare(`
    INSERT OR IGNORE INTO failure_classes (name, description, diff_patterns, file_patterns, prompt_keywords, incidents, rules, scanner_checks, known_message, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.name,
    opts.description,
    JSON.stringify(opts.diffPatterns ?? []),
    JSON.stringify(opts.filePatterns ?? []),
    JSON.stringify(opts.promptKeywords ?? []),
    JSON.stringify(opts.incidents ?? []),
    JSON.stringify(opts.rules ?? []),
    JSON.stringify(opts.scannerChecks ?? []),
    opts.knownMessage ?? '',
    opts.needsReview ? 1 : 0
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get all failure classes from the taxonomy.
 */
export function getFailureClasses(db: Database.Database): FailureClass[] {
  const rows = db.prepare('SELECT * FROM failure_classes ORDER BY name LIMIT 10000').all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as number,
    name: row.name as string,
    description: row.description as string,
    diff_patterns: JSON.parse((row.diff_patterns as string) || '[]'),
    file_patterns: JSON.parse((row.file_patterns as string) || '[]'),
    prompt_keywords: JSON.parse((row.prompt_keywords as string) || '[]'),
    incidents: JSON.parse((row.incidents as string) || '[]'),
    rules: JSON.parse((row.rules as string) || '[]'),
    scanner_checks: JSON.parse((row.scanner_checks as string) || '[]'),
    known_message: row.known_message as string,
    needs_review: !!(row.needs_review as number),
  }));
}

/**
 * Append an incident identifier to an existing failure class.
 */
export function appendIncidentToFailureClass(db: Database.Database, className: string, incidentId: string): void {
  const row = db.prepare('SELECT incidents FROM failure_classes WHERE name = ?').get(className) as { incidents: string } | undefined;
  if (!row) return;
  const incidents: string[] = JSON.parse(row.incidents || '[]');
  if (!incidents.includes(incidentId)) {
    incidents.push(incidentId);
    db.prepare('UPDATE failure_classes SET incidents = ?, updated_at = datetime(\'now\') WHERE name = ?')
      .run(JSON.stringify(incidents), className);
  }
}

export interface FailureClassMatch {
  name: string;
  score: number;
  incidentCount: number;
  rules: string[];
  knownMessage: string;
}

/**
 * Score all failure classes against provided match text, file path, and prompt context.
 * Returns the best match with its score.
 */
export function scoreFailureClasses(
  db: Database.Database,
  matchText: string,
  filePath: string,
  promptContext: string,
  weights?: { diffPatternWeight?: number; filePatternWeight?: number; promptKeywordWeight?: number }
): FailureClassMatch | null {
  const classes = getFailureClasses(db);
  if (classes.length === 0) return null;

  const diffWeight = weights?.diffPatternWeight ?? 3;
  const fileWeight = weights?.filePatternWeight ?? 2;
  const promptWeight = weights?.promptKeywordWeight ?? 2;

  let bestMatch: FailureClassMatch | null = null;

  for (const fc of classes) {
    let score = 0;

    for (const pattern of fc.diff_patterns) {
      if (!pattern) continue;
      try {
        if (new RegExp(pattern, 'i').test(matchText)) {
          score += diffWeight;
        }
      } catch {
        if (matchText.toLowerCase().includes(pattern.toLowerCase())) {
          score += diffWeight;
        }
      }
    }

    for (const pattern of fc.file_patterns) {
      if (!pattern) continue;
      try {
        if (new RegExp(pattern).test(filePath)) {
          score += fileWeight;
        }
      } catch {
        if (filePath.includes(pattern)) {
          score += fileWeight;
        }
      }
    }

    if (promptContext) {
      for (const keyword of fc.prompt_keywords) {
        if (!keyword) continue;
        try {
          if (new RegExp(keyword, 'i').test(promptContext)) {
            score += promptWeight;
          }
        } catch {
          if (promptContext.toLowerCase().includes(keyword.toLowerCase())) {
            score += promptWeight;
          }
        }
      }
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        name: fc.name,
        score,
        incidentCount: fc.incidents.length,
        rules: fc.rules,
        knownMessage: fc.known_message,
      };
    }
  }

  return bestMatch;
}

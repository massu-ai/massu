// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import Database from 'better-sqlite3';
import { resolve, dirname, basename } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getConfig, getResolvedPaths, getProjectRoot } from './config.ts';

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

// ============================================================
// P1-001: Memory Database Schema
// ============================================================

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
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  return db;
}

function initMemorySchema(db: Database.Database): void {
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_po_session ON prompt_outcomes(session_id);
    CREATE INDEX IF NOT EXISTS idx_po_category ON prompt_outcomes(prompt_category);
  `);

  // P2-001: Compliance audit log
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      event_type TEXT NOT NULL CHECK(event_type IN ('code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction')),
      actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
      model_id TEXT,
      file_path TEXT,
      change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
      rules_in_effect TEXT,
      approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
      evidence TEXT,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_al_session ON audit_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_al_file ON audit_log(file_path);
    CREATE INDEX IF NOT EXISTS idx_al_event ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_al_timestamp ON audit_log(timestamp DESC);
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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

/**
 * Dequeue pending sync items (oldest first).
 * Items with retry_count >= 10 are silently discarded to prevent infinite accumulation.
 */
export function dequeuePendingSync(
  db: Database.Database,
  limit: number = 10
): Array<{ id: number; payload: string; retry_count: number }> {
  // First, discard items that have exceeded max retries
  const stale = db.prepare(
    'SELECT id FROM pending_sync WHERE retry_count >= 10'
  ).all() as Array<{ id: number }>;
  if (stale.length > 0) {
    const ids = stale.map(s => s.id);
    db.prepare(`DELETE FROM pending_sync WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
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
  const result = db.prepare(`
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
    now.toISOString(),
    Math.floor(now.getTime() / 1000)
  );
  return Number(result.lastInsertRowid);
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

/**
 * Delete observations older than retention period.
 */
export function pruneOldObservations(db: Database.Database, retentionDays: number = 90): number {
  const cutoffEpoch = Math.floor(Date.now() / 1000) - (retentionDays * 86400);
  const result = db.prepare('DELETE FROM observations WHERE created_at_epoch < ?').run(cutoffEpoch);
  return result.changes;
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
    SELECT session_id FROM sessions WHERE task_id = ?
  `).all(taskId) as Array<{ session_id: string }>;

  const merged: Record<string, string> = {};
  for (const session of sessions) {
    const summaries = db.prepare(`
      SELECT plan_progress FROM session_summaries WHERE session_id = ?
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

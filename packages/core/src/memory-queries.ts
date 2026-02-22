// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Memory database CRUD query functions.
 * Split from memory-db.ts (P3-001 remediation) to keep memory-db.ts
 * focused on connection factory + schema initialization.
 */

import type Database from 'better-sqlite3';
import { basename } from 'path';

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
  db.prepare('DELETE FROM pending_sync WHERE retry_count >= 10').run();

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
// P1-002: Database Access Functions
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
  const params: (string | number)[] = [query];

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
    `).all(query, limit) as Array<{
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
  `).all(query, limit) as Array<{
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
  const params: (string | number)[] = [query];

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

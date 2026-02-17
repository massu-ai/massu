// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { unlinkSync, existsSync, writeFileSync } from 'fs';
import {
  createSession,
  addConversationTurn,
  addToolCallDetail,
  getConversationTurns,
  searchConversationTurns,
  getToolPatterns,
  getSessionStats,
  getObservabilityDbSize,
  pruneOldConversationTurns,
  getLastProcessedLine,
  setLastProcessedLine,
} from '../memory-db.ts';
import { parseTranscriptFrom } from '../transcript-parser.ts';

// Test database path
const TEST_DB_PATH = resolve(__dirname, '../test-observability.db');

/**
 * Create a test database with the full memory schema including observability tables.
 * Mirrors initMemorySchema() from memory-db.ts.
 */
function createTestDb(): Database.Database {
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }

  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Base schema
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Observability tables (P1-001, P1-002)
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

  // FTS5 for conversation turns (P1-003)
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
    // ignore
  }

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

  return db;
}

describe('Observability', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Create a test session
    createSession(db, 'test-session-001');
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('Schema Creation', () => {
    it('creates conversation_turns table', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_turns'").all() as { name: string }[];
      expect(tables.length).toBe(1);
    });

    it('creates tool_call_details table', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_call_details'").all() as { name: string }[];
      expect(tables.length).toBe(1);
    });

    it('creates conversation_turns_fts virtual table', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conversation_turns_fts%'").all() as { name: string }[];
      expect(tables.length).toBeGreaterThan(0);
    });
  });

  describe('addConversationTurn', () => {
    it('inserts and retrieves a conversation turn', () => {
      const id = addConversationTurn(
        db, 'test-session-001', 1,
        'How do I fix the login bug?',
        'You need to check the auth middleware for the session expiry...',
        JSON.stringify([{ name: 'Read', input_summary: 'Read src/middleware.ts', is_error: false }]),
        1, 50, 200
      );

      expect(id).toBeGreaterThan(0);

      const turns = getConversationTurns(db, 'test-session-001');
      expect(turns.length).toBe(1);
      expect(turns[0].turn_number).toBe(1);
      expect(turns[0].user_prompt).toBe('How do I fix the login bug?');
      expect(turns[0].tool_call_count).toBe(1);
    });

    it('truncates assistant_response to 10000 chars', () => {
      const longResponse = 'A'.repeat(15000);
      addConversationTurn(db, 'test-session-001', 1, 'test', longResponse, null, 0, 10, 3750);

      const turns = getConversationTurns(db, 'test-session-001');
      expect(turns[0].assistant_response!.length).toBe(10000);
    });

    it('supports turn range filtering', () => {
      addConversationTurn(db, 'test-session-001', 1, 'Turn 1', 'Response 1', null, 0, 10, 20);
      addConversationTurn(db, 'test-session-001', 2, 'Turn 2', 'Response 2', null, 0, 10, 20);
      addConversationTurn(db, 'test-session-001', 3, 'Turn 3', 'Response 3', null, 0, 10, 20);

      const filtered = getConversationTurns(db, 'test-session-001', { turnFrom: 2, turnTo: 3 });
      expect(filtered.length).toBe(2);
      expect(filtered[0].turn_number).toBe(2);
      expect(filtered[1].turn_number).toBe(3);
    });
  });

  describe('addToolCallDetail', () => {
    it('inserts and retrieves tool call details', () => {
      addToolCallDetail(db, 'test-session-001', 1, 'Read', 'Read src/index.ts', 50, 1200, true, ['src/index.ts']);
      addToolCallDetail(db, 'test-session-001', 1, 'Edit', 'Edit src/index.ts', 200, 50, true, ['src/index.ts']);
      addToolCallDetail(db, 'test-session-001', 1, 'Bash', '$ npm run build', 30, 5000, false);

      const details = db.prepare('SELECT * FROM tool_call_details WHERE session_id = ? ORDER BY id').all('test-session-001') as Array<Record<string, unknown>>;
      expect(details.length).toBe(3);
      expect(details[0].tool_name).toBe('Read');
      expect(details[0].tool_success).toBe(1);
      expect(details[2].tool_name).toBe('Bash');
      expect(details[2].tool_success).toBe(0);
    });

    it('truncates tool_input_summary to 500 chars', () => {
      const longSummary = 'X'.repeat(1000);
      addToolCallDetail(db, 'test-session-001', 1, 'Read', longSummary, 1000, 100, true);

      const details = db.prepare('SELECT tool_input_summary FROM tool_call_details WHERE session_id = ?').all('test-session-001') as Array<{ tool_input_summary: string }>;
      expect(details[0].tool_input_summary.length).toBe(500);
    });
  });

  describe('FTS5 Search', () => {
    it('searches conversation turns by prompt text', () => {
      addConversationTurn(db, 'test-session-001', 1, 'Fix the authentication middleware', 'Check the JWT token...', null, 0, 50, 100);
      addConversationTurn(db, 'test-session-001', 2, 'Run the database migration', 'Use npx prisma migrate...', null, 0, 30, 80);

      const results = searchConversationTurns(db, 'authentication');
      expect(results.length).toBe(1);
      expect(results[0].user_prompt).toContain('authentication');
    });

    it('filters by session_id', () => {
      createSession(db, 'test-session-002');
      addConversationTurn(db, 'test-session-001', 1, 'Fix the bug', 'Response 1', null, 0, 10, 20);
      addConversationTurn(db, 'test-session-002', 1, 'Fix the bug', 'Response 2', null, 0, 10, 20);

      const results = searchConversationTurns(db, 'bug', { sessionId: 'test-session-002' });
      expect(results.length).toBe(1);
      expect(results[0].session_id).toBe('test-session-002');
    });

    it('filters by min_tool_calls', () => {
      addConversationTurn(db, 'test-session-001', 1, 'Simple question about code', 'Answer', null, 0, 10, 20);
      addConversationTurn(db, 'test-session-001', 2, 'Complex question about code', 'Answer with tools', '[]', 5, 10, 200);

      const results = searchConversationTurns(db, 'question', { minToolCalls: 3 });
      expect(results.length).toBe(1);
      expect(results[0].tool_call_count).toBe(5);
    });
  });

  describe('Tool Patterns', () => {
    it('aggregates tool usage by tool name', () => {
      addToolCallDetail(db, 'test-session-001', 1, 'Read', 'Read file1', 50, 1000, true);
      addToolCallDetail(db, 'test-session-001', 1, 'Read', 'Read file2', 60, 2000, true);
      addToolCallDetail(db, 'test-session-001', 2, 'Edit', 'Edit file1', 200, 50, true);
      addToolCallDetail(db, 'test-session-001', 2, 'Bash', '$ npm test', 30, 500, false);

      const patterns = getToolPatterns(db, { groupBy: 'tool' });
      expect(patterns.length).toBe(3);

      const readPattern = patterns.find(p => p.tool_name === 'Read');
      expect(readPattern).toBeDefined();
      expect(readPattern!.call_count).toBe(2);
      expect(readPattern!.successes).toBe(2);

      const bashPattern = patterns.find(p => p.tool_name === 'Bash');
      expect(bashPattern!.failures).toBe(1);
    });

    it('groups by session', () => {
      createSession(db, 'test-session-002');
      addToolCallDetail(db, 'test-session-001', 1, 'Read', 'Read file', 50, 1000, true);
      addToolCallDetail(db, 'test-session-002', 1, 'Read', 'Read file', 50, 2000, true);
      addToolCallDetail(db, 'test-session-002', 1, 'Edit', 'Edit file', 200, 50, true);

      const patterns = getToolPatterns(db, { groupBy: 'session' });
      expect(patterns.length).toBe(2);
    });
  });

  describe('Session Stats', () => {
    it('returns session statistics', () => {
      addConversationTurn(db, 'test-session-001', 1, 'Question 1', 'Answer 1', null, 2, 50, 200);
      addConversationTurn(db, 'test-session-001', 2, 'Question 2', 'Answer 2', null, 3, 40, 150);
      addToolCallDetail(db, 'test-session-001', 1, 'Read', 'file', 50, 1000, true);

      const stats = getSessionStats(db, { sessionId: 'test-session-001' });
      expect(stats.length).toBe(1);
      expect(stats[0].turn_count).toBe(2);
      expect(stats[0].total_tool_calls).toBe(5); // 2 + 3
    });

    it('returns multi-session overview', () => {
      createSession(db, 'test-session-002');
      addConversationTurn(db, 'test-session-001', 1, 'Q1', 'A1', null, 1, 10, 20);
      addConversationTurn(db, 'test-session-002', 1, 'Q1', 'A1', null, 2, 10, 20);

      const stats = getSessionStats(db, { limit: 10 });
      expect(stats.length).toBe(2);
    });
  });

  describe('Database Size Monitoring', () => {
    it('returns accurate counts', () => {
      addConversationTurn(db, 'test-session-001', 1, 'Q', 'A', null, 0, 10, 20);
      addToolCallDetail(db, 'test-session-001', 1, 'Read', 'file', 50, 1000, true);

      const size = getObservabilityDbSize(db);
      expect(size.conversation_turns_count).toBe(1);
      expect(size.tool_call_details_count).toBe(1);
      expect(size.estimated_size_mb).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Pruning', () => {
    it('deletes old conversation turns and tool call details', () => {
      // Insert records with old timestamps
      db.prepare(`
        INSERT INTO conversation_turns (session_id, turn_number, user_prompt, created_at_epoch)
        VALUES (?, ?, ?, ?)
      `).run('test-session-001', 1, 'Old question', Math.floor(Date.now() / 1000) - (100 * 86400)); // 100 days ago

      db.prepare(`
        INSERT INTO tool_call_details (session_id, turn_number, tool_name, created_at_epoch)
        VALUES (?, ?, ?, ?)
      `).run('test-session-001', 1, 'Read', Math.floor(Date.now() / 1000) - (100 * 86400));

      // Insert recent records
      addConversationTurn(db, 'test-session-001', 2, 'Recent question', 'Answer', null, 0, 10, 20);
      addToolCallDetail(db, 'test-session-001', 2, 'Edit', 'file', 50, 100, true);

      const result = pruneOldConversationTurns(db, 90);
      expect(result.turnsDeleted).toBe(1);
      expect(result.detailsDeleted).toBe(1);

      // Verify recent records remain
      const remaining = db.prepare('SELECT COUNT(*) as c FROM conversation_turns').get() as { c: number };
      expect(remaining.c).toBe(1);
    });
  });

  describe('Incremental Parsing State', () => {
    it('tracks last processed line', () => {
      expect(getLastProcessedLine(db, 'test-session-001')).toBe(0);

      setLastProcessedLine(db, 'test-session-001', 150);
      expect(getLastProcessedLine(db, 'test-session-001')).toBe(150);

      // Update existing value
      setLastProcessedLine(db, 'test-session-001', 300);
      expect(getLastProcessedLine(db, 'test-session-001')).toBe(300);
    });

    it('tracks different sessions independently', () => {
      setLastProcessedLine(db, 'test-session-001', 100);
      setLastProcessedLine(db, 'test-session-002', 200);

      expect(getLastProcessedLine(db, 'test-session-001')).toBe(100);
      expect(getLastProcessedLine(db, 'test-session-002')).toBe(200);
    });
  });

  describe('parseTranscriptFrom', () => {
    const MOCK_TRANSCRIPT_PATH = resolve(__dirname, '../test-transcript.jsonl');

    afterEach(() => {
      if (existsSync(MOCK_TRANSCRIPT_PATH)) {
        unlinkSync(MOCK_TRANSCRIPT_PATH);
      }
    });

    it('parses from a specific line', async () => {
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'First message' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Second message' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] } }),
      ];
      writeFileSync(MOCK_TRANSCRIPT_PATH, lines.join('\n') + '\n');

      // Parse from line 2 (skip first 2 lines)
      const { entries, totalLines } = await parseTranscriptFrom(MOCK_TRANSCRIPT_PATH, 2);
      expect(totalLines).toBe(4);
      expect(entries.length).toBe(2);
      expect(entries[0].type).toBe('user');
      expect(entries[1].type).toBe('assistant');
    });

    it('returns empty entries when no new lines', async () => {
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Only message' }] } }),
      ];
      writeFileSync(MOCK_TRANSCRIPT_PATH, lines.join('\n') + '\n');

      const { entries, totalLines } = await parseTranscriptFrom(MOCK_TRANSCRIPT_PATH, 1);
      expect(totalLines).toBe(1);
      expect(entries.length).toBe(0);
    });
  });
});

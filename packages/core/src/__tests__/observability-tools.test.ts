// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  isObservabilityTool,
  getObservabilityToolDefinitions,
  handleObservabilityToolCall,
} from '../observability-tools.ts';
import {
  createSession,
  addConversationTurn,
  addToolCallDetail,
} from '../memory-db.ts';

// Mock config to use 'massu' as tool prefix
vi.mock('../config.ts', () => ({
  getConfig: () => ({ toolPrefix: 'massu' }),
}));

/**
 * Create an in-memory test database with the schema needed by observability tools.
 * Mirrors the relevant tables from initMemorySchema() in memory-db.ts.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Sessions table
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
  `);

  // Observations table (needed for getObservabilityDbSize)
  db.exec(`
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
  `);

  // Memory meta table (needed for incremental parsing state)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Conversation turns table
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

  // Tool call details table
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

  // FTS5 for conversation turns
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

/** Helper: extract text from a ToolResult */
function getText(result: { content: { type: 'text'; text: string }[] }): string {
  return result.content[0].text;
}

describe('observability-tools (3-function pattern)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, 'session-001');
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================
  // 1. isObservabilityTool()
  // ============================================================
  describe('isObservabilityTool', () => {
    it('returns true for all 4 prefixed tool names', () => {
      expect(isObservabilityTool('massu_session_replay')).toBe(true);
      expect(isObservabilityTool('massu_prompt_analysis')).toBe(true);
      expect(isObservabilityTool('massu_tool_patterns')).toBe(true);
      expect(isObservabilityTool('massu_session_stats')).toBe(true);
    });

    it('returns true for base names without prefix', () => {
      expect(isObservabilityTool('session_replay')).toBe(true);
      expect(isObservabilityTool('prompt_analysis')).toBe(true);
      expect(isObservabilityTool('tool_patterns')).toBe(true);
      expect(isObservabilityTool('session_stats')).toBe(true);
    });

    it('returns false for unknown tool names', () => {
      expect(isObservabilityTool('massu_quality_score')).toBe(false);
      expect(isObservabilityTool('massu_cost_session')).toBe(false);
      expect(isObservabilityTool('random_tool')).toBe(false);
      expect(isObservabilityTool('')).toBe(false);
      expect(isObservabilityTool('massu_session_replay_extra')).toBe(false);
    });
  });

  // ============================================================
  // 2. getObservabilityToolDefinitions()
  // ============================================================
  describe('getObservabilityToolDefinitions', () => {
    it('returns exactly 4 tool definitions', () => {
      const defs = getObservabilityToolDefinitions();
      expect(defs.length).toBe(4);
    });

    it('all definitions have required fields (name, description, inputSchema)', () => {
      const defs = getObservabilityToolDefinitions();
      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeTruthy();
        expect(def.inputSchema.type).toBe('object');
        expect(def.inputSchema.properties).toBeDefined();
      }
    });

    it('tool names use the configured prefix', () => {
      const defs = getObservabilityToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('massu_session_replay');
      expect(names).toContain('massu_prompt_analysis');
      expect(names).toContain('massu_tool_patterns');
      expect(names).toContain('massu_session_stats');
    });

    it('session_replay requires session_id', () => {
      const defs = getObservabilityToolDefinitions();
      const replay = defs.find(d => d.name === 'massu_session_replay');
      expect(replay).toBeDefined();
      expect(replay!.inputSchema.required).toEqual(['session_id']);
    });

    it('other tools have empty required arrays', () => {
      const defs = getObservabilityToolDefinitions();
      const nonReplay = defs.filter(d => d.name !== 'massu_session_replay');
      for (const def of nonReplay) {
        expect(def.inputSchema.required).toEqual([]);
      }
    });
  });

  // ============================================================
  // 3. handleObservabilityToolCall - session_replay
  // ============================================================
  describe('handleObservabilityToolCall - session_replay', () => {
    it('returns replay for session with turns', () => {
      addConversationTurn(db, 'session-001', 1, 'How do I fix the bug?', 'Check the middleware...', null, 2, 50, 200);
      addConversationTurn(db, 'session-001', 2, 'What about tests?', 'Run vitest to verify...', null, 1, 30, 100);

      const result = handleObservabilityToolCall('massu_session_replay', { session_id: 'session-001' }, db);
      const text = getText(result);

      expect(text).toContain('Session Replay');
      expect(text).toContain('Turn 1');
      expect(text).toContain('Turn 2');
      expect(text).toContain('How do I fix the bug?');
      expect(text).toContain('Check the middleware...');
      expect(text).toContain('Turns: 2');
    });

    it('returns error when session_id is missing', () => {
      const result = handleObservabilityToolCall('massu_session_replay', {}, db);
      const text = getText(result);

      expect(text).toContain('Error: session_id is required');
    });

    it('returns message when no turns found for session', () => {
      const result = handleObservabilityToolCall('massu_session_replay', { session_id: 'non-existent-session' }, db);
      const text = getText(result);

      expect(text).toContain('No conversation turns found');
      expect(text).toContain('session-end hook');
    });

    it('includes tool call details when include_tool_calls is true', () => {
      const toolCalls = JSON.stringify([
        { name: 'Read', input_summary: 'Read src/index.ts', is_error: false },
        { name: 'Bash', input_summary: '$ npm test', is_error: true },
      ]);
      addConversationTurn(db, 'session-001', 1, 'Fix the tests', 'Let me check...', toolCalls, 2, 50, 200);

      const result = handleObservabilityToolCall('massu_session_replay', {
        session_id: 'session-001',
        include_tool_calls: true,
      }, db);
      const text = getText(result);

      expect(text).toContain('Tool Calls');
      expect(text).toContain('Read: Read src/index.ts');
      expect(text).toContain('Bash: $ npm test');
      expect(text).toContain('[ERROR]');
    });

    it('does not include tool call details when include_tool_calls is false', () => {
      const toolCalls = JSON.stringify([
        { name: 'Read', input_summary: 'Read src/index.ts', is_error: false },
      ]);
      addConversationTurn(db, 'session-001', 1, 'Fix the tests', 'Let me check...', toolCalls, 1, 50, 200);

      const result = handleObservabilityToolCall('massu_session_replay', {
        session_id: 'session-001',
        include_tool_calls: false,
      }, db);
      const text = getText(result);

      expect(text).not.toContain('Tool Calls');
      expect(text).not.toContain('Read: Read src/index.ts');
    });

    it('respects turn_from and turn_to range filters', () => {
      addConversationTurn(db, 'session-001', 1, 'Turn one prompt', 'Response 1', null, 0, 10, 20);
      addConversationTurn(db, 'session-001', 2, 'Turn two prompt', 'Response 2', null, 0, 10, 20);
      addConversationTurn(db, 'session-001', 3, 'Turn three prompt', 'Response 3', null, 0, 10, 20);

      const result = handleObservabilityToolCall('massu_session_replay', {
        session_id: 'session-001',
        turn_from: 2,
        turn_to: 3,
      }, db);
      const text = getText(result);

      expect(text).toContain('Turn 2');
      expect(text).toContain('Turn 3');
      expect(text).not.toContain('Turn one prompt');
      expect(text).toContain('Turns: 2');
    });
  });

  // ============================================================
  // 4. handleObservabilityToolCall - prompt_analysis
  // ============================================================
  describe('handleObservabilityToolCall - prompt_analysis', () => {
    it('shows recent prompts when no query is provided', () => {
      addConversationTurn(db, 'session-001', 1, 'Fix the authentication bug', 'Check JWT tokens...', null, 3, 50, 200);
      addConversationTurn(db, 'session-001', 2, 'Run the database migration', 'Use prisma migrate...', null, 1, 30, 100);

      const result = handleObservabilityToolCall('massu_prompt_analysis', {}, db);
      const text = getText(result);

      expect(text).toContain('Recent Prompts');
      expect(text).toContain('Fix the authentication bug');
      expect(text).toContain('Run the database migration');
    });

    it('searches prompts using FTS5 query', () => {
      addConversationTurn(db, 'session-001', 1, 'Fix the authentication middleware', 'Check JWT tokens...', null, 0, 50, 200);
      addConversationTurn(db, 'session-001', 2, 'Run the database migration', 'Use prisma migrate...', null, 0, 30, 100);

      const result = handleObservabilityToolCall('massu_prompt_analysis', { query: 'authentication' }, db);
      const text = getText(result);

      expect(text).toContain('Prompt Search');
      expect(text).toContain('authentication');
      expect(text).toContain('1 results');
    });

    it('returns no-results message for FTS query with no matches', () => {
      addConversationTurn(db, 'session-001', 1, 'Fix the bug', 'Response here', null, 0, 10, 20);

      const result = handleObservabilityToolCall('massu_prompt_analysis', { query: 'nonexistent_term_xyz' }, db);
      const text = getText(result);

      expect(text).toContain('No prompts found matching');
    });

    it('returns no-data message when database is empty', () => {
      const result = handleObservabilityToolCall('massu_prompt_analysis', {}, db);
      const text = getText(result);

      expect(text).toContain('No conversation turns recorded yet');
    });

    it('respects the limit parameter', () => {
      for (let i = 1; i <= 5; i++) {
        addConversationTurn(db, 'session-001', i, `Prompt number ${i}`, `Response ${i}`, null, 0, 10, 20);
      }

      const result = handleObservabilityToolCall('massu_prompt_analysis', { limit: 2 }, db);
      const text = getText(result);

      // Should contain "Recent Prompts" header plus table header + 2 data rows
      const dataRows = text.split('\n').filter(line => line.startsWith('|') && !line.startsWith('|--') && !line.includes('Session'));
      expect(dataRows.length).toBeLessThanOrEqual(2);
    });
  });

  // ============================================================
  // 5. handleObservabilityToolCall - tool_patterns
  // ============================================================
  describe('handleObservabilityToolCall - tool_patterns', () => {
    it('groups by tool by default', () => {
      addToolCallDetail(db, 'session-001', 1, 'Read', 'Read file1', 50, 1000, true);
      addToolCallDetail(db, 'session-001', 1, 'Read', 'Read file2', 60, 2000, true);
      addToolCallDetail(db, 'session-001', 2, 'Edit', 'Edit file1', 200, 50, true);
      addToolCallDetail(db, 'session-001', 2, 'Bash', '$ npm test', 30, 500, false);

      const result = handleObservabilityToolCall('massu_tool_patterns', {}, db);
      const text = getText(result);

      expect(text).toContain('Tool Usage Patterns (grouped by tool)');
      expect(text).toContain('Read');
      expect(text).toContain('Edit');
      expect(text).toContain('Bash');
      expect(text).toContain('Success Rate');
    });

    it('groups by session when group_by is session', () => {
      createSession(db, 'session-002');
      addToolCallDetail(db, 'session-001', 1, 'Read', 'Read file', 50, 1000, true);
      addToolCallDetail(db, 'session-002', 1, 'Edit', 'Edit file', 200, 50, true);

      const result = handleObservabilityToolCall('massu_tool_patterns', { group_by: 'session' }, db);
      const text = getText(result);

      expect(text).toContain('Tool Usage Patterns (grouped by session)');
      expect(text).toContain('Unique Tools');
    });

    it('groups by day when group_by is day', () => {
      addToolCallDetail(db, 'session-001', 1, 'Read', 'Read file', 50, 1000, true);
      addToolCallDetail(db, 'session-001', 2, 'Edit', 'Edit file', 200, 50, true);

      const result = handleObservabilityToolCall('massu_tool_patterns', { group_by: 'day' }, db);
      const text = getText(result);

      expect(text).toContain('Tool Usage Patterns (grouped by day)');
      expect(text).toContain('Day');
    });

    it('returns no-data message when no tool usage exists', () => {
      const result = handleObservabilityToolCall('massu_tool_patterns', {}, db);
      const text = getText(result);

      expect(text).toContain('No tool usage data recorded yet');
    });

    it('shows success rate calculation for tool group', () => {
      // 2 successes and 1 failure for Read
      addToolCallDetail(db, 'session-001', 1, 'Read', 'Read file1', 50, 1000, true);
      addToolCallDetail(db, 'session-001', 1, 'Read', 'Read file2', 60, 2000, true);
      addToolCallDetail(db, 'session-001', 2, 'Read', 'Read file3', 40, 0, false);

      const result = handleObservabilityToolCall('massu_tool_patterns', {}, db);
      const text = getText(result);

      // 2 out of 3 = 67%
      expect(text).toContain('67%');
    });
  });

  // ============================================================
  // 6. handleObservabilityToolCall - session_stats
  // ============================================================
  describe('handleObservabilityToolCall - session_stats', () => {
    it('returns detailed stats for a single session', () => {
      addConversationTurn(db, 'session-001', 1, 'Question 1', 'Answer 1', null, 2, 50, 200);
      addConversationTurn(db, 'session-001', 2, 'Question 2', 'Answer 2', null, 3, 40, 150);
      addToolCallDetail(db, 'session-001', 1, 'Read', 'file', 50, 1000, true);

      const result = handleObservabilityToolCall('massu_session_stats', { session_id: 'session-001' }, db);
      const text = getText(result);

      expect(text).toContain('Session Statistics');
      expect(text).toContain('Session: session-001');
      expect(text).toContain('Turns');
      expect(text).toContain('Total Tool Calls');
      expect(text).toContain('Database Size');
    });

    it('returns multi-session summary table when no session_id', () => {
      createSession(db, 'session-002');
      addConversationTurn(db, 'session-001', 1, 'Q1', 'A1', null, 1, 10, 20);
      addConversationTurn(db, 'session-002', 1, 'Q1', 'A1', null, 2, 10, 20);

      const result = handleObservabilityToolCall('massu_session_stats', {}, db);
      const text = getText(result);

      expect(text).toContain('Session Statistics');
      // Multi-session table headers
      expect(text).toContain('Status');
      expect(text).toContain('Turns');
      expect(text).toContain('Tool Calls');
      expect(text).toContain('Prompt Tokens');
      expect(text).toContain('Response Tokens');
      // Database size section
      expect(text).toContain('Database Size');
      expect(text).toContain('Conversation turns');
      expect(text).toContain('Tool call details');
    });

    it('returns no-data message when no sessions exist for multi-session view', () => {
      // Remove the session created in beforeEach to get an empty state
      db.prepare('DELETE FROM sessions').run();

      const result = handleObservabilityToolCall('massu_session_stats', {}, db);
      const text = getText(result);

      expect(text).toContain('No session stats available');
    });

    it('returns zero counts for non-existent session_id', () => {
      const result = handleObservabilityToolCall('massu_session_stats', { session_id: 'non-existent' }, db);
      const text = getText(result);

      // getSessionStats always returns a record for single session query, even if session does not exist
      expect(text).toContain('Session Statistics');
      expect(text).toContain('Status');
      expect(text).toContain('Turns');
    });

    it('includes tool breakdown for single session', () => {
      addConversationTurn(db, 'session-001', 1, 'Q1', 'A1', null, 3, 50, 200);
      addToolCallDetail(db, 'session-001', 1, 'Read', 'file1', 50, 1000, true);
      addToolCallDetail(db, 'session-001', 1, 'Edit', 'file2', 200, 50, true);
      addToolCallDetail(db, 'session-001', 1, 'Read', 'file3', 60, 800, true);

      const result = handleObservabilityToolCall('massu_session_stats', { session_id: 'session-001' }, db);
      const text = getText(result);

      expect(text).toContain('Tool Breakdown');
      expect(text).toContain('Read');
      expect(text).toContain('Edit');
    });

    it('includes database size monitoring info', () => {
      addConversationTurn(db, 'session-001', 1, 'Q', 'A', null, 0, 10, 20);
      addToolCallDetail(db, 'session-001', 1, 'Read', 'file', 50, 1000, true);

      const result = handleObservabilityToolCall('massu_session_stats', {}, db);
      const text = getText(result);

      expect(text).toContain('Database Size');
      expect(text).toContain('Conversation turns: 1');
      expect(text).toContain('Tool call details: 1');
      expect(text).toContain('Observations: 0');
      expect(text).toContain('MB');
    });
  });

  // ============================================================
  // 7. handleObservabilityToolCall - unknown tool & error handling
  // ============================================================
  describe('handleObservabilityToolCall - edge cases', () => {
    it('returns error for unknown tool name', () => {
      const result = handleObservabilityToolCall('massu_unknown_obs_tool', {}, db);
      const text = getText(result);

      expect(text).toContain('Unknown observability tool');
      expect(text).toContain('massu_unknown_obs_tool');
    });

    it('catches and reports thrown errors', () => {
      // Close the database to force an error when a handler tries to query
      const closedDb = new Database(':memory:');
      closedDb.close();

      const result = handleObservabilityToolCall('massu_session_replay', { session_id: 'test' }, closedDb);
      const text = getText(result);

      expect(text).toContain('Error in massu_session_replay');
    });

    it('handles session_replay with empty session_id string', () => {
      const result = handleObservabilityToolCall('massu_session_replay', { session_id: '' }, db);
      const text = getText(result);

      expect(text).toContain('Error: session_id is required');
    });

    it('works with base name (no prefix) for handler routing', () => {
      addConversationTurn(db, 'session-001', 1, 'Hello', 'Hi there', null, 0, 10, 20);

      // Pass just the base name without prefix -- the handler strips prefix if present
      const result = handleObservabilityToolCall('session_replay', { session_id: 'session-001' }, db);
      const text = getText(result);

      expect(text).toContain('Session Replay');
      expect(text).toContain('Hello');
    });
  });
});

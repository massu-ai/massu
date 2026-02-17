// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { handleMemoryToolCall, getMemoryToolDefinitions } from '../memory-tools.ts';
import { createSession, addObservation, addSummary, addUserPrompt, endSession } from '../memory-db.ts';

// P7-005: Memory Tools Tests

const TEST_DB_PATH = resolve(__dirname, '../test-memory-tools.db');

function createTestDb(): Database.Database {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL DEFAULT 'my-project',
      git_branch TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT, ended_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'abandoned')) NOT NULL DEFAULT 'active',
      plan_file TEXT, plan_phase TEXT, task_id TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'decision', 'bugfix', 'feature', 'refactor', 'discovery',
        'cr_violation', 'vr_check', 'pattern_compliance', 'failed_attempt',
        'file_change', 'incident_near_miss'
      )),
      title TEXT NOT NULL, detail TEXT,
      files_involved TEXT DEFAULT '[]', plan_item TEXT, cr_rule TEXT, vr_type TEXT, evidence TEXT,
      importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
      recurrence_count INTEGER NOT NULL DEFAULT 1,
      original_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_importance ON observations(importance DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, detail, evidence, content='observations', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, detail, evidence) VALUES (new.id, new.title, new.detail, new.evidence);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, detail, evidence) VALUES ('delete', old.id, old.title, old.detail, old.evidence);
    END;
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT, investigated TEXT, decisions TEXT, completed TEXT,
      failed_attempts TEXT, next_steps TEXT,
      files_created TEXT DEFAULT '[]', files_modified TEXT DEFAULT '[]',
      verification_results TEXT DEFAULT '{}', plan_progress TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL, prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  return db;
}

describe('Memory Tools', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Seed test data
    createSession(db, 'session-1', { branch: 'main' });
    addObservation(db, 'session-1', 'decision', 'Use FTS5 for search', 'Better performance than LIKE');
    addObservation(db, 'session-1', 'failed_attempt', 'Regex parser fails on nested braces', 'Stopped at first }');
    addObservation(db, 'session-1', 'feature', 'Implemented memory database', null, {
      filesInvolved: ['packages/core/src/memory-db.ts'],
      planItem: 'P1-001',
    });
    addObservation(db, 'session-1', 'vr_check', 'VR-BUILD: PASS', null, {
      vrType: 'VR-BUILD',
      evidence: 'Build completed successfully',
      importance: 2,
    });
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  describe('Tool Definitions', () => {
    it('returns 6 memory tool definitions', () => {
      const defs = getMemoryToolDefinitions();
      expect(defs.length).toBe(6);
      const names = defs.map(d => d.name);
      expect(names).toContain('massu_memory_search');
      expect(names).toContain('massu_memory_timeline');
      expect(names).toContain('massu_memory_detail');
      expect(names).toContain('massu_memory_sessions');
      expect(names).toContain('massu_memory_failures');
      expect(names).toContain('massu_memory_ingest');
    });
  });

  describe('massu_memory_search', () => {
    it('searches observations by text', () => {
      const result = handleMemoryToolCall('massu_memory_search', { query: 'FTS5' }, db);
      const text = result.content[0].text;
      expect(text).toContain('FTS5');
      expect(text).toContain('Search Results');
    });

    it('returns no results message', () => {
      const result = handleMemoryToolCall('massu_memory_search', { query: 'nonexistent12345' }, db);
      expect(result.content[0].text).toContain('No observations found');
    });
  });

  describe('massu_memory_timeline', () => {
    it('shows chronological context around observation', () => {
      const obs = db.prepare('SELECT id FROM observations LIMIT 1').get() as { id: number };
      const result = handleMemoryToolCall('massu_memory_timeline', { observation_id: obs.id }, db);
      expect(result.content[0].text).toContain('Timeline');
      expect(result.content[0].text).toContain('ANCHOR');
    });
  });

  describe('massu_memory_detail', () => {
    it('returns full observation details', () => {
      const obs = db.prepare('SELECT id FROM observations WHERE type = ?').all('decision') as { id: number }[];
      const ids = obs.map(o => o.id);
      const result = handleMemoryToolCall('massu_memory_detail', { ids }, db);
      expect(result.content[0].text).toContain('FTS5');
      expect(result.content[0].text).toContain('decision');
    });
  });

  describe('massu_memory_sessions', () => {
    it('lists recent sessions', () => {
      const result = handleMemoryToolCall('massu_memory_sessions', {}, db);
      // Session IDs are truncated to 8 chars in output: "session-..."
      expect(result.content[0].text).toContain('session-');
      expect(result.content[0].text).toContain('active');
    });
  });

  describe('massu_memory_failures', () => {
    it('lists failed attempts', () => {
      const result = handleMemoryToolCall('massu_memory_failures', {}, db);
      expect(result.content[0].text).toContain('Regex parser');
      expect(result.content[0].text).toContain('DO NOT RETRY');
    });

    it('filters by keyword', () => {
      const result = handleMemoryToolCall('massu_memory_failures', { query: 'regex' }, db);
      expect(result.content[0].text).toContain('Regex');
    });
  });

  describe('massu_memory_ingest', () => {
    it('records a manual observation', () => {
      const result = handleMemoryToolCall('massu_memory_ingest', {
        type: 'decision',
        title: 'Manual decision record',
        detail: 'Decided to use approach X',
      }, db);
      expect(result.content[0].text).toContain('recorded successfully');

      const obs = db.prepare("SELECT * FROM observations WHERE title = 'Manual decision record'").get() as Record<string, unknown>;
      expect(obs).toBeTruthy();
      expect(obs.type).toBe('decision');
    });

    it('rejects invalid type', () => {
      const result = handleMemoryToolCall('massu_memory_ingest', {
        type: 'invalid_type',
        title: 'test',
      }, db);
      expect(result.content[0].text).toContain('invalid type');
    });
  });
});

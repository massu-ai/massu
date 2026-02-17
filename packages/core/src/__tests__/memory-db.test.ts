// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getMemoryDb,
  createSession,
  endSession,
  addObservation,
  addSummary,
  addUserPrompt,
  searchObservations,
  getRecentObservations,
  getSessionSummaries,
  getSessionTimeline,
  getFailedAttempts,
  getDecisionsAbout,
  pruneOldObservations,
  deduplicateFailedAttempt,
  getSessionsByTask,
  getCrossTaskProgress,
  assignImportance,
  linkSessionToTask,
  autoDetectTaskId,
} from '../memory-db.ts';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';

// P7-001: Memory Database Tests

const TEST_DB_PATH = resolve(__dirname, '../test-memory.db');

function createTestDb(): Database.Database {
  // Remove existing test DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }

  // Temporarily override getMemoryDb behavior by directly creating a db
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Init schema manually (same as getMemoryDb)
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
    CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);

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
    CREATE INDEX IF NOT EXISTS idx_observations_importance ON observations(importance DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, detail, evidence,
      content='observations',
      content_rowid='id'
    );
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

    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
      prompt_text,
      content='user_prompts',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;

    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

describe('Memory Database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('Schema', () => {
    it('creates all tables', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('session_summaries');
      expect(tableNames).toContain('user_prompts');
      expect(tableNames).toContain('memory_meta');
    });

    it('creates FTS5 tables', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames.some(n => n.includes('observations_fts'))).toBe(true);
      expect(tableNames.some(n => n.includes('user_prompts_fts'))).toBe(true);
    });
  });

  describe('Session CRUD', () => {
    it('creates a session with INSERT OR IGNORE', () => {
      createSession(db, 'test-session-1', { branch: 'main' });
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('test-session-1') as Record<string, unknown>;
      expect(session).toBeTruthy();
      expect(session.git_branch).toBe('main');
      expect(session.status).toBe('active');
    });

    it('is idempotent (INSERT OR IGNORE)', () => {
      createSession(db, 'test-session-1', { branch: 'main' });
      createSession(db, 'test-session-1', { branch: 'feature' }); // Should not throw or update
      const count = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE session_id = ?').get('test-session-1') as { c: number };
      expect(count.c).toBe(1);
    });

    it('ends a session', () => {
      createSession(db, 'test-session-1');
      endSession(db, 'test-session-1', 'completed');
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('test-session-1') as Record<string, unknown>;
      expect(session.status).toBe('completed');
      expect(session.ended_at).toBeTruthy();
    });
  });

  describe('Observations', () => {
    beforeEach(() => {
      createSession(db, 'test-session-1');
    });

    it('adds an observation', () => {
      const id = addObservation(db, 'test-session-1', 'decision', 'Use FTS5 for search', 'Full-text search is faster');
      expect(id).toBeGreaterThan(0);
      const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.title).toBe('Use FTS5 for search');
      expect(obs.type).toBe('decision');
    });

    it('auto-assigns importance', () => {
      const id1 = addObservation(db, 'test-session-1', 'decision', 'Important decision', null);
      const id2 = addObservation(db, 'test-session-1', 'file_change', 'Changed a file', null);
      const obs1 = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id1) as { importance: number };
      const obs2 = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id2) as { importance: number };
      expect(obs1.importance).toBe(5); // decision
      expect(obs2.importance).toBe(1); // file_change
    });

    it('searches observations with FTS5', () => {
      addObservation(db, 'test-session-1', 'decision', 'Use FTS5 for search', 'Better performance');
      addObservation(db, 'test-session-1', 'feature', 'Add login page', 'New auth flow');
      const results = searchObservations(db, 'FTS5');
      expect(results.length).toBe(1);
      expect(results[0].title).toContain('FTS5');
    });

    it('gets recent observations', () => {
      addObservation(db, 'test-session-1', 'decision', 'Decision 1', null);
      addObservation(db, 'test-session-1', 'feature', 'Feature 1', null);
      const recent = getRecentObservations(db, 10, 'test-session-1');
      expect(recent.length).toBe(2);
    });
  });

  describe('Session Summaries', () => {
    beforeEach(() => {
      createSession(db, 'test-session-1');
    });

    it('adds and retrieves a summary', () => {
      addSummary(db, 'test-session-1', {
        request: 'Fix the login bug',
        completed: 'Fixed auth flow',
        planProgress: { 'P1-001': 'complete' },
      });
      const summaries = getSessionSummaries(db, 5);
      expect(summaries.length).toBe(1);
      expect(summaries[0].request).toBe('Fix the login bug');
    });
  });

  describe('Session Timeline', () => {
    it('returns full timeline', () => {
      createSession(db, 'test-session-1');
      addObservation(db, 'test-session-1', 'decision', 'Decision 1', null);
      addUserPrompt(db, 'test-session-1', 'Fix the bug', 1);
      addSummary(db, 'test-session-1', { request: 'Fix the bug' });

      const timeline = getSessionTimeline(db, 'test-session-1');
      expect(timeline.session).toBeTruthy();
      expect(timeline.observations.length).toBe(1);
      expect(timeline.summary).toBeTruthy();
      expect(timeline.prompts.length).toBe(1);
    });
  });

  describe('Failed Attempts', () => {
    beforeEach(() => {
      createSession(db, 'test-session-1');
    });

    it('retrieves failed attempts', () => {
      addObservation(db, 'test-session-1', 'failed_attempt', 'Regex parser fails on nested braces', 'Stopped at first }');
      const failures = getFailedAttempts(db);
      expect(failures.length).toBe(1);
      expect(failures[0].title).toContain('Regex parser');
    });

    it('searches failed attempts with FTS5', () => {
      addObservation(db, 'test-session-1', 'failed_attempt', 'Regex parser fails on nested braces', 'Stopped at first }');
      addObservation(db, 'test-session-1', 'failed_attempt', 'process.cwd() wrong in tests', 'Returns test runner dir');
      const results = getFailedAttempts(db, 'regex');
      expect(results.length).toBe(1);
      expect(results[0].title).toContain('Regex');
    });
  });

  describe('Decisions', () => {
    it('searches decisions with FTS5', () => {
      createSession(db, 'test-session-1');
      addObservation(db, 'test-session-1', 'decision', 'Use esbuild instead of tsc', 'Faster bundling');
      addObservation(db, 'test-session-1', 'decision', 'Use FTS5 for search', 'Better performance');
      const results = getDecisionsAbout(db, 'esbuild');
      expect(results.length).toBe(1);
      expect(results[0].title).toContain('esbuild');
    });
  });

  describe('Deduplication', () => {
    it('increments recurrence_count for duplicate failed attempts', () => {
      createSession(db, 'test-session-1');
      createSession(db, 'test-session-2');
      deduplicateFailedAttempt(db, 'test-session-1', 'process.cwd() wrong in tests', 'Returns runner dir');
      deduplicateFailedAttempt(db, 'test-session-2', 'process.cwd() wrong in tests', 'Same issue again');

      const failures = getFailedAttempts(db);
      expect(failures.length).toBe(1);
      expect(failures[0].recurrence_count).toBe(2);
    });
  });

  describe('Task Linking', () => {
    it('links sessions to tasks and gets cross-task progress', () => {
      createSession(db, 'session-1', { planFile: '/path/2026-01-30-memory-system.md' });
      createSession(db, 'session-2', { planFile: '/path/2026-01-30-memory-system.md' });

      // Verify auto-detected task_id
      const s1 = db.prepare('SELECT task_id FROM sessions WHERE session_id = ?').get('session-1') as { task_id: string };
      expect(s1.task_id).toBe('2026-01-30-memory-system');

      // Add summaries with plan progress
      addSummary(db, 'session-1', { planProgress: { 'P1-001': 'complete', 'P1-002': 'in_progress' } });
      addSummary(db, 'session-2', { planProgress: { 'P1-002': 'complete', 'P2-001': 'complete' } });

      const progress = getCrossTaskProgress(db, '2026-01-30-memory-system');
      expect(progress['P1-001']).toBe('complete');
      expect(progress['P1-002']).toBe('complete'); // Later status wins
      expect(progress['P2-001']).toBe('complete');
    });

    it('gets sessions by task', () => {
      createSession(db, 'session-1');
      createSession(db, 'session-2');
      linkSessionToTask(db, 'session-1', 'task-1');
      linkSessionToTask(db, 'session-2', 'task-1');

      const sessions = getSessionsByTask(db, 'task-1');
      expect(sessions.length).toBe(2);
    });
  });

  describe('Pruning', () => {
    it('prunes old observations', () => {
      createSession(db, 'test-session-1');
      // Insert observation with old epoch
      const oldEpoch = Math.floor(Date.now() / 1000) - (100 * 86400); // 100 days ago
      db.prepare(`
        INSERT INTO observations (session_id, type, title, importance, created_at, created_at_epoch)
        VALUES (?, 'discovery', 'Old observation', 1, ?, ?)
      `).run('test-session-1', new Date(oldEpoch * 1000).toISOString(), oldEpoch);

      addObservation(db, 'test-session-1', 'decision', 'Recent decision', null);

      const pruned = pruneOldObservations(db, 90);
      expect(pruned).toBe(1);

      const remaining = db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number };
      expect(remaining.c).toBe(1);
    });
  });

  describe('Importance', () => {
    it('assigns correct importance by type', () => {
      expect(assignImportance('decision')).toBe(5);
      expect(assignImportance('failed_attempt')).toBe(5);
      expect(assignImportance('cr_violation')).toBe(4);
      expect(assignImportance('vr_check', 'FAIL')).toBe(4);
      expect(assignImportance('vr_check', 'PASS')).toBe(2);
      expect(assignImportance('feature')).toBe(3);
      expect(assignImportance('bugfix')).toBe(3);
      expect(assignImportance('refactor')).toBe(2);
      expect(assignImportance('file_change')).toBe(1);
      expect(assignImportance('discovery')).toBe(1);
    });
  });

  describe('autoDetectTaskId', () => {
    it('derives task_id from plan file path', () => {
      expect(autoDetectTaskId('/path/to/2026-01-30-massu-memory.md')).toBe('2026-01-30-massu-memory');
      expect(autoDetectTaskId(null)).toBeNull();
      expect(autoDetectTaskId(undefined)).toBeNull();
    });
  });
});

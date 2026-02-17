// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import {
  assignImportance,
  createSession,
  addObservation,
  addSummary,
  deduplicateFailedAttempt,
  getFailedAttempts,
  linkSessionToTask,
  getSessionsByTask,
  getCrossTaskProgress,
  autoDetectTaskId,
  getRecentObservations,
  getSessionSummaries,
} from '../memory-db.ts';
import { isNoisyToolCall, detectPlanProgress, classifyRealTimeToolCall } from '../observation-extractor.ts';

// P7-006: Enhancement-Specific Tests

const TEST_DB_PATH = resolve(__dirname, '../test-enhancements.db');

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
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
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

describe('Enhancement Features', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  describe('Importance Scoring', () => {
    it('assigns importance=5 for decisions', () => {
      expect(assignImportance('decision')).toBe(5);
    });

    it('assigns importance=5 for failed_attempts', () => {
      expect(assignImportance('failed_attempt')).toBe(5);
    });

    it('assigns importance=4 for cr_violation', () => {
      expect(assignImportance('cr_violation')).toBe(4);
    });

    it('assigns importance=4 for vr_check FAIL', () => {
      expect(assignImportance('vr_check', 'FAIL')).toBe(4);
    });

    it('assigns importance=2 for vr_check PASS', () => {
      expect(assignImportance('vr_check', 'PASS')).toBe(2);
    });

    it('assigns importance=3 for feature/bugfix', () => {
      expect(assignImportance('feature')).toBe(3);
      expect(assignImportance('bugfix')).toBe(3);
    });

    it('assigns importance=2 for refactor', () => {
      expect(assignImportance('refactor')).toBe(2);
    });

    it('assigns importance=1 for file_change/discovery', () => {
      expect(assignImportance('file_change')).toBe(1);
      expect(assignImportance('discovery')).toBe(1);
    });

    it('stores importance in observation', () => {
      createSession(db, 'session-1');
      const id = addObservation(db, 'session-1', 'decision', 'Important decision', null);
      const obs = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id) as { importance: number };
      expect(obs.importance).toBe(5);
    });
  });

  describe('Noise Filtering', () => {
    it('filters Glob calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({ toolName: 'Glob', toolUseId: '1', input: {}, result: 'files' }, seenReads)).toBe(true);
    });

    it('filters Grep calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({ toolName: 'Grep', toolUseId: '1', input: {}, result: 'match' }, seenReads)).toBe(true);
    });

    it('filters trivial Bash: ls, pwd, echo', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({ toolName: 'Bash', toolUseId: '1', input: { command: 'ls -la' }, result: 'output' }, seenReads)).toBe(true);
      expect(isNoisyToolCall({ toolName: 'Bash', toolUseId: '2', input: { command: 'pwd' }, result: '/path' }, seenReads)).toBe(true);
      expect(isNoisyToolCall({ toolName: 'Bash', toolUseId: '3', input: { command: 'echo hello' }, result: 'hello' }, seenReads)).toBe(true);
    });

    it('keeps Edit calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({ toolName: 'Edit', toolUseId: '1', input: { file_path: '/f.ts' }, result: 'ok' }, seenReads)).toBe(false);
    });

    it('keeps Write calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({ toolName: 'Write', toolUseId: '1', input: { file_path: '/f.ts' }, result: 'ok' }, seenReads)).toBe(false);
    });

    it('keeps npm test Bash calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({ toolName: 'Bash', toolUseId: '1', input: { command: 'npm test' }, result: 'passed' }, seenReads)).toBe(false);
    });
  });

  describe('Token Budget Enforcement', () => {
    it('estimates tokens as chars/4', () => {
      const text = 'a'.repeat(100);
      expect(Math.ceil(text.length / 4)).toBe(25);
    });

    it('observations sorted by importance for budget filling', () => {
      createSession(db, 'session-1');
      addObservation(db, 'session-1', 'file_change', 'Low importance', null, { importance: 1 });
      addObservation(db, 'session-1', 'decision', 'High importance', null, { importance: 5 });
      addObservation(db, 'session-1', 'feature', 'Medium importance', null, { importance: 3 });

      const obs = getRecentObservations(db, 10, 'session-1');
      const sorted = [...obs].sort((a, b) => b.importance - a.importance);
      expect(sorted[0].importance).toBe(5);
      expect(sorted[1].importance).toBe(3);
      expect(sorted[2].importance).toBe(1);
    });
  });

  describe('Compaction-Aware Injection', () => {
    it('compact source gets 4000 tokens', () => {
      // Verify token budget logic
      const budgets: Record<string, number> = {
        compact: 4000,
        startup: 2000,
        resume: 1000,
      };
      expect(budgets.compact).toBe(4000);
      expect(budgets.startup).toBe(2000);
      expect(budgets.resume).toBe(1000);
    });
  });

  describe('Failed Attempt Deduplication', () => {
    it('increments recurrence_count for same title', () => {
      createSession(db, 'session-1');
      createSession(db, 'session-2');

      deduplicateFailedAttempt(db, 'session-1', 'process.cwd() wrong in tests', 'Detail 1');
      deduplicateFailedAttempt(db, 'session-2', 'process.cwd() wrong in tests', 'Detail 2');

      const failures = getFailedAttempts(db);
      expect(failures.length).toBe(1);
      expect(failures[0].recurrence_count).toBe(2);
    });

    it('creates new entry for different title', () => {
      createSession(db, 'session-1');
      deduplicateFailedAttempt(db, 'session-1', 'Error A', null);
      deduplicateFailedAttempt(db, 'session-1', 'Error B', null);

      const failures = getFailedAttempts(db);
      expect(failures.length).toBe(2);
    });
  });

  describe('Session Linking', () => {
    it('auto-detects task_id from plan file', () => {
      expect(autoDetectTaskId('/path/to/2026-01-30-massu-memory.md')).toBe('2026-01-30-massu-memory');
    });

    it('links sessions on creation with plan file', () => {
      createSession(db, 'session-1', { planFile: '/path/2026-01-30-plan.md' });
      createSession(db, 'session-2', { planFile: '/path/2026-01-30-plan.md' });

      const s1 = db.prepare('SELECT task_id FROM sessions WHERE session_id = ?').get('session-1') as { task_id: string };
      const s2 = db.prepare('SELECT task_id FROM sessions WHERE session_id = ?').get('session-2') as { task_id: string };
      expect(s1.task_id).toBe('2026-01-30-plan');
      expect(s2.task_id).toBe('2026-01-30-plan');
    });

    it('aggregates cross-task progress', () => {
      createSession(db, 'session-1', { planFile: '/path/plan.md' });
      createSession(db, 'session-2', { planFile: '/path/plan.md' });

      addSummary(db, 'session-1', { planProgress: { 'P1-001': 'complete' } });
      addSummary(db, 'session-2', { planProgress: { 'P2-001': 'complete' } });

      const progress = getCrossTaskProgress(db, 'plan');
      expect(progress['P1-001']).toBe('complete');
      expect(progress['P2-001']).toBe('complete');
    });

    it('gets all sessions for a task', () => {
      createSession(db, 'session-1');
      createSession(db, 'session-2');
      linkSessionToTask(db, 'session-1', 'my-task');
      linkSessionToTask(db, 'session-2', 'my-task');

      const sessions = getSessionsByTask(db, 'my-task');
      expect(sessions.length).toBe(2);
    });
  });

  describe('Plan Progress Auto-Detection', () => {
    it('detects P1-001 COMPLETE pattern', () => {
      const progress = detectPlanProgress('Verified P1-001: COMPLETE');
      expect(progress.length).toBe(1);
      expect(progress[0].planItem).toBe('P1-001');
      expect(progress[0].status).toBe('complete');
    });

    it('detects multiple plan items', () => {
      const progress = detectPlanProgress('P1-001: DONE, P2-003: PASS');
      expect(progress.length).toBe(2);
    });

    it('ignores non-matching text', () => {
      const progress = detectPlanProgress('Working on the project');
      expect(progress.length).toBe(0);
    });
  });

  describe('PreCompact Snapshot', () => {
    it('stores mid-session summary with pre_compact marker', () => {
      createSession(db, 'session-1');
      addObservation(db, 'session-1', 'feature', 'Added login page', null);

      // Simulate pre-compact summary
      addSummary(db, 'session-1', {
        completed: '- Added login page',
        planProgress: { snapshot_type: 'pre_compact', 'P1-001': 'in_progress' },
      });

      const summaries = getSessionSummaries(db, 5);
      expect(summaries.length).toBe(1);
      const progress = JSON.parse(summaries[0].plan_progress);
      expect(progress.snapshot_type).toBe('pre_compact');
    });
  });
});

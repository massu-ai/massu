// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { unlinkSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import {
  createSession,
  addObservation,
  addSummary,
  addUserPrompt,
  getMemoryDb,
  getFailedAttempts,
  getRecentObservations,
  getSessionSummaries,
} from '../memory-db.ts';
import { generateCurrentMd } from '../session-state-generator.ts';
import { archiveAndRegenerate } from '../session-archiver.ts';

// P7-004: Hook Handler Tests
// Tests the core logic that hooks use (not the stdin/stdout plumbing)

const TEST_DB_PATH = resolve(__dirname, '../test-hooks.db');

function createTestDb(): Database.Database {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Minimal schema for hook tests
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
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, detail, evidence, content='observations', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, detail, evidence) VALUES (new.id, new.title, new.detail, new.evidence);
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
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
      prompt_text, content='user_prompts', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  return db;
}

describe('Hook Logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  describe('Session Creation (P3-001, P3-004)', () => {
    it('creates session on first hook call', () => {
      createSession(db, 'hook-session-1', { branch: 'feature-x' });
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('hook-session-1') as Record<string, unknown>;
      expect(session).toBeTruthy();
      expect(session.git_branch).toBe('feature-x');
    });

    it('is idempotent across hooks', () => {
      createSession(db, 'hook-session-1');
      createSession(db, 'hook-session-1');
      createSession(db, 'hook-session-1');
      const count = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE session_id = ?').get('hook-session-1') as { c: number };
      expect(count.c).toBe(1);
    });
  });

  describe('Observation Capture (P3-002)', () => {
    it('stores file_change observations', () => {
      createSession(db, 'hook-session-1');
      addObservation(db, 'hook-session-1', 'file_change', 'Edited: src/lib/auth.ts', null, {
        filesInvolved: ['src/lib/auth.ts'],
      });
      const obs = getRecentObservations(db, 10, 'hook-session-1');
      expect(obs.length).toBe(1);
      expect(obs[0].type).toBe('file_change');
    });

    it('stores vr_check observations', () => {
      createSession(db, 'hook-session-1');
      addObservation(db, 'hook-session-1', 'vr_check', 'VR-BUILD: PASS', null, {
        vrType: 'VR-BUILD',
        evidence: 'Build succeeded',
        importance: 2,
      });
      const obs = getRecentObservations(db, 10, 'hook-session-1');
      expect(obs[0].type).toBe('vr_check');
      expect(obs[0].importance).toBe(2);
    });
  });

  describe('Summary Generation (P3-003)', () => {
    it('generates summary from observations', () => {
      createSession(db, 'hook-session-1');
      addObservation(db, 'hook-session-1', 'decision', 'Use esbuild for hooks', 'Faster than tsc');
      addObservation(db, 'hook-session-1', 'feature', 'Implemented memory DB', null);
      addObservation(db, 'hook-session-1', 'failed_attempt', 'process.cwd() wrong', 'Returns test dir');

      addSummary(db, 'hook-session-1', {
        request: 'Implement memory system',
        decisions: '- Use esbuild for hooks',
        completed: '- Implemented memory DB',
        failedAttempts: '- process.cwd() wrong',
      });

      const summaries = getSessionSummaries(db, 5);
      expect(summaries.length).toBe(1);
      expect(summaries[0].request).toBe('Implement memory system');
    });
  });

  describe('Context Injection Format (P3-001)', () => {
    it('includes failed attempts in context', () => {
      createSession(db, 'hook-session-1');
      addObservation(db, 'hook-session-1', 'failed_attempt', 'Regex parser fails on nested braces', null, {
        importance: 5,
      });

      const failures = getFailedAttempts(db);
      expect(failures.length).toBe(1);
      expect(failures[0].title).toContain('Regex parser');
    });
  });

  describe('CURRENT.md Generation (P3-003 + P5-001)', () => {
    it('generates valid markdown', () => {
      createSession(db, 'hook-session-1', { branch: 'main' });
      addUserPrompt(db, 'hook-session-1', 'Fix the auth bug', 1);
      addObservation(db, 'hook-session-1', 'decision', 'Use JWT tokens', 'More secure');
      addObservation(db, 'hook-session-1', 'file_change', 'Edited: src/auth.ts', null, {
        filesInvolved: ['src/auth.ts'],
      });

      const md = generateCurrentMd(db, 'hook-session-1');
      expect(md).toContain('# Session State');
      expect(md).toContain('auto-generated from massu-memory');
      expect(md).toContain('hook-session-1');
      expect(md).toContain('Use JWT tokens');
    });
  });

  describe('User Prompt Capture (P3-004)', () => {
    it('stores prompts with incrementing numbers', () => {
      createSession(db, 'hook-session-1');
      addUserPrompt(db, 'hook-session-1', 'First prompt', 1);
      addUserPrompt(db, 'hook-session-1', 'Second prompt', 2);

      const prompts = db.prepare('SELECT * FROM user_prompts WHERE session_id = ? ORDER BY prompt_number').all('hook-session-1') as Array<Record<string, unknown>>;
      expect(prompts.length).toBe(2);
      expect(prompts[0].prompt_number).toBe(1);
      expect(prompts[1].prompt_number).toBe(2);
    });
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getMemoryDb,
  initMemorySchema,
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
  armUsageCounter,
  recordRecallHits,
  setMemoryMeta,
  USAGE_COUNTER_ARMED_KEY,
  CONSOLIDATION_LESSON_EVIDENCE,
  deduplicateFailedAttempt,
  getSessionsByTask,
  getCrossTaskProgress,
  assignImportance,
  linkSessionToTask,
  autoDetectTaskId,
} from '../memory-db.ts';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, mkdtempSync } from 'fs';

// P7-001: Memory Database Tests

// Scratch DBs MUST live in the OS temp dir, never under packages/core/src.
// SQLite creates transient sidecars (-journal / -wal) next to the DB file, and
// the source-scanning drift-guards walk src/ — under parallel test load the
// walker stats a journal file that vanishes mid-walk and the whole suite dies
// with ENOENT. (This flaked the pre-push gate; same class as the earlier
// src-scratch race.)
const TEST_DB_PATH = join(mkdtempSync(join(tmpdir(), 'massu-memdb-')), 'test-memory.db');

function createTestDb(): Database.Database {
  // Remove existing test DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }

  // Use the REAL schema initializer (initMemorySchema) rather than a
  // hand-copied CREATE TABLE block. The copy had already drifted — it was
  // missing the Slice-2 bi-temporal columns — which is exactly the
  // dual-source-of-truth bug class this repo forbids. One schema, one owner.
  const db = new Database(TEST_DB_PATH);
  initMemorySchema(db);

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

  describe('Retention (expire, never delete — plan-living-memory-slice-3)', () => {
    const EXPIRE_OPTS = {
      retentionDays: 90,
      importanceFloor: 2,
      protectedTypes: ['decision', 'cr_violation', 'incident_near_miss'],
      usageWarmupDays: 30,
    };

    it('retires an old, low-value, never-retrieved observation by EXPIRING it — the row is not deleted', () => {
      createSession(db, 'test-session-1');
      const now = Math.floor(Date.now() / 1000);
      const oldEpoch = now - 100 * 86400; // 100 days ago
      db.prepare(`
        INSERT INTO observations (session_id, type, title, importance, created_at, created_at_epoch)
        VALUES (?, 'discovery', 'Old observation', 1, ?, ?)
      `).run('test-session-1', new Date(oldEpoch * 1000).toISOString(), oldEpoch);

      addObservation(db, 'test-session-1', 'decision', 'Recent decision', null);

      // Arm the usage counter 31 days ago so the cold-start warmup has elapsed.
      setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * 86400));

      const expired = pruneOldObservations(db, EXPIRE_OPTS);
      expect(expired).toBe(1);

      // The crucial difference from the old blanket DELETE: BOTH rows still
      // exist. History stays answerable; the retired one is merely expired.
      const total = db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number };
      expect(total.c).toBe(2);

      const live = db
        .prepare('SELECT COUNT(*) as c FROM observations WHERE expired_at IS NULL')
        .get() as { c: number };
      expect(live.c).toBe(1);
    });

    it('COLD START: expires NOTHING until the retrieval counter has warmed up', () => {
      // The counter is brand new, so no row has "ever been retrieved" — a naive
      // implementation would expire the operator's entire history on day one.
      createSession(db, 'cold-start');
      const now = Math.floor(Date.now() / 1000);
      const oldEpoch = now - 200 * 86400;
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO observations (session_id, type, title, importance, created_at, created_at_epoch)
          VALUES (?, 'file_change', ?, 1, ?, ?)
        `).run('cold-start', `Ancient note ${i}`, new Date(oldEpoch * 1000).toISOString(), oldEpoch);
      }

      armUsageCounter(db, now); // armed just now => warmup has NOT elapsed

      expect(pruneOldObservations(db, EXPIRE_OPTS)).toBe(0);
      const live = db
        .prepare('SELECT COUNT(*) as c FROM observations WHERE expired_at IS NULL')
        .get() as { c: number };
      expect(live.c).toBe(10);
    });

    it('never expires a protected type, a retrieved row, or a consolidation lesson', () => {
      createSession(db, 'keepers');
      const now = Math.floor(Date.now() / 1000);
      const oldEpoch = now - 200 * 86400;
      setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * 86400));

      const mk = (type: string, title: string, evidence?: string): number => {
        const r = db.prepare(`
          INSERT INTO observations (session_id, type, title, importance, evidence, created_at, created_at_epoch)
          VALUES (?, ?, ?, 1, ?, ?, ?)
        `).run('keepers', type, title, evidence ?? null, new Date(oldEpoch * 1000).toISOString(), oldEpoch);
        return Number(r.lastInsertRowid);
      };

      mk('decision', 'A protected decision');                                  // protected type
      const retrieved = mk('file_change', 'Old but actually useful');          // has been retrieved
      mk('discovery', 'Distilled lesson', CONSOLIDATION_LESSON_EVIDENCE);      // a consolidation lesson
      mk('file_change', 'Genuinely dead weight');                              // the only expirable row

      recordRecallHits(db, 'some-session', [{ source: 'observation', id: retrieved }], now);

      expect(pruneOldObservations(db, EXPIRE_OPTS)).toBe(1);

      const live = db
        .prepare('SELECT title FROM observations WHERE expired_at IS NULL ORDER BY id')
        .all() as Array<{ title: string }>;
      expect(live.map((r) => r.title)).toEqual([
        'A protected decision',
        'Old but actually useful',
        'Distilled lesson',
      ]);
    });
  });

  describe('Retrieval-usage counter', () => {
    it('counts a record at most ONCE per session (verbosity is not usefulness)', () => {
      createSession(db, 'chatty');
      const id = addObservation(db, 'chatty', 'discovery', 'Surfaced a lot', null);

      // The same record surfaced on three different turns of ONE session.
      recordRecallHits(db, 'chatty', [{ source: 'observation', id }]);
      recordRecallHits(db, 'chatty', [{ source: 'observation', id }]);
      recordRecallHits(db, 'chatty', [{ source: 'observation', id }]);

      const row = db
        .prepare(`SELECT hit_count FROM memory_usage WHERE source='observation' AND record_id=?`)
        .get(id) as { hit_count: number };
      expect(row.hit_count).toBe(1);

      // A DIFFERENT session genuinely finding it useful does count.
      createSession(db, 'later');
      recordRecallHits(db, 'later', [{ source: 'observation', id }]);
      const row2 = db
        .prepare(`SELECT hit_count FROM memory_usage WHERE source='observation' AND record_id=?`)
        .get(id) as { hit_count: number };
      expect(row2.hit_count).toBe(2);
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

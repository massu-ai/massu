// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getAnalyticsToolDefinitions,
  isAnalyticsTool,
  calculateQualityScore,
  storeQualityScore,
  backfillQualityScores,
  handleAnalyticsToolCall,
  type QualityBreakdown,
} from '../analytics.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create minimal required schema for analytics
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE session_quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL,
      security_score INTEGER NOT NULL DEFAULT 0,
      architecture_score INTEGER NOT NULL DEFAULT 0,
      coupling_score INTEGER NOT NULL DEFAULT 0,
      test_score INTEGER NOT NULL DEFAULT 0,
      rule_compliance_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

describe('analytics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getAnalyticsToolDefinitions', () => {
    it('should return tool definitions for analytics tools', () => {
      const defs = getAnalyticsToolDefinitions();
      expect(defs.length).toBe(3);

      const names = defs.map(d => d.name);
      expect(names.some(n => n.includes('quality_score'))).toBe(true);
      expect(names.some(n => n.includes('quality_trend'))).toBe(true);
      expect(names.some(n => n.includes('quality_report'))).toBe(true);

      // Check structure
      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeTruthy();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('isAnalyticsTool', () => {
    it('should return true for analytics tools', () => {
      expect(isAnalyticsTool('massu_quality_score')).toBe(true);
      expect(isAnalyticsTool('massu_quality_trend')).toBe(true);
      expect(isAnalyticsTool('massu_quality_report')).toBe(true);
    });

    it('should return false for non-analytics tools', () => {
      expect(isAnalyticsTool('massu_cost_session')).toBe(false);
      expect(isAnalyticsTool('massu_audit_log')).toBe(false);
      expect(isAnalyticsTool('random_tool')).toBe(false);
    });

    it('should handle base names without prefix', () => {
      expect(isAnalyticsTool('quality_score')).toBe(true);
      expect(isAnalyticsTool('quality_trend')).toBe(true);
    });
  });

  describe('calculateQualityScore', () => {
    it('should calculate quality score from observations', () => {
      const sessionId = 'test-session-1';

      // Insert session
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      // Insert observations
      db.prepare('INSERT INTO observations (session_id, type, description, created_at) VALUES (?, ?, ?, ?)').run(
        sessionId, 'vr_pass', 'Security check passed', new Date().toISOString()
      );
      db.prepare('INSERT INTO observations (session_id, type, description, created_at) VALUES (?, ?, ?, ?)').run(
        sessionId, 'clean_commit', 'Clean commit with security improvements', new Date().toISOString()
      );
      db.prepare('INSERT INTO observations (session_id, type, description, created_at) VALUES (?, ?, ?, ?)').run(
        sessionId, 'bug_found', 'Bug found in architecture', new Date().toISOString()
      );

      const result = calculateQualityScore(db, sessionId);

      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.breakdown).toBeDefined();
      expect(result.breakdown.security).toBeDefined();
      expect(result.breakdown.architecture).toBeDefined();
    });

    it('should start with base score of 50', () => {
      const sessionId = 'test-session-2';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const result = calculateQualityScore(db, sessionId);
      expect(result.score).toBe(50); // No observations = base score
    });

    it('should clamp score between 0 and 100', () => {
      const sessionId = 'test-session-3';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      // Add many negative observations
      for (let i = 0; i < 10; i++) {
        db.prepare('INSERT INTO observations (session_id, type, description, created_at) VALUES (?, ?, ?, ?)').run(
          sessionId, 'incident', 'Critical incident', new Date().toISOString()
        );
      }

      const result = calculateQualityScore(db, sessionId);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  describe('storeQualityScore', () => {
    it('should store quality score in database', () => {
      const sessionId = 'test-session-4';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const breakdown: QualityBreakdown = {
        security: 5,
        architecture: -3,
        coupling: 0,
        tests: 2,
        rule_compliance: 1,
      };

      storeQualityScore(db, sessionId, 75, breakdown);

      const stored = db.prepare('SELECT * FROM session_quality_scores WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
      expect(stored).toBeDefined();
      expect(stored.session_id).toBe(sessionId);
      expect(stored.score).toBe(75);
      expect(stored.security_score).toBe(5);
      expect(stored.architecture_score).toBe(-3);
      expect(stored.coupling_score).toBe(0);
      expect(stored.test_score).toBe(2);
      expect(stored.rule_compliance_score).toBe(1);
    });
  });

  describe('backfillQualityScores', () => {
    it('should backfill scores for sessions without them', () => {
      // Create sessions
      const sessions = ['session-1', 'session-2', 'session-3'];
      for (const sid of sessions) {
        db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
          sid,
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
        db.prepare('INSERT INTO observations (session_id, type, description, created_at) VALUES (?, ?, ?, ?)').run(
          sid, 'vr_pass', 'Test passed', new Date().toISOString()
        );
      }

      const backfilled = backfillQualityScores(db);
      expect(backfilled).toBe(3);

      // Verify all sessions now have scores
      const scores = db.prepare('SELECT COUNT(*) as count FROM session_quality_scores').get() as { count: number };
      expect(scores.count).toBe(3);
    });

    it('should not backfill sessions that already have scores', () => {
      const sessionId = 'session-with-score';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      // Already has a score
      const breakdown: QualityBreakdown = {
        security: 0,
        architecture: 0,
        coupling: 0,
        tests: 0,
        rule_compliance: 0,
      };
      storeQualityScore(db, sessionId, 50, breakdown);

      const backfilled = backfillQualityScores(db);
      expect(backfilled).toBe(0);
    });
  });

  describe('handleAnalyticsToolCall', () => {
    it('should handle quality_score tool call', () => {
      const sessionId = 'test-session-5';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );
      db.prepare('INSERT INTO observations (session_id, type, description, created_at) VALUES (?, ?, ?, ?)').run(
        sessionId, 'vr_pass', 'Security tests passed', new Date().toISOString()
      );

      const result = handleAnalyticsToolCall('massu_quality_score', { session_id: sessionId }, db);

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Quality Score');
      expect(text).toContain('Breakdown');
    });

    it('should return error for missing session_id', () => {
      const result = handleAnalyticsToolCall('massu_quality_score', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Usage');
    });

    it('should handle unknown tool name', () => {
      const result = handleAnalyticsToolCall('massu_unknown_analytics_tool', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Unknown analytics tool');
    });
  });
});

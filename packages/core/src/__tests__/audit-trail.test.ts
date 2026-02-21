// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getAuditToolDefinitions,
  isAuditTool,
  logAuditEntry,
  queryAuditLog,
  getFileChain,
  backfillAuditLog,
  handleAuditToolCall,
  type AuditEntry,
} from '../audit-trail.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

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
      detail TEXT,
      files_involved TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE audit_log (
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
      metadata TEXT
    );

    CREATE INDEX idx_al_file ON audit_log(file_path);
    CREATE INDEX idx_al_timestamp ON audit_log(timestamp DESC);
  `);

  return db;
}

describe('audit-trail', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getAuditToolDefinitions', () => {
    it('should return tool definitions for audit tools', () => {
      const defs = getAuditToolDefinitions();
      expect(defs.length).toBe(3);

      const names = defs.map(d => d.name);
      expect(names.some(n => n.includes('audit_log'))).toBe(true);
      expect(names.some(n => n.includes('audit_report'))).toBe(true);
      expect(names.some(n => n.includes('audit_chain'))).toBe(true);

      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeTruthy();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('isAuditTool', () => {
    it('should return true for audit tools', () => {
      expect(isAuditTool('massu_audit_log')).toBe(true);
      expect(isAuditTool('massu_audit_report')).toBe(true);
      expect(isAuditTool('massu_audit_chain')).toBe(true);
    });

    it('should return false for non-audit tools', () => {
      expect(isAuditTool('massu_cost_session')).toBe(false);
      expect(isAuditTool('massu_quality_score')).toBe(false);
      expect(isAuditTool('random_tool')).toBe(false);
    });

    it('should handle base names without prefix', () => {
      expect(isAuditTool('audit_log')).toBe(true);
      expect(isAuditTool('audit_report')).toBe(true);
    });
  });

  describe('logAuditEntry', () => {
    it('should log an audit entry', () => {
      const sessionId = 'test-session-1';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const entry: AuditEntry = {
        eventType: 'code_change',
        actor: 'ai',
        filePath: 'src/auth.ts',
        changeType: 'edit',
        evidence: 'Fixed authentication bug',
        sessionId,
        modelId: 'claude-sonnet-4-5',
      };

      logAuditEntry(db, entry);

      const logs = db.prepare('SELECT * FROM audit_log WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(logs.length).toBe(1);
      expect(logs[0].event_type).toBe('code_change');
      expect(logs[0].actor).toBe('ai');
      expect(logs[0].file_path).toBe('src/auth.ts');
      expect(logs[0].change_type).toBe('edit');
      expect(logs[0].evidence).toBe('Fixed authentication bug');
    });

    it('should handle optional fields', () => {
      const sessionId = 'test-session-2';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const entry: AuditEntry = {
        eventType: 'review',
        actor: 'human',
        sessionId,
      };

      logAuditEntry(db, entry);

      const logs = db.prepare('SELECT * FROM audit_log WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(logs.length).toBe(1);
      expect(logs[0].event_type).toBe('review');
      expect(logs[0].file_path).toBeNull();
      expect(logs[0].change_type).toBeNull();
    });

    it('should store metadata as JSON', () => {
      const sessionId = 'test-session-3';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const entry: AuditEntry = {
        eventType: 'commit',
        actor: 'hook',
        sessionId,
        metadata: { commitHash: 'abc123', branch: 'main' },
      };

      logAuditEntry(db, entry);

      const logs = db.prepare('SELECT * FROM audit_log WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(logs.length).toBe(1);
      const metadata = JSON.parse(logs[0].metadata as string);
      expect(metadata.commitHash).toBe('abc123');
      expect(metadata.branch).toBe('main');
    });
  });

  describe('queryAuditLog', () => {
    beforeEach(() => {
      const sessionId = 'query-test-session';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const entries: AuditEntry[] = [
        { eventType: 'code_change', actor: 'ai', filePath: 'src/auth.ts', changeType: 'edit', sessionId },
        { eventType: 'review', actor: 'human', filePath: 'src/auth.ts', sessionId },
        { eventType: 'code_change', actor: 'ai', filePath: 'src/user.ts', changeType: 'create', sessionId },
        { eventType: 'commit', actor: 'hook', sessionId },
      ];

      for (const entry of entries) {
        logAuditEntry(db, entry);
      }
    });

    it('should query all audit logs', () => {
      const logs = queryAuditLog(db, {});
      expect(logs.length).toBe(4);
    });

    it('should filter by event type', () => {
      const logs = queryAuditLog(db, { eventType: 'code_change' });
      expect(logs.length).toBe(2);
      for (const log of logs) {
        expect(log.event_type).toBe('code_change');
      }
    });

    it('should filter by actor', () => {
      const logs = queryAuditLog(db, { actor: 'ai' });
      expect(logs.length).toBe(2);
      for (const log of logs) {
        expect(log.actor).toBe('ai');
      }
    });

    it('should filter by file path', () => {
      const logs = queryAuditLog(db, { filePath: 'src/auth.ts' });
      expect(logs.length).toBe(2);
      for (const log of logs) {
        expect(log.file_path).toBe('src/auth.ts');
      }
    });

    it('should limit results', () => {
      const logs = queryAuditLog(db, { limit: 2 });
      expect(logs.length).toBe(2);
    });

    it('should filter by change type', () => {
      const logs = queryAuditLog(db, { changeType: 'edit' });
      expect(logs.length).toBe(1);
      expect(logs[0].change_type).toBe('edit');
    });
  });

  describe('getFileChain', () => {
    it('should return audit chain for a file', () => {
      const sessionId = 'chain-test-session';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const filePath = 'src/auth.ts';
      const entries: AuditEntry[] = [
        { eventType: 'code_change', actor: 'ai', filePath, changeType: 'create', sessionId },
        { eventType: 'review', actor: 'human', filePath, sessionId },
        { eventType: 'code_change', actor: 'ai', filePath, changeType: 'edit', sessionId },
      ];

      for (const entry of entries) {
        logAuditEntry(db, entry);
      }

      const chain = getFileChain(db, filePath);
      expect(chain.length).toBe(3);
      expect(chain[0].change_type).toBe('create');
      expect(chain[1].event_type).toBe('review');
      expect(chain[2].change_type).toBe('edit');
    });

    it('should return empty array for file with no history', () => {
      const chain = getFileChain(db, 'nonexistent.ts');
      expect(chain.length).toBe(0);
    });
  });

  describe('backfillAuditLog', () => {
    it('should backfill audit log from observations', () => {
      const sessionId = 'backfill-session';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      db.prepare('INSERT INTO observations (session_id, type, detail, files_involved, created_at) VALUES (?, ?, ?, ?, ?)').run(
        sessionId,
        'bugfix',
        'Fixed critical bug',
        JSON.stringify(['src/auth.ts']),
        new Date().toISOString()
      );

      db.prepare('INSERT INTO observations (session_id, type, detail, files_involved, created_at) VALUES (?, ?, ?, ?, ?)').run(
        sessionId,
        'cr_violation',
        'Rule violation detected',
        JSON.stringify(['src/user.ts']),
        new Date().toISOString()
      );

      const backfilled = backfillAuditLog(db);
      expect(backfilled).toBe(2);

      const logs = queryAuditLog(db, { sessionId });
      expect(logs.length).toBe(2);
    });

    it('should not duplicate existing audit entries', () => {
      const sessionId = 'duplicate-test';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const description = 'Fixed bug in auth';
      db.prepare('INSERT INTO observations (session_id, type, detail, files_involved, created_at) VALUES (?, ?, ?, ?, ?)').run(
        sessionId,
        'bugfix',
        description,
        JSON.stringify(['src/auth.ts']),
        new Date().toISOString()
      );

      backfillAuditLog(db);
      const firstCount = backfillAuditLog(db);

      expect(firstCount).toBe(0); // No new entries on second backfill
    });
  });

  describe('handleAuditToolCall', () => {
    it('should handle audit_chain tool call', () => {
      const sessionId = 'handler-session';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const filePath = 'src/test.ts';
      logAuditEntry(db, {
        eventType: 'code_change',
        actor: 'ai',
        filePath,
        changeType: 'create',
        sessionId,
      });

      const result = handleAuditToolCall('massu_audit_chain', { file: filePath }, db);

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Audit Chain');
      expect(text).toContain(filePath);
    });

    it('should return error for missing file parameter', () => {
      const result = handleAuditToolCall('massu_audit_chain', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Usage');
    });

    it('should handle unknown tool name', () => {
      const result = handleAuditToolCall('massu_unknown_audit_tool', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Unknown audit tool');
    });
  });
});

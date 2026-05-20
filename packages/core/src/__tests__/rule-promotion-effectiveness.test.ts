// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-004: CR-53 drift-guard.
// Dual-channel observability: (a) audit_log query for any rule_promoted
// row older than 7 days with recurrence_count > 0; (b) failure-log channel
// at .massu/rule-candidates/.cr53-increment-failures.jsonl with any
// entry within 7 days.
//
// Allowlist via MASSU_KNOWN_RULE_LIMITATIONS (jsonl-style) applies to
// channel (a) ONLY — failure-log entries cannot be allowlisted since they
// represent unknown failure modes that need investigation.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import { logAuditEntry } from '../audit-trail.ts';
import {
  evaluateCr53Effectiveness,
  parseKnownLimitations,
} from '../rule-promotion-effectiveness.ts';

function mkDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`).run();
  return db;
}

describe('CR-53 effectiveness drift-guard (P-D-004)', () => {
  it('passes on empty DB + missing failure log', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    try {
      const result = evaluateCr53Effectiveness({
        db,
        failureLogPath: join(tmp, '.cr53-increment-failures.jsonl'),
        knownLimitations: [],
      });
      expect(result.ok).toBe(true);
      expect(result.auditViolations).toEqual([]);
      expect(result.failureLogViolations).toEqual([]);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FAILs on synthetic audit_log row with recurrence_count > 0 older than 7 days', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    try {
      logAuditEntry(db, {
        eventType: 'rule_promoted', actor: 'human', sessionId: 's',
        filePath: 'packages/core/src/foo.ts',
        metadata: { prompt_hash: 'h-bad', recurrence_count: 2 },
      });
      const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
      db.prepare(`UPDATE audit_log SET timestamp = datetime('now', '-8 days') WHERE id = ?`).run(id);

      const result = evaluateCr53Effectiveness({
        db, failureLogPath: join(tmp, '.cr53-increment-failures.jsonl'), knownLimitations: [],
      });
      expect(result.ok).toBe(false);
      expect(result.auditViolations.length).toBe(1);
      expect(result.auditViolations[0].promptHash).toBe('h-bad');
      expect(result.auditViolations[0].recurrenceCount).toBe(2);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allowlist via knownLimitations exempts specific prompt_hashes', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    try {
      logAuditEntry(db, {
        eventType: 'rule_promoted', actor: 'human', sessionId: 's',
        filePath: 'foo.ts',
        metadata: { prompt_hash: 'h-allowed', recurrence_count: 1 },
      });
      const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
      db.prepare(`UPDATE audit_log SET timestamp = datetime('now', '-8 days') WHERE id = ?`).run(id);

      const result = evaluateCr53Effectiveness({
        db, failureLogPath: join(tmp, '.cr53-increment-failures.jsonl'),
        knownLimitations: [{ promptHash: 'h-allowed', reason: 'pre-existing known gap' }],
      });
      expect(result.ok).toBe(true);
      expect(result.auditViolations).toEqual([]);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rules younger than 7 days are NOT a violation even with recurrence', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    try {
      logAuditEntry(db, {
        eventType: 'rule_promoted', actor: 'human', sessionId: 's',
        filePath: 'foo.ts',
        metadata: { prompt_hash: 'h-young', recurrence_count: 5 },
      });
      // Default timestamp is "now" — within 7 days
      const result = evaluateCr53Effectiveness({
        db, failureLogPath: join(tmp, '.cr53-increment-failures.jsonl'), knownLimitations: [],
      });
      expect(result.ok).toBe(true);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FAILs on synthetic failure-log entry within 7 days', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    const failurePath = join(tmp, '.cr53-increment-failures.jsonl');
    try {
      writeFileSync(failurePath, JSON.stringify({
        session_id: 's',
        error: 'something went wrong',
        timestamp: new Date().toISOString(),
        scanner_output_excerpt: 'mocked',
      }) + '\n', 'utf-8');
      const result = evaluateCr53Effectiveness({
        db, failureLogPath: failurePath, knownLimitations: [],
      });
      expect(result.ok).toBe(false);
      expect(result.failureLogViolations.length).toBe(1);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores failure-log entries older than 7 days', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    const failurePath = join(tmp, '.cr53-increment-failures.jsonl');
    try {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(failurePath, JSON.stringify({
        session_id: 's', error: 'old issue', timestamp: old,
      }) + '\n', 'utf-8');
      const result = evaluateCr53Effectiveness({
        db, failureLogPath: failurePath, knownLimitations: [],
      });
      expect(result.ok).toBe(true);
      expect(result.failureLogViolations).toEqual([]);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('failure-log violations are NOT silenced by knownLimitations allowlist', () => {
    const db = mkDb();
    const tmp = mkdtempSync(join(tmpdir(), 'massu-cr53-'));
    const failurePath = join(tmp, '.cr53-increment-failures.jsonl');
    try {
      writeFileSync(failurePath, JSON.stringify({
        session_id: 's', error: 'unknown failure', timestamp: new Date().toISOString(),
      }) + '\n', 'utf-8');
      const result = evaluateCr53Effectiveness({
        db, failureLogPath: failurePath,
        knownLimitations: [{ promptHash: 'anything', reason: 'should not silence' }],
      });
      expect(result.ok).toBe(false);
      expect(result.failureLogViolations.length).toBe(1);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('parseKnownLimitations', () => {
    it('parses JSON array of objects', () => {
      const arr = parseKnownLimitations('[{"promptHash":"h1","reason":"x"},{"promptHash":"h2","reason":"y"}]');
      expect(arr).toEqual([
        { promptHash: 'h1', reason: 'x' },
        { promptHash: 'h2', reason: 'y' },
      ]);
    });

    it('returns empty array on empty / undefined input', () => {
      expect(parseKnownLimitations(undefined)).toEqual([]);
      expect(parseKnownLimitations('')).toEqual([]);
    });

    it('returns empty array on malformed JSON', () => {
      expect(parseKnownLimitations('{not json')).toEqual([]);
    });
  });
});

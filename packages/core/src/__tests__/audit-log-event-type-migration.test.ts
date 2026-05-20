// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-C-001: schema migration test.
// Validates the 12-step SQLite recreate procedure for the audit_log
// event_type CHECK extension (6 → 9 values), and asserts the TypeScript
// AuditEntry.eventType union stays in lockstep with the SQL CHECK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, migrateAuditLogCheckExtension } from '../memory-db.ts';
import { logAuditEntry, type AuditEntry } from '../audit-trail.ts';

function mkDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const NEW_EVENT_TYPES = [
  'rule_candidate_emitted',
  'rule_promoted',
  'rule_dismissed',
] as const;
const ORIGINAL_EVENT_TYPES = [
  'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
] as const;

describe('audit_log event_type CHECK migration (P-C-001)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = mkDb();
    initMemorySchema(db);
  });

  afterEach(() => { db.close(); });

  it('fresh DB accepts all 9 event_type values', () => {
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`).run();
    for (const t of [...ORIGINAL_EVENT_TYPES, ...NEW_EVENT_TYPES]) {
      expect(() =>
        db.prepare(`INSERT INTO audit_log (session_id, event_type, actor) VALUES ('s', ?, 'ai')`).run(t)
      ).not.toThrow();
    }
  });

  it('rejects invalid event_type values', () => {
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`).run();
    expect(() =>
      db.prepare(`INSERT INTO audit_log (session_id, event_type, actor) VALUES ('s', 'totally_bogus_event', 'ai')`).run()
    ).toThrow(/CHECK/i);
  });

  it('logAuditEntry typings cover all 3 new event types (compile-time)', () => {
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`).run();
    const entries: AuditEntry[] = NEW_EVENT_TYPES.map(t => ({
      eventType: t,
      actor: 'human',
      sessionId: 's',
      metadata: { prompt_hash: `h-${t}`, recurrence_count: 0 },
    }));
    for (const e of entries) {
      expect(() => logAuditEntry(db, e)).not.toThrow();
    }
    const rows = db.prepare(`SELECT event_type FROM audit_log ORDER BY id LIMIT 100`).all() as Array<{ event_type: string }>;
    expect(rows.map(r => r.event_type)).toEqual([...NEW_EVENT_TYPES]);
  });

  it('UNIQUE INDEX idx_audit_rule_promoted enforces single-promote per prompt_hash', () => {
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`).run();
    const hash = 'h-deadbeef';
    logAuditEntry(db, {
      eventType: 'rule_promoted', actor: 'human', sessionId: 's',
      metadata: { prompt_hash: hash, recurrence_count: 0 },
    });
    expect(() => logAuditEntry(db, {
      eventType: 'rule_promoted', actor: 'human', sessionId: 's',
      metadata: { prompt_hash: hash, recurrence_count: 0 },
    })).toThrow(/UNIQUE constraint failed/i);
  });

  it('UNIQUE INDEX is partial — non-promote rows are not constrained', () => {
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`).run();
    const hash = 'h-shared';
    logAuditEntry(db, {
      eventType: 'rule_candidate_emitted', actor: 'hook', sessionId: 's',
      metadata: { prompt_hash: hash },
    });
    expect(() => logAuditEntry(db, {
      eventType: 'rule_candidate_emitted', actor: 'hook', sessionId: 's',
      metadata: { prompt_hash: hash },
    })).not.toThrow();
  });
});

describe('migrateAuditLogCheckExtension upgrade path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = mkDb();
    // Hand-create the OLD 6-value schema to simulate a pre-v0.2 DB.
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL
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
        approval_status TEXT,
        evidence TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0);
      INSERT INTO audit_log (session_id, event_type, actor) VALUES ('s', 'commit', 'ai');
      INSERT INTO audit_log (session_id, event_type, actor) VALUES ('s', 'review', 'human');
    `);
  });

  afterEach(() => { db.close(); });

  it('OLD schema rejects new event_types before migration', () => {
    expect(() =>
      db.prepare(`INSERT INTO audit_log (session_id, event_type, actor) VALUES ('s', 'rule_promoted', 'human')`).run()
    ).toThrow(/CHECK/i);
  });

  it('migration extends CHECK, preserves all existing rows, and accepts new event_types', () => {
    const beforeCount = (db.prepare(`SELECT COUNT(*) as n FROM audit_log`).get() as { n: number }).n;
    migrateAuditLogCheckExtension(db);
    const afterCount = (db.prepare(`SELECT COUNT(*) as n FROM audit_log`).get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);

    for (const t of NEW_EVENT_TYPES) {
      expect(() =>
        db.prepare(`INSERT INTO audit_log (session_id, event_type, actor) VALUES ('s', ?, 'human')`).run(t)
      ).not.toThrow();
    }
  });

  it('migration is idempotent — re-running on current schema is a no-op', () => {
    migrateAuditLogCheckExtension(db);
    const sqlAfterFirst = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='audit_log'`).get() as { sql: string }).sql;
    migrateAuditLogCheckExtension(db);
    const sqlAfterSecond = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='audit_log'`).get() as { sql: string }).sql;
    expect(sqlAfterSecond).toBe(sqlAfterFirst);
  });
});

describe('prompt_outcomes_signal_blacklist schema (P-C-002)', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkDb(); initMemorySchema(db); });
  afterEach(() => { db.close(); });

  it('table exists with expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(prompt_outcomes_signal_blacklist)`).all() as Array<{ name: string; type: string; pk: number }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual(['dismissal_count', 'first_dismissed_at', 'last_dismissed_at', 'signal']);
    const pk = cols.find(c => c.name === 'signal');
    expect(pk?.pk).toBe(1);
  });

  it('idx_psb_count index exists', () => {
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_psb_count'`).get();
    expect(idx).toBeTruthy();
  });

  it('INSERT-OR-UPDATE pattern increments dismissal_count', () => {
    db.prepare(`
      INSERT INTO prompt_outcomes_signal_blacklist (signal, dismissal_count, last_dismissed_at)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(signal) DO UPDATE SET
        dismissal_count = dismissal_count + 1,
        last_dismissed_at = datetime('now')
    `).run('strong_correction_phrase:should be');
    db.prepare(`
      INSERT INTO prompt_outcomes_signal_blacklist (signal, dismissal_count, last_dismissed_at)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(signal) DO UPDATE SET
        dismissal_count = dismissal_count + 1,
        last_dismissed_at = datetime('now')
    `).run('strong_correction_phrase:should be');

    const row = db.prepare(`SELECT dismissal_count FROM prompt_outcomes_signal_blacklist WHERE signal = ?`)
      .get('strong_correction_phrase:should be') as { dismissal_count: number };
    expect(row.dismissal_count).toBe(2);
  });
});

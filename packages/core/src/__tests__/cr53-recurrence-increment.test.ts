// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-011: unit tests for the CR-53
// Layer 2 recurrence-count increment helper. The hook integration that
// catches errors and writes `.cr53-increment-failures.jsonl` is verified
// separately by the P-D-004 drift-guard test reading that channel.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import { logAuditEntry } from '../audit-trail.ts';
// ARCH-04 fix: imports the library module rather than the bundled hook
// entry, breaking the test-infra ↔ esbuild-entry coupling.
import { incrementRecurrenceCountsForScannerFailures } from '../lib/recurrence-incrementer.ts';

const SESSION = 'session-cr53';

function mkDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, datetime('now'), 0)`).run(SESSION);
  return db;
}

function seedRulePromoted(
  db: Database.Database,
  opts: { filePath: string; promptHash: string; ageHours?: number; recurrence?: number }
): number {
  const metadata: Record<string, unknown> = {
    prompt_hash: opts.promptHash,
    recurrence_count: opts.recurrence ?? 0,
  };
  logAuditEntry(db, {
    eventType: 'rule_promoted',
    actor: 'human',
    sessionId: SESSION,
    filePath: opts.filePath,
    metadata,
  });
  const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  if (opts.ageHours && opts.ageHours > 0) {
    db.prepare(`UPDATE audit_log SET timestamp = datetime('now', ?) WHERE id = ?`)
      .run(`-${opts.ageHours} hours`, id);
  }
  return id;
}

function recordSessionEdit(db: Database.Database, filePath: string): void {
  logAuditEntry(db, {
    eventType: 'code_change',
    actor: 'ai',
    sessionId: SESSION,
    filePath,
    changeType: 'edit',
  });
}

describe('CR-53 recurrence increment (P-D-011)', () => {
  let db: Database.Database;
  beforeEach(() => { db = mkDb(); });
  afterEach(() => { db.close(); });

  it('(a) increments recurrence_count when scanner FAILs on a session-edited file', () => {
    const ruleId = seedRulePromoted(db, { filePath: 'packages/core/src/foo.ts', promptHash: 'h1' });
    recordSessionEdit(db, 'packages/core/src/foo.ts');

    const stdout = [
      'Check 7: foo',
      '  FAIL: packages/core/src/foo.ts violates the rule',
      'Check 8: bar',
      '  PASS: ok',
    ].join('\n');
    const updates = incrementRecurrenceCountsForScannerFailures(db, SESSION, stdout);
    expect(updates).toBe(1);

    const row = db.prepare(`SELECT metadata FROM audit_log WHERE id = ?`).get(ruleId) as { metadata: string };
    expect(JSON.parse(row.metadata).recurrence_count).toBe(1);
  });

  it('(a-1) handles ANSI color escapes in the FAIL line', () => {
    seedRulePromoted(db, { filePath: 'packages/core/src/foo.ts', promptHash: 'h1' });
    recordSessionEdit(db, 'packages/core/src/foo.ts');
    const ansiFail = `Check 7:\n  \x1b[31mFAIL\x1b[0m: packages/core/src/foo.ts violates`;
    const updates = incrementRecurrenceCountsForScannerFailures(db, SESSION, ansiFail);
    expect(updates).toBe(1);
  });

  it('(b) does NOT update when scanner FAIL is on a file NOT edited in session', () => {
    seedRulePromoted(db, { filePath: 'packages/core/src/foo.ts', promptHash: 'h1' });
    // Edit a different file
    recordSessionEdit(db, 'packages/core/src/bar.ts');
    const stdout = '  FAIL: packages/core/src/foo.ts violates rule';
    const updates = incrementRecurrenceCountsForScannerFailures(db, SESSION, stdout);
    expect(updates).toBe(0);
  });

  it('(c) does NOT update when matching rule older than 7 days', () => {
    seedRulePromoted(db, {
      filePath: 'packages/core/src/foo.ts',
      promptHash: 'h_old',
      ageHours: 24 * 8, // 8 days
    });
    recordSessionEdit(db, 'packages/core/src/foo.ts');
    const stdout = '  FAIL: packages/core/src/foo.ts violates rule';
    const updates = incrementRecurrenceCountsForScannerFailures(db, SESSION, stdout);
    expect(updates).toBe(0);
  });

  it('returns 0 when scanner stdout has no FAIL lines', () => {
    seedRulePromoted(db, { filePath: 'foo.ts', promptHash: 'h1' });
    recordSessionEdit(db, 'foo.ts');
    const stdout = 'PASS: all good\nPASS: another check';
    expect(incrementRecurrenceCountsForScannerFailures(db, SESSION, stdout)).toBe(0);
  });

  it('returns 0 when session edits are older than 24h', () => {
    seedRulePromoted(db, { filePath: 'foo.ts', promptHash: 'h1' });
    // Record edit then age it
    recordSessionEdit(db, 'foo.ts');
    const id = (db.prepare(`SELECT id FROM audit_log WHERE event_type='code_change' ORDER BY id DESC LIMIT 1`).get() as { id: number }).id;
    db.prepare(`UPDATE audit_log SET timestamp = datetime('now', '-25 hours') WHERE id = ?`).run(id);
    const stdout = '  FAIL: foo.ts violates rule';
    expect(incrementRecurrenceCountsForScannerFailures(db, SESSION, stdout)).toBe(0);
  });

  it('matches by basename when scanner emits relative path but session has absolute path', () => {
    seedRulePromoted(db, { filePath: '/abs/packages/core/src/foo.ts', promptHash: 'h1' });
    recordSessionEdit(db, '/abs/packages/core/src/foo.ts');
    const stdout = '  FAIL: packages/core/src/foo.ts violates rule';
    expect(incrementRecurrenceCountsForScannerFailures(db, SESSION, stdout)).toBe(1);
  });
});

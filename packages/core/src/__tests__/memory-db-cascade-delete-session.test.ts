// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H011 (plan-stage-c-high-batch) drift-guard.
 *
 * Closes the bug-class where 10 of 13 memory-db tables had FOREIGN KEY
 * references to sessions(session_id) WITHOUT `ON DELETE CASCADE`. Under
 * `PRAGMA foreign_keys = ON` (which getMemoryDb() enables), DELETE FROM
 * sessions WHERE ... with surviving children throws "FOREIGN KEY constraint
 * failed". The audit cited 12 newer tables; analysis found 10 affected
 * (`tool_call_details`, `session_quality_scores`, `session_costs`,
 * `feature_costs`, `prompt_outcomes`, `audit_log`, `validation_results`,
 * `architecture_decisions`, `security_scores`, and `conversation_turns`).
 *
 * Structural fix: all 10 CREATE TABLE statements now declare
 * `ON DELETE CASCADE`. Note: existing customer DBs from prior versions
 * retain the non-cascade tables (CREATE TABLE IF NOT EXISTS no-ops); the
 * fix takes effect for fresh installs from 1.10.2 onward. The drift-guard
 * below scans the source AND fires a fresh-init cascade-delete test to
 * catch any future regression.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initMemorySchema, createSession, addObservation } from '../memory-db.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('memory-db cascade-delete-session (P-H011)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initMemorySchema(db);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it('every FK to sessions(session_id) in memory-db.ts declares ON DELETE CASCADE', () => {
    const source = readFileSync(resolve(__dirname, '../memory-db.ts'), 'utf-8');
    const fkLines = source
      .split('\n')
      .filter((l) => l.match(/FOREIGN KEY\s*\(\s*session_id\s*\)\s+REFERENCES\s+sessions\(session_id\)/));
    expect(fkLines.length).toBeGreaterThan(0);
    for (const line of fkLines) {
      expect(line, `FK without ON DELETE CASCADE: ${line.trim()}`).toMatch(/ON DELETE CASCADE/);
    }
  });

  it('DELETE FROM sessions cascades to children without throwing', () => {
    // Create a session and a child observation
    createSession(db, 'test-session-cascade');
    addObservation(db, 'test-session-cascade', 'decision', 'test title', 'test detail', { importance: 3 });

    // Insert into a few of the formerly-non-cascade tables too.
    db.prepare(`
      INSERT INTO conversation_turns (session_id, turn_number, user_prompt, created_at, created_at_epoch)
      VALUES (?, 1, 'hello', datetime('now'), unixepoch())
    `).run('test-session-cascade');
    db.prepare(`
      INSERT INTO audit_log (session_id, event_type, actor)
      VALUES (?, 'code_change', 'ai')
    `).run('test-session-cascade');
    db.prepare(`
      INSERT INTO security_scores (session_id, file_path)
      VALUES (?, '/tmp/x.ts')
    `).run('test-session-cascade');

    // Pre-conditions
    expect(db.prepare('SELECT COUNT(*) as c FROM observations').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) as c FROM conversation_turns').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) as c FROM audit_log').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) as c FROM security_scores').get()).toEqual({ c: 1 });

    // DELETE FROM sessions — pre-fix this throws "FOREIGN KEY constraint failed"
    expect(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run('test-session-cascade');
    }).not.toThrow();

    // Post-conditions: all children cascaded out
    expect(db.prepare('SELECT COUNT(*) as c FROM observations').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) as c FROM conversation_turns').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) as c FROM audit_log').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) as c FROM security_scores').get()).toEqual({ c: 0 });
  });
});

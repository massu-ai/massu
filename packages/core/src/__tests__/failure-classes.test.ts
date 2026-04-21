// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Failure Classes taxonomy tests (Phase 5-6 auto-learning schema).
 *
 * Covers the `failure_classes` table and its 4 public helpers:
 *   - addFailureClass
 *   - getFailureClasses
 *   - appendIncidentToFailureClass
 *   - scoreFailureClasses
 *
 * Uses an in-memory SQLite instance so tests are hermetic and can run in
 * parallel with the rest of the suite without file-system contention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  addFailureClass,
  getFailureClasses,
  appendIncidentToFailureClass,
  scoreFailureClasses,
} from '../memory-db.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // Subset of initSchema — just the failure_classes table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      diff_patterns TEXT NOT NULL DEFAULT '[]',
      file_patterns TEXT NOT NULL DEFAULT '[]',
      prompt_keywords TEXT NOT NULL DEFAULT '[]',
      incidents TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL DEFAULT '[]',
      scanner_checks TEXT NOT NULL DEFAULT '[]',
      known_message TEXT NOT NULL DEFAULT '',
      needs_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fc_name ON failure_classes(name);
    CREATE INDEX IF NOT EXISTS idx_fc_needs_review ON failure_classes(needs_review);
  `);
  return db;
}

describe('memory-db: failure_classes taxonomy', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('addFailureClass', () => {
    it('inserts a failure class with default empty arrays', () => {
      const id = addFailureClass(db, {
        name: 'sample_class',
        description: 'Test class',
      });
      expect(id).toBeGreaterThan(0);

      const all = getFailureClasses(db);
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('sample_class');
      expect(all[0].description).toBe('Test class');
      expect(all[0].diff_patterns).toEqual([]);
      expect(all[0].file_patterns).toEqual([]);
      expect(all[0].prompt_keywords).toEqual([]);
      expect(all[0].incidents).toEqual([]);
      expect(all[0].rules).toEqual([]);
      expect(all[0].scanner_checks).toEqual([]);
      expect(all[0].known_message).toBe('');
      expect(all[0].needs_review).toBe(false);
    });

    it('inserts a failure class with all fields populated', () => {
      addFailureClass(db, {
        name: 'config_drift',
        description: 'Config file drifts from repo layout',
        diffPatterns: ['framework.type:\\s*typescript'],
        filePatterns: ['massu\\.config\\.yaml$'],
        promptKeywords: ['config', 'drift', 'stale'],
        incidents: ['1', '2'],
        rules: ['CR-36', 'VR-SCHEMA-SYNC'],
        scannerChecks: ['detectDrift'],
        knownMessage: 'Run `massu init --force`',
        needsReview: true,
      });

      const [fc] = getFailureClasses(db);
      expect(fc.diff_patterns).toEqual(['framework.type:\\s*typescript']);
      expect(fc.file_patterns).toEqual(['massu\\.config\\.yaml$']);
      expect(fc.prompt_keywords).toEqual(['config', 'drift', 'stale']);
      expect(fc.incidents).toEqual(['1', '2']);
      expect(fc.rules).toEqual(['CR-36', 'VR-SCHEMA-SYNC']);
      expect(fc.scanner_checks).toEqual(['detectDrift']);
      expect(fc.known_message).toBe('Run `massu init --force`');
      expect(fc.needs_review).toBe(true);
    });

    it('is idempotent on duplicate name (INSERT OR IGNORE)', () => {
      addFailureClass(db, { name: 'dup', description: 'first' });
      addFailureClass(db, { name: 'dup', description: 'second' });
      const all = getFailureClasses(db);
      expect(all).toHaveLength(1);
      expect(all[0].description).toBe('first');
    });
  });

  describe('appendIncidentToFailureClass', () => {
    it('appends an incident id to an existing class', () => {
      addFailureClass(db, { name: 'bug', description: 'test', incidents: ['1'] });
      appendIncidentToFailureClass(db, 'bug', '2');
      const [fc] = getFailureClasses(db);
      expect(fc.incidents).toEqual(['1', '2']);
    });

    it('de-duplicates when the incident id is already present', () => {
      addFailureClass(db, { name: 'bug', description: 'test', incidents: ['1'] });
      appendIncidentToFailureClass(db, 'bug', '1');
      const [fc] = getFailureClasses(db);
      expect(fc.incidents).toEqual(['1']);
    });

    it('silently no-ops on unknown class name', () => {
      appendIncidentToFailureClass(db, 'does-not-exist', '99');
      expect(getFailureClasses(db)).toHaveLength(0);
    });
  });

  describe('scoreFailureClasses', () => {
    it('returns null on empty taxonomy', () => {
      const res = scoreFailureClasses(db, 'any text', 'any/file.ts', 'any prompt');
      expect(res).toBeNull();
    });

    it('scores diff pattern hits with default weight of 3', () => {
      addFailureClass(db, {
        name: 'null_return',
        description: 'stub code returning null',
        diffPatterns: ['return null'],
      });
      const res = scoreFailureClasses(db, 'function foo() { return null; }', 'src/a.ts', '');
      expect(res).not.toBeNull();
      expect(res!.score).toBe(3);
      expect(res!.name).toBe('null_return');
    });

    it('scores file pattern hits with default weight of 2', () => {
      addFailureClass(db, {
        name: 'config_issue',
        description: 'config-shaped',
        filePatterns: ['config\\.yaml'],
      });
      const res = scoreFailureClasses(db, 'unrelated', 'massu.config.yaml', '');
      expect(res!.score).toBe(2);
    });

    it('scores prompt keywords with default weight of 2 only when promptContext is non-empty', () => {
      addFailureClass(db, {
        name: 'perf',
        description: 'perf',
        promptKeywords: ['slow'],
      });
      const empty = scoreFailureClasses(db, 'x', 'y.ts', '');
      expect(empty!.score).toBe(0);
      const withPrompt = scoreFailureClasses(db, 'x', 'y.ts', 'this is slow');
      expect(withPrompt!.score).toBe(2);
    });

    it('combines multiple signals additively and picks highest-scoring class', () => {
      addFailureClass(db, {
        name: 'weak',
        description: 'only prompt keyword',
        promptKeywords: ['bug'],
      });
      addFailureClass(db, {
        name: 'strong',
        description: 'diff + file + prompt',
        diffPatterns: ['TODO'],
        filePatterns: ['src/'],
        promptKeywords: ['bug'],
      });
      const res = scoreFailureClasses(db, '// TODO: fix', 'src/a.ts', 'this bug');
      expect(res!.name).toBe('strong');
      expect(res!.score).toBe(3 + 2 + 2); // diff + file + prompt
    });

    it('accepts custom weights and applies them', () => {
      addFailureClass(db, {
        name: 'x',
        description: '',
        diffPatterns: ['DROP TABLE'],
      });
      const res = scoreFailureClasses(
        db,
        'DROP TABLE users',
        'a.sql',
        '',
        { diffPatternWeight: 10 }
      );
      expect(res!.score).toBe(10);
    });

    it('falls back to substring matching when pattern is not a valid regex', () => {
      addFailureClass(db, {
        name: 'invalid_regex_fallback',
        description: '',
        diffPatterns: ['('], // invalid regex — parens unbalanced
      });
      const res = scoreFailureClasses(db, 'a ( b', 'file.ts', '');
      // Substring fallback finds `(` in `a ( b`.
      expect(res!.score).toBe(3);
    });
  });
});

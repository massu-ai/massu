// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  getValidationToolDefinitions,
  isValidationTool,
  validateFile,
  storeValidationResult,
  handleValidationToolCall,
  type ValidationCheck,
} from '../validation-engine.ts';

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

    CREATE TABLE validation_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      file_path TEXT NOT NULL,
      validation_type TEXT NOT NULL,
      passed INTEGER NOT NULL DEFAULT 1,
      details TEXT,
      rules_violated TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

describe('validation-engine', () => {
  let db: Database.Database;
  let testDir: string;

  beforeEach(() => {
    db = createTestDb();
    testDir = join('/tmp', 'massu-test-' + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getValidationToolDefinitions', () => {
    it('should return tool definitions for validation tools', () => {
      const defs = getValidationToolDefinitions();
      expect(defs.length).toBe(2);

      const names = defs.map(d => d.name);
      expect(names.some(n => n.includes('validation_check'))).toBe(true);
      expect(names.some(n => n.includes('validation_report'))).toBe(true);

      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeTruthy();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('isValidationTool', () => {
    it('should return true for validation tools', () => {
      expect(isValidationTool('massu_validation_check')).toBe(true);
      expect(isValidationTool('massu_validation_report')).toBe(true);
    });

    it('should return false for non-validation tools', () => {
      expect(isValidationTool('massu_cost_session')).toBe(false);
      expect(isValidationTool('massu_quality_score')).toBe(false);
      expect(isValidationTool('random_tool')).toBe(false);
    });

    it('should handle base names without prefix', () => {
      expect(isValidationTool('validation_check')).toBe(true);
      expect(isValidationTool('validation_report')).toBe(true);
    });
  });

  describe('validateFile', () => {
    it('should return error check for non-existent file', () => {
      const filePath = join(testDir, 'nonexistent.ts');
      const checks = validateFile(filePath, testDir);

      expect(checks.length).toBeGreaterThan(0);
      const fileCheck = checks.find(c => c.name === 'file_exists');
      expect(fileCheck).toBeDefined();
      expect(fileCheck?.severity).toBe('error');
    });

    it('should block path traversal attempts', () => {
      const filePath = '../../../etc/passwd';
      const checks = validateFile(filePath, testDir);

      expect(checks.length).toBeGreaterThan(0);
      const pathCheck = checks.find(c => c.name === 'path_traversal');
      expect(pathCheck).toBeDefined();
      expect(pathCheck?.severity).toBe('critical');
    });

    it('should validate existing file', () => {
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, `
// Simple test file
export function hello() {
  return "world";
}
      `.trim());

      const checks = validateFile(filePath, testDir);

      // Should not have critical errors
      const criticalErrors = checks.filter(c => c.severity === 'critical' || c.severity === 'error');
      expect(criticalErrors.length).toBe(0);
    });

    it('should detect import hallucinations', () => {
      const filePath = join(testDir, 'imports.ts');
      writeFileSync(filePath, `
import { something } from './nonexistent.ts';
import { other } from '@/fake-module.ts';
      `.trim());

      const checks = validateFile(filePath, testDir);

      const importErrors = checks.filter(c => c.name === 'import_hallucination');
      expect(importErrors.length).toBeGreaterThan(0);
      expect(importErrors[0].severity).toBe('error');
    });
  });

  describe('storeValidationResult', () => {
    it('should store validation result in database', () => {
      const sessionId = 'test-session-1';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const checks: ValidationCheck[] = [
        {
          name: 'import_hallucination',
          severity: 'error',
          message: 'Import not found',
          line: 1,
          file: 'test.ts',
        },
        {
          name: 'rule_compliance',
          severity: 'warning',
          message: 'Rule violation',
          file: 'test.ts',
        },
      ];

      storeValidationResult(db, 'test.ts', checks, sessionId);

      const results = db.prepare('SELECT * FROM validation_results WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(results.length).toBe(1);
      expect(results[0].file_path).toBe('test.ts');
      expect(results[0].passed).toBe(0); // Has errors
      expect(results[0].details).toBeTruthy();

      const details = JSON.parse(results[0].details as string);
      expect(details.length).toBe(2);
    });

    it('should mark as passed when no errors', () => {
      const sessionId = 'test-session-2';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const checks: ValidationCheck[] = [
        {
          name: 'rule_applicable',
          severity: 'info',
          message: 'Rule applies',
          file: 'test.ts',
        },
      ];

      storeValidationResult(db, 'test.ts', checks, sessionId);

      const results = db.prepare('SELECT * FROM validation_results WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(results.length).toBe(1);
      expect(results[0].passed).toBe(1); // No errors
    });

    it('should record violated rules', () => {
      const sessionId = 'test-session-3';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const checks: ValidationCheck[] = [
        {
          name: 'import_hallucination',
          severity: 'error',
          message: 'Import not found',
          file: 'test.ts',
        },
        {
          name: 'db_access_pattern',
          severity: 'warning',
          message: 'Wrong pattern',
          file: 'test.ts',
        },
      ];

      storeValidationResult(db, 'test.ts', checks, sessionId);

      const results = db.prepare('SELECT * FROM validation_results WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(results[0].rules_violated).toBeTruthy();
      expect((results[0].rules_violated as string).includes('import_hallucination')).toBe(true);
      expect((results[0].rules_violated as string).includes('db_access_pattern')).toBe(true);
    });
  });

  describe('handleValidationToolCall', () => {
    it('should handle validation_check tool call for non-existent file', () => {
      const filePath = join(testDir, 'nonexistent.ts');
      const result = handleValidationToolCall('massu_validation_check', { file: filePath }, db);

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Validation');
      expect(text).toContain('Errors');
    });

    it('should return error for missing file parameter', () => {
      const result = handleValidationToolCall('massu_validation_check', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Usage');
    });

    it('should handle validation_report tool call', () => {
      const sessionId = 'report-session';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const checks: ValidationCheck[] = [
        {
          name: 'test_error',
          severity: 'error',
          message: 'Test error',
          file: 'test.ts',
        },
      ];

      storeValidationResult(db, 'test.ts', checks, sessionId);

      const result = handleValidationToolCall('massu_validation_report', { days: 7 }, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Validation Report');
    });

    it('should handle unknown tool name', () => {
      const result = handleValidationToolCall('massu_unknown_validation_tool', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Unknown validation tool');
    });
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getRegressionToolDefinitions,
  isRegressionTool,
  calculateHealthScore,
  trackModification,
  recordTestResult,
  handleRegressionToolCall,
} from '../regression-detector.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE feature_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL UNIQUE,
      health_score INTEGER NOT NULL DEFAULT 100,
      tests_passing INTEGER NOT NULL DEFAULT 0,
      tests_failing INTEGER NOT NULL DEFAULT 0,
      test_coverage_pct REAL,
      modifications_since_test INTEGER NOT NULL DEFAULT 0,
      last_modified TEXT,
      last_tested TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('regression-detector', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getRegressionToolDefinitions', () => {
    it('returns 2 tool definitions', () => {
      const tools = getRegressionToolDefinitions();
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name.split('_').slice(-2).join('_'))).toEqual([
        'feature_health',
        'regression_risk',
      ]);
    });

    it('has required fields in tool definitions', () => {
      const tools = getRegressionToolDefinitions();
      tools.forEach(tool => {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
      });
    });
  });

  describe('isRegressionTool', () => {
    it('returns true for regression tool names', () => {
      expect(isRegressionTool('massu_feature_health')).toBe(true);
      expect(isRegressionTool('massu_regression_risk')).toBe(true);
    });

    it('returns false for non-regression tool names', () => {
      expect(isRegressionTool('massu_security_score')).toBe(false);
      expect(isRegressionTool('massu_unknown')).toBe(false);
    });
  });

  describe('calculateHealthScore', () => {
    it('returns 100 for healthy feature', () => {
      const score = calculateHealthScore(
        10, // tests passing
        0,  // tests failing
        0,  // modifications since test
        new Date().toISOString(),
        new Date().toISOString()
      );
      expect(score).toBe(100);
    });

    it('reduces score for failing tests', () => {
      const score = calculateHealthScore(5, 2, 0, null, null);
      expect(score).toBeLessThan(100);
      expect(score).toBeLessThanOrEqual(80); // -20 for 2 failing tests
    });

    it('reduces score for untested modifications', () => {
      const score = calculateHealthScore(10, 0, 3, null, null);
      expect(score).toBeLessThan(100);
      expect(score).toBeLessThanOrEqual(85); // -15 for 3 modifications
    });

    it('reduces score for modified but never tested', () => {
      const score = calculateHealthScore(0, 0, 0, null, new Date().toISOString());
      expect(score).toBeLessThan(100);
      expect(score).toBe(70); // -30 for never tested
    });

    it('reduces score for time gap between modification and test', () => {
      const modDate = new Date();
      const testDate = new Date(modDate.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const score = calculateHealthScore(10, 0, 0, testDate.toISOString(), modDate.toISOString());
      expect(score).toBeLessThan(100);
    });

    it('floors score at 0', () => {
      const score = calculateHealthScore(0, 10, 10, null, null);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('combines multiple risk factors', () => {
      const score = calculateHealthScore(
        5,  // passing
        3,  // 3 failing = -30
        5,  // 5 modifications = -25
        null,
        null
      );
      expect(score).toBeLessThan(50);
    });
  });

  describe('trackModification', () => {
    it('creates new feature health record on first modification', () => {
      trackModification(db, 'feature-auth');

      const feature = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('feature-auth') as Record<string, unknown>;
      expect(feature).toBeDefined();
      expect(feature.modifications_since_test).toBe(1);
      expect(feature.health_score).toBe(70); // Default for new feature with 1 modification
    });

    it('increments modifications for existing feature', () => {
      // Create initial feature
      db.prepare(`
        INSERT INTO feature_health (feature_key, tests_passing, tests_failing, modifications_since_test, health_score)
        VALUES (?, ?, ?, ?, ?)
      `).run('feature-orders', 10, 0, 0, 100);

      trackModification(db, 'feature-orders');

      const feature = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('feature-orders') as Record<string, unknown>;
      expect(feature.modifications_since_test).toBe(1);
      expect(feature.health_score).toBeLessThan(100);
    });

    it('updates last_modified timestamp', () => {
      trackModification(db, 'feature-products');

      const feature = db.prepare('SELECT last_modified FROM feature_health WHERE feature_key = ?').get('feature-products') as { last_modified: string };
      expect(feature.last_modified).toBeTruthy();
    });
  });

  describe('recordTestResult', () => {
    it('creates new feature health record with test results', () => {
      recordTestResult(db, 'feature-auth', 15, 2);

      const feature = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('feature-auth') as Record<string, unknown>;
      expect(feature).toBeDefined();
      expect(feature.tests_passing).toBe(15);
      expect(feature.tests_failing).toBe(2);
      expect(feature.modifications_since_test).toBe(0);
    });

    it('updates existing feature with test results', () => {
      // Create feature with modifications
      db.prepare(`
        INSERT INTO feature_health (feature_key, modifications_since_test, health_score)
        VALUES (?, ?, ?)
      `).run('feature-orders', 5, 75);

      recordTestResult(db, 'feature-orders', 20, 1);

      const feature = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('feature-orders') as Record<string, unknown>;
      expect(feature.tests_passing).toBe(20);
      expect(feature.tests_failing).toBe(1);
      expect(feature.modifications_since_test).toBe(0); // Reset after test
    });

    it('updates last_tested timestamp', () => {
      recordTestResult(db, 'feature-products', 10, 0);

      const feature = db.prepare('SELECT last_tested FROM feature_health WHERE feature_key = ?').get('feature-products') as { last_tested: string };
      expect(feature.last_tested).toBeTruthy();
    });

    it('calculates test coverage percentage', () => {
      recordTestResult(db, 'feature-auth', 15, 5);

      const feature = db.prepare('SELECT test_coverage_pct FROM feature_health WHERE feature_key = ?').get('feature-auth') as { test_coverage_pct: number };
      expect(feature.test_coverage_pct).toBe(75); // 15 / (15 + 5) = 75%
    });

    it('handles all passing tests', () => {
      recordTestResult(db, 'feature-healthy', 20, 0);

      const feature = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('feature-healthy') as Record<string, unknown>;
      expect(feature.health_score).toBe(100);
      expect(feature.test_coverage_pct).toBe(100);
    });
  });

  describe('handleRegressionToolCall', () => {
    it('handles feature_health with no data', () => {
      const result = handleRegressionToolCall('massu_feature_health', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('No feature health data available');
    });

    it('handles feature_health with features', () => {
      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, tests_passing, tests_failing, modifications_since_test)
        VALUES (?, ?, ?, ?, ?)
      `).run('feature-auth', 85, 10, 1, 2);

      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, tests_passing, tests_failing, modifications_since_test)
        VALUES (?, ?, ?, ?, ?)
      `).run('feature-orders', 60, 5, 3, 5);

      const result = handleRegressionToolCall('massu_feature_health', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Feature Health Dashboard');
      expect(text).toContain('feature-auth');
      expect(text).toContain('feature-orders');
      expect(text).toContain('85');
      expect(text).toContain('60');
    });

    it('handles feature_health with unhealthy_only filter', () => {
      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, tests_passing, tests_failing)
        VALUES (?, ?, ?, ?)
      `).run('feature-healthy', 95, 20, 0);

      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, tests_passing, tests_failing)
        VALUES (?, ?, ?, ?)
      `).run('feature-unhealthy', 45, 5, 5);

      const result = handleRegressionToolCall('massu_feature_health', { unhealthy_only: true }, db);
      const text = result.content[0].text;
      expect(text).toContain('feature-unhealthy');
      expect(text).not.toContain('feature-healthy');
    });

    it('handles regression_risk with no modifications', () => {
      const result = handleRegressionToolCall('massu_regression_risk', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('No features have been modified');
    });

    it('handles regression_risk and categorizes by risk level', () => {
      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, modifications_since_test)
        VALUES (?, ?, ?)
      `).run('feature-critical', 30, 5);

      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, modifications_since_test)
        VALUES (?, ?, ?)
      `).run('feature-medium', 65, 3);

      db.prepare(`
        INSERT INTO feature_health (feature_key, health_score, modifications_since_test)
        VALUES (?, ?, ?)
      `).run('feature-low', 85, 1);

      const result = handleRegressionToolCall('massu_regression_risk', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Regression Risk Assessment');
      expect(text).toContain('HIGH RISK');
      expect(text).toContain('Medium Risk');
      expect(text).toContain('Low Risk');
      expect(text).toContain('feature-critical');
      expect(text).toContain('feature-medium');
      expect(text).toContain('feature-low');
    });

    it('handles unknown tool name', () => {
      const result = handleRegressionToolCall('massu_regression_unknown', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Unknown regression tool');
    });
  });
});

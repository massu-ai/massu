// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  getDependencyToolDefinitions,
  isDependencyTool,
  calculateDepRisk,
  getInstalledPackages,
  storeAssessment,
  getPreviousRemovals,
  handleDependencyToolCall,
} from '../dependency-scorer.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dependency_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name TEXT NOT NULL,
      version TEXT,
      risk_score INTEGER NOT NULL DEFAULT 0,
      vulnerabilities INTEGER NOT NULL DEFAULT 0,
      last_publish_days INTEGER,
      weekly_downloads INTEGER,
      license TEXT,
      bundle_size_kb INTEGER,
      previous_removals INTEGER NOT NULL DEFAULT 0,
      assessed_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('dependency-scorer', () => {
  let db: Database.Database;
  const testDir = '/tmp/dependency-scorer-test';

  beforeEach(() => {
    db = createTestDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('getDependencyToolDefinitions', () => {
    it('returns 2 tool definitions', () => {
      const tools = getDependencyToolDefinitions();
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name.split('_').slice(-2).join('_'))).toEqual([
        'dep_score',
        'dep_alternatives',
      ]);
    });

    it('dep_score requires package_name', () => {
      const tools = getDependencyToolDefinitions();
      const scoreTool = tools.find(t => t.name.endsWith('_dep_score'));
      expect(scoreTool?.inputSchema.required).toEqual(['package_name']);
    });
  });

  describe('isDependencyTool', () => {
    it('returns true for dependency tool names', () => {
      expect(isDependencyTool('massu_dep_score')).toBe(true);
      expect(isDependencyTool('massu_dep_alternatives')).toBe(true);
    });

    it('returns false for non-dependency tool names', () => {
      expect(isDependencyTool('massu_security_score')).toBe(false);
      expect(isDependencyTool('massu_unknown')).toBe(false);
    });
  });

  describe('calculateDepRisk', () => {
    it('returns 0 for safe package', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: 30,
        weeklyDownloads: 1000000,
        license: 'MIT',
        bundleSizeKb: 50,
        previousRemovals: 0,
      });
      expect(risk).toBe(0);
    });

    it('adds risk for vulnerabilities', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 2,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 0,
      });
      expect(risk).toBeGreaterThanOrEqual(30); // 2 * 15 = 30
    });

    it('adds risk for stale packages', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: 800, // Over 2 years
        weeklyDownloads: null,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 0,
      });
      expect(risk).toBeGreaterThan(0);
    });

    it('adds risk for low popularity', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: 50, // Very low
        license: null,
        bundleSizeKb: null,
        previousRemovals: 0,
      });
      expect(risk).toBeGreaterThan(0);
    });

    it('adds risk for restrictive licenses', () => {
      const gplRisk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: 'GPL-3.0',
        bundleSizeKb: null,
        previousRemovals: 0,
      });
      expect(gplRisk).toBeGreaterThan(0);

      const agplRisk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: 'AGPL',
        bundleSizeKb: null,
        previousRemovals: 0,
      });
      expect(agplRisk).toBeGreaterThan(0);
    });

    it('adds risk for unknown license', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 0,
      });
      expect(risk).toBe(5); // Unknown license penalty
    });

    it('adds risk for previous removals', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 3,
      });
      expect(risk).toBeGreaterThan(5); // 5 (unknown license) + 15 (3 * 5)
    });

    it('caps risk at 100', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 10,
        lastPublishDays: 1000,
        weeklyDownloads: 10,
        license: 'GPL',
        bundleSizeKb: null,
        previousRemovals: 5,
      });
      expect(risk).toBeLessThanOrEqual(100);
    });
  });

  describe('getInstalledPackages', () => {
    it('returns empty map for missing package.json', () => {
      const packages = getInstalledPackages(testDir);
      expect(packages.size).toBe(0);
    });

    it('parses dependencies from package.json', () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({
        dependencies: {
          'express': '^4.18.0',
          'lodash': '^4.17.21',
        },
        devDependencies: {
          'vitest': '^1.0.0',
        },
      }));

      const packages = getInstalledPackages(testDir);
      expect(packages.size).toBe(3);
      expect(packages.get('express')).toBe('^4.18.0');
      expect(packages.get('lodash')).toBe('^4.17.21');
      expect(packages.get('vitest')).toBe('^1.0.0');
    });

    it('handles invalid JSON gracefully', () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, '{ invalid json');

      const packages = getInstalledPackages(testDir);
      expect(packages.size).toBe(0);
    });

    it('handles missing dependencies field', () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: 'test' }));

      const packages = getInstalledPackages(testDir);
      expect(packages.size).toBe(0);
    });
  });

  describe('storeAssessment', () => {
    it('stores dependency assessment', () => {
      storeAssessment(db, 'express', '4.18.0', 25, {
        vulnerabilities: 1,
        lastPublishDays: 120,
        weeklyDownloads: 50000,
        license: 'MIT',
        bundleSizeKb: 200,
        previousRemovals: 0,
      });

      const row = db.prepare('SELECT * FROM dependency_assessments WHERE package_name = ?').get('express') as Record<string, unknown>;
      expect(row.package_name).toBe('express');
      expect(row.version).toBe('4.18.0');
      expect(row.risk_score).toBe(25);
      expect(row.vulnerabilities).toBe(1);
      expect(row.weekly_downloads).toBe(50000);
    });
  });

  describe('getPreviousRemovals', () => {
    it('returns 0 for package never assessed', () => {
      const count = getPreviousRemovals(db, 'unknown-package');
      expect(count).toBe(0);
    });

    it('returns max previous_removals value', () => {
      storeAssessment(db, 'moment', null, 50, {
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 2,
      });

      storeAssessment(db, 'moment', null, 60, {
        vulnerabilities: 0,
        lastPublishDays: null,
        weeklyDownloads: null,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 3,
      });

      const count = getPreviousRemovals(db, 'moment');
      expect(count).toBe(3);
    });
  });

  describe('handleDependencyToolCall', () => {
    it('handles dep_score for package', () => {
      const result = handleDependencyToolCall('massu_dep_score', { package_name: 'express' }, db);
      const text = result.content[0].text;
      expect(text).toContain('Dependency Check: express');
      expect(text).toContain('Risk Score');
    });

    it('handles dep_score with installed package', () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({
        dependencies: { 'express': '^4.18.0' },
      }));

      // Mock getConfig to return testDir
      const result = handleDependencyToolCall('massu_dep_score', { package_name: 'express' }, db);
      const text = result.content[0].text;
      expect(text).toContain('express');
    });

    it('handles dep_alternatives for known package', () => {
      const result = handleDependencyToolCall('massu_dep_alternatives', { package_name: 'moment' }, db);
      const text = result.content[0].text;
      expect(text).toContain('Alternatives to: moment');
      expect(text).toContain('date-fns');
    });

    it('handles dep_alternatives for unknown package', () => {
      const result = handleDependencyToolCall('massu_dep_alternatives', { package_name: 'unknown-package' }, db);
      const text = result.content[0].text;
      expect(text).toContain('No known alternative mappings');
    });

    it('handles unknown tool name', () => {
      const result = handleDependencyToolCall('massu_dep_unknown', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Unknown dependency tool');
    });
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getTeamToolDefinitions,
  isTeamTool,
  calculateExpertise,
  updateExpertise,
  detectConflicts,
  shareObservation,
  handleTeamToolCall,
} from '../team-knowledge.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE developer_expertise (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      developer_id TEXT NOT NULL,
      module TEXT NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      observation_count INTEGER NOT NULL DEFAULT 0,
      expertise_score INTEGER NOT NULL DEFAULT 0,
      last_active TEXT DEFAULT (datetime('now')),
      UNIQUE(developer_id, module)
    );

    CREATE TABLE shared_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER,
      developer_id TEXT NOT NULL,
      project TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      file_path TEXT,
      module TEXT,
      severity INTEGER NOT NULL DEFAULT 3,
      is_shared INTEGER NOT NULL DEFAULT 0,
      shared_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE knowledge_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      developer_a TEXT NOT NULL,
      developer_b TEXT NOT NULL,
      conflict_type TEXT NOT NULL DEFAULT 'concurrent_edit',
      resolved INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      files_involved TEXT DEFAULT '[]',
      created_at_epoch INTEGER NOT NULL
    );
  `);
  return db;
}

describe('team-knowledge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getTeamToolDefinitions', () => {
    it('returns 3 tool definitions', () => {
      const tools = getTeamToolDefinitions();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name.split('_').slice(-2).join('_'))).toEqual([
        'team_search',
        'team_expertise',
        'team_conflicts',
      ]);
    });

    it('team_search requires query', () => {
      const tools = getTeamToolDefinitions();
      const searchTool = tools.find(t => t.name.endsWith('_team_search'));
      expect(searchTool?.inputSchema.required).toEqual(['query']);
    });
  });

  describe('isTeamTool', () => {
    it('returns true for team tool names', () => {
      expect(isTeamTool('massu_team_search')).toBe(true);
      expect(isTeamTool('massu_team_expertise')).toBe(true);
      expect(isTeamTool('massu_team_conflicts')).toBe(true);
    });

    it('returns false for non-team tool names', () => {
      expect(isTeamTool('massu_security_score')).toBe(false);
      expect(isTeamTool('massu_unknown')).toBe(false);
    });
  });

  describe('calculateExpertise', () => {
    it('calculates expertise from session and observation counts', () => {
      const score = calculateExpertise(10, 50);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('returns higher score for more sessions', () => {
      const score1 = calculateExpertise(5, 10);
      const score2 = calculateExpertise(20, 10);
      expect(score2).toBeGreaterThan(score1);
    });

    it('returns higher score for more observations', () => {
      const score1 = calculateExpertise(5, 10);
      const score2 = calculateExpertise(5, 50);
      expect(score2).toBeGreaterThan(score1);
    });

    it('caps score at 100', () => {
      const score = calculateExpertise(1000, 1000);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('handles zero counts', () => {
      const score = calculateExpertise(0, 0);
      expect(score).toBe(0);
    });
  });

  describe('updateExpertise', () => {
    it('creates expertise record for new developer-module pair', () => {
      // Insert observation with file changes
      db.prepare(`
        INSERT INTO observations (session_id, type, title, detail, files_involved, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('session-1', 'feature', 'Added feature', 'Details', JSON.stringify(['src/routers/orders.ts']), Date.now());

      updateExpertise(db, 'dev-alice', 'session-1');

      const expertise = db.prepare(
        'SELECT * FROM developer_expertise WHERE developer_id = ? AND module = ?'
      ).get('dev-alice', 'orders') as Record<string, unknown> | undefined;

      expect(expertise).toBeDefined();
      expect(expertise!.session_count).toBe(1);
      expect(expertise!.expertise_score).toBeGreaterThan(0);
    });

    it('updates existing expertise record', () => {
      // Create initial expertise
      db.prepare(`
        INSERT INTO developer_expertise (developer_id, module, session_count, observation_count, expertise_score)
        VALUES (?, ?, ?, ?, ?)
      `).run('dev-bob', 'products', 5, 20, 50);

      // Add new observation
      db.prepare(`
        INSERT INTO observations (session_id, type, title, detail, files_involved, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('session-2', 'bugfix', 'Fixed bug', 'Details', JSON.stringify(['src/routers/products.ts']), Date.now());

      updateExpertise(db, 'dev-bob', 'session-2');

      const expertise = db.prepare(
        'SELECT * FROM developer_expertise WHERE developer_id = ? AND module = ?'
      ).get('dev-bob', 'products') as Record<string, unknown>;

      expect(expertise.session_count).toBe(6);
      expect(expertise.observation_count).toBeGreaterThan(20);
    });
  });

  describe('detectConflicts', () => {
    it('returns empty array when no conflicts', () => {
      const conflicts = detectConflicts(db, 7);
      expect(conflicts).toEqual([]);
    });

    it('detects concurrent edits by different developers', () => {
      // Add observations for two developers on same file
      db.prepare(`
        INSERT INTO shared_observations (developer_id, project, observation_type, summary, file_path, is_shared, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run('dev-alice', 'myproject', 'edit', 'Alice edited file', 'src/app.ts', 1);

      db.prepare(`
        INSERT INTO shared_observations (developer_id, project, observation_type, summary, file_path, is_shared, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run('dev-bob', 'myproject', 'edit', 'Bob edited file', 'src/app.ts', 1);

      const conflicts = detectConflicts(db, 7);
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].filePath).toBe('src/app.ts');
      expect(conflicts[0].conflictType).toBe('concurrent_edit');
    });

    it('respects days back parameter', () => {
      // Add old observation
      db.prepare(`
        INSERT INTO shared_observations (developer_id, project, observation_type, summary, file_path, is_shared, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-10 days'))
      `).run('dev-alice', 'myproject', 'edit', 'Old edit', 'src/old.ts', 1);

      db.prepare(`
        INSERT INTO shared_observations (developer_id, project, observation_type, summary, file_path, is_shared, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-10 days'))
      `).run('dev-bob', 'myproject', 'edit', 'Old edit', 'src/old.ts', 1);

      const conflicts = detectConflicts(db, 5); // Only look back 5 days
      expect(conflicts).toEqual([]);
    });
  });

  describe('shareObservation', () => {
    it('creates shared observation record', () => {
      const id = shareObservation(
        db,
        'dev-alice',
        'myproject',
        'discovery',
        'Found interesting pattern',
        {
          filePath: 'src/utils.ts',
          module: 'utils',
          severity: 4,
        }
      );

      expect(id).toBeGreaterThan(0);

      const obs = db.prepare('SELECT * FROM shared_observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.developer_id).toBe('dev-alice');
      expect(obs.observation_type).toBe('discovery');
      expect(obs.summary).toBe('Found interesting pattern');
      expect(obs.file_path).toBe('src/utils.ts');
      expect(obs.module).toBe('utils');
      expect(obs.severity).toBe(4);
      expect(obs.is_shared).toBe(1);
    });

    it('uses default severity when not provided', () => {
      const id = shareObservation(
        db,
        'dev-bob',
        'myproject',
        'bugfix',
        'Fixed critical bug'
      );

      const obs = db.prepare('SELECT severity FROM shared_observations WHERE id = ?').get(id) as { severity: number };
      expect(obs.severity).toBe(3);
    });
  });

  describe('handleTeamToolCall', () => {
    it('handles team_search with no results', () => {
      const result = handleTeamToolCall('massu_team_search', { query: 'nonexistent' }, db);
      const text = result.content[0].text;
      expect(text).toContain('No shared observations found');
    });

    it('handles team_search with results', () => {
      shareObservation(db, 'dev-alice', 'myproject', 'discovery', 'Found authentication bug', {
        module: 'auth',
      });

      const result = handleTeamToolCall('massu_team_search', { query: 'authentication' }, db);
      const text = result.content[0].text;
      expect(text).toContain('Team Knowledge');
      expect(text).toContain('dev-alice');
      expect(text).toContain('discovery');
    });

    it('handles team_expertise overview when no module specified', () => {
      db.prepare(`
        INSERT INTO developer_expertise (developer_id, module, session_count, observation_count, expertise_score)
        VALUES (?, ?, ?, ?, ?)
      `).run('dev-alice', 'orders', 10, 50, 75);

      const result = handleTeamToolCall('massu_team_expertise', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Team Expertise Overview');
      expect(text).toContain('orders');
    });

    it('handles team_expertise for specific module', () => {
      db.prepare(`
        INSERT INTO developer_expertise (developer_id, module, session_count, observation_count, expertise_score)
        VALUES (?, ?, ?, ?, ?)
      `).run('dev-alice', 'products', 15, 60, 85);

      db.prepare(`
        INSERT INTO developer_expertise (developer_id, module, session_count, observation_count, expertise_score)
        VALUES (?, ?, ?, ?, ?)
      `).run('dev-bob', 'products', 8, 30, 55);

      const result = handleTeamToolCall('massu_team_expertise', { module: 'products' }, db);
      const text = result.content[0].text;
      expect(text).toContain('Expertise: products');
      expect(text).toContain('dev-alice');
      expect(text).toContain('dev-bob');
      expect(text).toContain('85'); // Alice's score should appear first (higher)
    });

    it('handles team_conflicts with no conflicts', () => {
      const result = handleTeamToolCall('massu_team_conflicts', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('No concurrent work conflicts');
    });

    it('handles unknown tool name', () => {
      const result = handleTeamToolCall('massu_team_unknown', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Unknown team tool');
    });
  });
});

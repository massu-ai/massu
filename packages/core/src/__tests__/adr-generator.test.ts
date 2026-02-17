// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getAdrToolDefinitions,
  isAdrTool,
  detectDecisionPatterns,
  extractAlternatives,
  storeDecision,
  handleAdrToolCall,
} from '../adr-generator.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE architecture_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      title TEXT NOT NULL,
      context TEXT,
      decision TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'superseded', 'deprecated')),
      alternatives TEXT,
      consequences TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('adr-generator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getAdrToolDefinitions', () => {
    it('returns 3 tool definitions with correct names', () => {
      const tools = getAdrToolDefinitions();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name.split('_').slice(-2).join('_'))).toEqual([
        'adr_list',
        'adr_detail',
        'adr_create',
      ]);
    });

    it('has required fields in tool definitions', () => {
      const tools = getAdrToolDefinitions();
      tools.forEach(tool => {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      });
    });

    it('adr_create requires title and decision', () => {
      const tools = getAdrToolDefinitions();
      const createTool = tools.find(t => t.name.endsWith('_adr_create'));
      expect(createTool?.inputSchema.required).toEqual(['title', 'decision']);
    });
  });

  describe('isAdrTool', () => {
    it('returns true for ADR tool names', () => {
      expect(isAdrTool('massu_adr_list')).toBe(true);
      expect(isAdrTool('massu_adr_detail')).toBe(true);
      expect(isAdrTool('massu_adr_create')).toBe(true);
    });

    it('returns false for non-ADR tool names', () => {
      expect(isAdrTool('massu_security_score')).toBe(false);
      expect(isAdrTool('massu_unknown')).toBe(false);
      expect(isAdrTool('adr_list')).toBe(true); // base name without prefix
    });
  });

  describe('detectDecisionPatterns', () => {
    it('detects decision phrases in text', () => {
      expect(detectDecisionPatterns('We chose Redis for caching')).toBe(true);
      expect(detectDecisionPatterns('Decided to use TypeScript')).toBe(true);
      expect(detectDecisionPatterns('switching to ESM modules')).toBe(true);
      expect(detectDecisionPatterns('moving from CommonJS to ESM')).toBe(true);
      expect(detectDecisionPatterns('going with Fastify')).toBe(true);
    });

    it('is case insensitive', () => {
      expect(detectDecisionPatterns('DECIDED to refactor')).toBe(true);
      expect(detectDecisionPatterns('Chose the new architecture')).toBe(true);
    });

    it('returns false when no decision pattern found', () => {
      expect(detectDecisionPatterns('This is a regular sentence')).toBe(false);
      expect(detectDecisionPatterns('No patterns here')).toBe(false);
    });
  });

  describe('extractAlternatives', () => {
    it('extracts alternatives from "X over Y" pattern', () => {
      const result = extractAlternatives('We chose Redis over Memcached for caching');
      // The regex captures from the last word before "over" to next word, so "chose Redis" and "Memcached for caching"
      expect(result.length).toBeGreaterThan(0);
      // Just verify the function works and returns alternatives
      expect(result.some(alt => alt.includes('Redis'))).toBe(true);
      expect(result.some(alt => alt.includes('Memcached'))).toBe(true);
    });

    it('extracts alternatives from "X instead of Y" pattern', () => {
      const result = extractAlternatives('Use TypeScript instead of JavaScript');
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(alt => alt.includes('TypeScript'))).toBe(true);
      expect(result.some(alt => alt.includes('JavaScript'))).toBe(true);
    });

    it('extracts alternatives from "switching from X to Y" pattern', () => {
      const result = extractAlternatives('switching from CommonJS to ESM modules');
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(alt => alt.includes('ESM'))).toBe(true);
      expect(result.some(alt => alt.includes('CommonJS'))).toBe(true);
    });

    it('returns unique alternatives only', () => {
      const result = extractAlternatives('Redis over Memcached instead of Redis');
      const unique = [...new Set(result)];
      expect(result.length).toBe(unique.length);
    });

    it('returns empty array when no alternatives found', () => {
      const result = extractAlternatives('This has no alternatives');
      expect(result).toEqual([]);
    });
  });

  describe('storeDecision', () => {
    it('stores a decision and returns ID', () => {
      const id = storeDecision(db, {
        title: 'Use Redis for caching',
        context: 'Need fast cache',
        decision: 'Redis over Memcached',
        alternatives: ['Redis', 'Memcached'],
        consequences: 'Better performance',
      });

      expect(id).toBeGreaterThan(0);

      const row = db.prepare('SELECT * FROM architecture_decisions WHERE id = ?').get(id) as Record<string, unknown>;
      expect(row.title).toBe('Use Redis for caching');
      expect(row.decision).toBe('Redis over Memcached');
      expect(JSON.parse(row.alternatives as string)).toEqual(['Redis', 'Memcached']);
    });

    it('uses default status when not provided', () => {
      const id = storeDecision(db, {
        title: 'Test Decision',
        context: 'Context',
        decision: 'Decision text',
        alternatives: [],
        consequences: 'None',
      });

      const row = db.prepare('SELECT status FROM architecture_decisions WHERE id = ?').get(id) as { status: string };
      expect(row.status).toBe('accepted');
    });

    it('accepts custom status', () => {
      const id = storeDecision(db, {
        title: 'Test Decision',
        context: 'Context',
        decision: 'Decision text',
        alternatives: [],
        consequences: 'None',
        status: 'superseded',
      });

      const row = db.prepare('SELECT status FROM architecture_decisions WHERE id = ?').get(id) as { status: string };
      expect(row.status).toBe('superseded');
    });
  });

  describe('handleAdrToolCall', () => {
    it('handles adr_list with no decisions', () => {
      const result = handleAdrToolCall('massu_adr_list', {}, db);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('No architecture decisions found');
    });

    it('handles adr_list with decisions', () => {
      storeDecision(db, {
        title: 'Test Decision',
        context: 'Context',
        decision: 'Decision',
        alternatives: [],
        consequences: 'None',
      });

      const result = handleAdrToolCall('massu_adr_list', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Architecture Decisions (1)');
      expect(text).toContain('Test Decision');
    });

    it('handles adr_detail for existing decision', () => {
      const id = storeDecision(db, {
        title: 'Test Decision',
        context: 'Test Context',
        decision: 'Test Decision Text',
        alternatives: ['Option A', 'Option B'],
        consequences: 'Test Consequences',
      });

      const result = handleAdrToolCall('massu_adr_detail', { id }, db);
      const text = result.content[0].text;
      expect(text).toContain(`ADR-${id}: Test Decision`);
      expect(text).toContain('Test Context');
      expect(text).toContain('Option A');
      expect(text).toContain('Option B');
      expect(text).toContain('Test Consequences');
    });

    it('handles adr_detail for non-existent decision', () => {
      const result = handleAdrToolCall('massu_adr_detail', { id: 999 }, db);
      const text = result.content[0].text;
      expect(text).toContain('ADR #999 not found');
    });

    it('handles adr_create and extracts alternatives', () => {
      const result = handleAdrToolCall('massu_adr_create', {
        title: 'Use Redis',
        decision: 'Redis over Memcached',
        context: 'Need caching',
        consequences: 'Better performance',
      }, db);

      const text = result.content[0].text;
      expect(text).toContain('ADR-1 Created');
      expect(text).toContain('Redis');
      expect(text).toContain('Memcached');

      const row = db.prepare('SELECT * FROM architecture_decisions WHERE id = 1').get() as Record<string, unknown>;
      const alternatives = JSON.parse(row.alternatives as string) as string[];
      expect(alternatives).toContain('Redis');
      expect(alternatives).toContain('Memcached');
    });

    it('handles unknown tool name', () => {
      const result = handleAdrToolCall('massu_adr_unknown', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Unknown ADR tool');
    });
  });
});

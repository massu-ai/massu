// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getCostToolDefinitions,
  isCostTool,
  extractTokenUsage,
  calculateCost,
  storeSessionCost,
  backfillSessionCosts,
  handleCostToolCall,
  type TokenUsage,
  type CostResult,
} from '../cost-tracker.ts';
import type { TranscriptEntry } from '../transcript-parser.ts';

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

    CREATE TABLE session_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE feature_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

describe('cost-tracker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getCostToolDefinitions', () => {
    it('should return tool definitions for cost tools', () => {
      const defs = getCostToolDefinitions();
      expect(defs.length).toBe(3);

      const names = defs.map(d => d.name);
      expect(names.some(n => n.includes('cost_session'))).toBe(true);
      expect(names.some(n => n.includes('cost_trend'))).toBe(true);
      expect(names.some(n => n.includes('cost_feature'))).toBe(true);

      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeTruthy();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('isCostTool', () => {
    it('should return true for cost tools', () => {
      expect(isCostTool('massu_cost_session')).toBe(true);
      expect(isCostTool('massu_cost_trend')).toBe(true);
      expect(isCostTool('massu_cost_feature')).toBe(true);
    });

    it('should return false for non-cost tools', () => {
      expect(isCostTool('massu_quality_score')).toBe(false);
      expect(isCostTool('massu_audit_log')).toBe(false);
      expect(isCostTool('random_tool')).toBe(false);
    });

    it('should handle base names without prefix', () => {
      expect(isCostTool('cost_session')).toBe(true);
      expect(isCostTool('cost_trend')).toBe(true);
    });
  });

  describe('extractTokenUsage', () => {
    it('should extract token usage from transcript entries', () => {
      const entries: TranscriptEntry[] = [
        {
          type: 'assistant',
          message: {
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
            },
            model: 'claude-sonnet-4-5',
          } as Record<string, unknown>,
        } as TranscriptEntry,
        {
          type: 'assistant',
          message: {
            usage: {
              input_tokens: 800,
              output_tokens: 400,
              cache_read_tokens: 50,
              cache_write_tokens: 25,
            },
            model: 'claude-sonnet-4-5',
          } as Record<string, unknown>,
        } as TranscriptEntry,
      ];

      const usage = extractTokenUsage(entries);
      expect(usage.inputTokens).toBe(1800);
      expect(usage.outputTokens).toBe(900);
      expect(usage.cacheReadTokens).toBe(250);
      expect(usage.cacheWriteTokens).toBe(125);
      expect(usage.model).toBe('claude-sonnet-4-5');
    });

    it('should return zero tokens for empty entries', () => {
      const usage = extractTokenUsage([]);
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
      expect(usage.cacheReadTokens).toBe(0);
      expect(usage.cacheWriteTokens).toBe(0);
      expect(usage.model).toBe('unknown');
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost from token usage', () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000,
        cacheWriteTokens: 100_000,
        model: 'claude-sonnet-4-5',
      };

      const cost = calculateCost(usage);

      expect(cost.totalCost).toBeGreaterThan(0);
      expect(cost.inputCost).toBeGreaterThan(0);
      expect(cost.outputCost).toBeGreaterThan(0);
      // Cache costs may be 0 if pricing doesn't include cache_read/write rates
      expect(cost.cacheReadCost).toBeGreaterThanOrEqual(0);
      expect(cost.cacheWriteCost).toBeGreaterThanOrEqual(0);
      expect(cost.currency).toBe('USD');
      expect(cost.totalCost).toBe(
        cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost
      );
    });

    it('should use default pricing for unknown models', () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'unknown-model',
      };

      const cost = calculateCost(usage);
      expect(cost.totalCost).toBeGreaterThan(0);
    });

    it('should handle zero tokens', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'claude-sonnet-4-5',
      };

      const cost = calculateCost(usage);
      expect(cost.totalCost).toBe(0);
      expect(cost.inputCost).toBe(0);
      expect(cost.outputCost).toBe(0);
    });
  });

  describe('storeSessionCost', () => {
    it('should store session cost in database', () => {
      const sessionId = 'test-session-1';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        model: 'claude-sonnet-4-5',
      };

      const cost: CostResult = {
        totalCost: 0.015,
        inputCost: 0.003,
        outputCost: 0.0075,
        cacheReadCost: 0.0006,
        cacheWriteCost: 0.00375,
        currency: 'USD',
      };

      storeSessionCost(db, sessionId, usage, cost);

      const stored = db.prepare('SELECT * FROM session_costs WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
      expect(stored).toBeDefined();
      expect(stored.session_id).toBe(sessionId);
      expect(stored.model).toBe('claude-sonnet-4-5');
      expect(stored.input_tokens).toBe(1000);
      expect(stored.output_tokens).toBe(500);
      expect(stored.cache_read_tokens).toBe(200);
      expect(stored.cache_write_tokens).toBe(100);
      expect(stored.total_tokens).toBe(1800);
      expect(stored.estimated_cost_usd).toBe(0.015);
    });
  });

  describe('backfillSessionCosts', () => {
    it('should return count of sessions without cost data', () => {
      const sessions = ['session-1', 'session-2', 'session-3'];
      for (const sid of sessions) {
        db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
          sid,
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
      }

      const count = backfillSessionCosts(db);
      expect(count).toBe(3);
    });

    it('should not count sessions that already have cost data', () => {
      const sessionId = 'session-with-cost';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'claude-sonnet-4-5',
      };

      const cost: CostResult = {
        totalCost: 0.001,
        inputCost: 0.0003,
        outputCost: 0.00075,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        currency: 'USD',
      };

      storeSessionCost(db, sessionId, usage, cost);

      const count = backfillSessionCosts(db);
      expect(count).toBe(0);
    });
  });

  describe('handleCostToolCall', () => {
    it('should handle cost_session tool call', () => {
      const sessionId = 'test-session-2';
      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        model: 'claude-sonnet-4-5',
      };

      const cost: CostResult = {
        totalCost: 0.01,
        inputCost: 0.003,
        outputCost: 0.0075,
        cacheReadCost: 0.0003,
        cacheWriteCost: 0.0001875,
        currency: 'USD',
      };

      storeSessionCost(db, sessionId, usage, cost);

      const result = handleCostToolCall('massu_cost_session', { session_id: sessionId }, db);

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Session Cost');
      expect(text).toContain('Token Usage');
    });

    it('should return error for missing session_id', () => {
      const result = handleCostToolCall('massu_cost_session', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Usage');
    });

    it('should handle unknown tool name', () => {
      const result = handleCostToolCall('massu_unknown_cost_tool', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Unknown cost tool');
    });
  });
});

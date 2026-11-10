// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getCostToolDefinitions,
  isCostTool,
  costTranscriptEntries,
  storeSessionCost,
  markSessionCostUnknown,
  backfillSessionCosts,
  handleCostToolCall,
  type SessionCostSlice,
} from '../cost-tracker.ts';
import { PRICING_VERSION } from '../model-pricing.ts';
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
      created_at TEXT DEFAULT (datetime('now')),
      cost_status TEXT NOT NULL DEFAULT 'unknown',
      unpriced_models TEXT NOT NULL DEFAULT '',
      priced_responses INTEGER NOT NULL DEFAULT 0,
      unpriced_responses INTEGER NOT NULL DEFAULT 0,
      pricing_version INTEGER NOT NULL DEFAULT 0
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

function slice(over: Partial<SessionCostSlice> = {}): SessionCostSlice {
  return {
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, costUsd: 0.015,
    pricedResponses: 1, unpricedResponses: 0, unpricedModels: [], model: 'claude-sonnet-4-5',
    lastMessageId: 'msg_1', ...over,
  };
}

const response = (id: string, model: string, usage: Record<string, unknown>): TranscriptEntry =>
  ({ type: 'assistant', message: { role: 'assistant', content: [], id, model, usage } }) as unknown as TranscriptEntry;

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

  describe('costTranscriptEntries prices each response at its own model', () => {
    it('Opus 5.5 with a 1-hour cache write: exact published rates', () => {
      const out = costTranscriptEntries([
        response('m1', 'claude-opus-5-5', {
          input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 1_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
        }),
      ]);
      // $4 input + $2 output (0.1M x $20) + $0.20 cache read + $8 1h write
      expect(out.costUsd).toBeCloseTo(14.2, 6);
      expect(out.pricedResponses).toBe(1);
      expect(out.cacheWriteTokens).toBe(1_000_000);
    });

    it('counts a response once although the transcript repeats it on several lines', () => {
      const u = { input_tokens: 1_000_000, output_tokens: 0 };
      const out = costTranscriptEntries([
        response('dup', 'claude-sonnet-4-6', u),
        response('dup', 'claude-sonnet-4-6', u),
        response('dup', 'claude-sonnet-4-6', u),
      ]);
      expect(out.inputTokens).toBe(1_000_000);
      expect(out.costUsd).toBeCloseTo(3, 6);
    });

    it('skips the last response of the previous slice (a run can end between its lines)', () => {
      const out = costTranscriptEntries([response('prev', 'claude-sonnet-4-6', { input_tokens: 5 })], { skipMessageId: 'prev' });
      expect(out.inputTokens).toBe(0);
    });

    it('fast mode, US-only routing and a dated id', () => {
      const fast = costTranscriptEntries([response('f', 'claude-opus-5-5', { input_tokens: 1_000_000, speed: 'fast' })]);
      expect(fast.costUsd).toBeCloseTo(8, 6);
      const us = costTranscriptEntries([response('u', 'claude-opus-5-5', { input_tokens: 1_000_000, inference_geo: 'us' })]);
      expect(us.costUsd).toBeCloseTo(4.4, 6);
      const dated = costTranscriptEntries([response('d', 'claude-sonnet-4-5-20250929', { input_tokens: 1_000_000 })]);
      expect(dated.costUsd).toBeCloseTo(3, 6);
    });

    it('Haiku 5.5 over 100K prompt tokens pays the higher rates', () => {
      const out = costTranscriptEntries([response('h', 'claude-haiku-5-5', { input_tokens: 150_000 })]);
      expect(out.costUsd).toBeCloseTo(0.075, 9); // 0.15M x $0.50, not x $0.10
    });

    it('an unknown model is UNPRICED, never priced at a guessed default', () => {
      const out = costTranscriptEntries([
        response('k', 'claude-sonnet-4-6', { input_tokens: 1_000_000 }),
        response('x', 'some-future-model', { input_tokens: 1_000_000 }),
      ]);
      expect(out.costUsd).toBeCloseTo(3, 6);
      expect(out.unpricedResponses).toBe(1);
      expect(out.unpricedModels).toEqual(['some-future-model']);
    });

    it('a zero-token entry (Claude Code\'s "<synthetic>") is free, not unpriced', () => {
      const out = costTranscriptEntries([response('s', '<synthetic>', { input_tokens: 0, output_tokens: 0 })]);
      expect(out).toMatchObject({ unpricedResponses: 0, unpricedModels: [], costUsd: 0 });
    });

    it('no responses: zero, and nothing unpriced', () => {
      expect(costTranscriptEntries([])).toMatchObject({ costUsd: 0, pricedResponses: 0, unpricedResponses: 0, model: '' });
    });
  });

  describe('storeSessionCost', () => {
    it('stores one row, stamped with the pricing version, and accumulates on add', () => {
      storeSessionCost(db, 's1', slice(), 'replace');
      storeSessionCost(db, 's1', slice({ unpricedResponses: 1, unpricedModels: ['m-x'] }), 'add');
      const rows = db.prepare('SELECT * FROM session_costs WHERE session_id = ?').all('s1') as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        input_tokens: 2000, output_tokens: 1000, total_tokens: 3600, cost_status: 'partial',
        unpriced_models: 'm-x', priced_responses: 2, unpriced_responses: 1, pricing_version: PRICING_VERSION,
      });
      expect(rows[0].estimated_cost_usd as number).toBeCloseTo(0.03, 9);
    });

    it('markSessionCostUnknown records unknown, not $0 that reads as measured', () => {
      storeSessionCost(db, 's2', slice());
      markSessionCostUnknown(db, 's2');
      expect(db.prepare('SELECT cost_status, total_tokens FROM session_costs').get()).toEqual({ cost_status: 'unknown', total_tokens: 0 });
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

      storeSessionCost(db, sessionId, slice());

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

      storeSessionCost(db, sessionId, slice());

      const result = handleCostToolCall('massu_cost_session', { session_id: sessionId }, db);

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Session Cost: $0.0150');
      expect(text).toContain('Token Usage');

      markSessionCostUnknown(db, sessionId);
      const unknown = handleCostToolCall('massu_cost_session', { session_id: sessionId }, db).content[0].text;
      expect(unknown).toContain('Session Cost: unknown');
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

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-E-014 (plan-stage-e-low-info-sweep, wave1-hooks:F-HOOK-009) —
 * tool_cost_events 90-day retention drift-guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initMemorySchema,
  pruneToolCostEvents,
  TOOL_COST_EVENTS_RETENTION_DAYS,
} from '../memory-db.ts';

describe('P-E-014: tool_cost_events retention', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initMemorySchema(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('deletes rows older than 90 days', () => {
    // Insert one ancient row, one recent row.
    db.prepare(
      `INSERT INTO tool_cost_events
       (session_id, tool_name, estimated_input_tokens, estimated_output_tokens, model, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-100 days'))`
    ).run('s1', 't1', 100, 200, 'claude');

    db.prepare(
      `INSERT INTO tool_cost_events
       (session_id, tool_name, estimated_input_tokens, estimated_output_tokens, model, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-10 days'))`
    ).run('s2', 't2', 100, 200, 'claude');

    const beforeCount = db.prepare('SELECT COUNT(*) as n FROM tool_cost_events').get() as {
      n: number;
    };
    expect(beforeCount.n).toBe(2);

    const deleted = pruneToolCostEvents(db);
    expect(deleted).toBe(1);

    const afterCount = db.prepare('SELECT COUNT(*) as n FROM tool_cost_events').get() as {
      n: number;
    };
    expect(afterCount.n).toBe(1);

    const remaining = db.prepare('SELECT session_id FROM tool_cost_events').get() as {
      session_id: string;
    };
    expect(remaining.session_id).toBe('s2');
  });

  it('preserves rows at the exact retention boundary', () => {
    // Row exactly 89 days old should survive (within 90-day window).
    db.prepare(
      `INSERT INTO tool_cost_events
       (session_id, tool_name, estimated_input_tokens, estimated_output_tokens, model, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-89 days'))`
    ).run('s1', 't1', 100, 200, 'claude');

    const deleted = pruneToolCostEvents(db);
    expect(deleted).toBe(0);

    const count = db.prepare('SELECT COUNT(*) as n FROM tool_cost_events').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('returns 0 when no rows exist', () => {
    const deleted = pruneToolCostEvents(db);
    expect(deleted).toBe(0);
  });

  it('retention constant is 90 days', () => {
    expect(TOOL_COST_EVENTS_RETENTION_DAYS).toBe(90);
  });
});

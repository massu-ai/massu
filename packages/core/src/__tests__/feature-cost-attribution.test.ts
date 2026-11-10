// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * massu_cost_feature reads feature_costs, which NOTHING wrote until 2026-11-09, so it always
 * answered "no data". feature-cost-attribution.ts now allocates each session's priced cost
 * across the registered features whose files it touched. These cases pin the allocation rules
 * and run the writer against the REAL memory and data schemas (initMemorySchema /
 * initDataSchema), not a hand-copied table.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession } from '../memory-db.ts';
import { initDataSchema } from '../db.ts';
import { upsertFeature, linkComponent } from '../sentinel-db.ts';
import { allocateSessionCost, attributeSessionCost, sessionFileTouches, UNATTRIBUTED_FEATURE, MAX_SESSION_FILES } from '../feature-cost-attribution.ts';
import { handleCostToolCall } from '../cost-tracker.ts';

const ROOT = '/repo';
const sum = (rows: Array<{ costUsd: number }>) => rows.reduce((a, r) => a + r.costUsd, 0);

describe('allocateSessionCost', () => {
  it('splits by touches, a shared file evenly, and the rest to UNATTRIBUTED — summing to the total', () => {
    const touches = new Map([['a.ts', 2], ['shared.ts', 2], ['readme.md', 4]]);
    const featuresOf = (f: string) => (f === 'a.ts' ? ['A'] : f === 'shared.ts' ? ['A', 'B'] : []);
    const rows = allocateSessionCost(touches, featuresOf, { tokens: 800, costUsd: 8 });
    const by = Object.fromEntries(rows.map((r) => [r.featureKey, r.costUsd]));
    expect(by).toEqual({ A: 3, B: 1, [UNATTRIBUTED_FEATURE]: 4 });
    expect(sum(rows)).toBeCloseTo(8, 12);
  });

  it('no recorded touches: the whole cost is unattributed (never dropped)', () => {
    expect(allocateSessionCost(new Map(), () => [], { tokens: 10, costUsd: 2 }))
      .toEqual([{ featureKey: UNATTRIBUTED_FEATURE, share: 1, tokens: 10, costUsd: 2 }]);
  });
});

function dbs() {
  const mem = new Database(':memory:');
  mem.pragma('foreign_keys = ON');
  initMemorySchema(mem);
  const data = new Database(':memory:');
  initDataSchema(data);
  const id = upsertFeature(data, {
    feature_key: 'billing', domain: 'app', subdomain: 'pay', title: 'Billing', description: 'x',
    status: 'active', priority: 'standard', portal_scope: ['internal'],
  });
  linkComponent(data, id, 'src/billing.ts', null);
  createSession(mem, 's1');
  const call = mem.prepare(
    `INSERT INTO tool_call_details (session_id, turn_number, tool_name, files_involved) VALUES ('s1', 1, 'Edit', ?)`,
  );
  call.run(JSON.stringify(['/repo/src/billing.ts']));
  call.run(JSON.stringify(['/repo/src/billing.ts', '/home/me/.claude/projects/x/memory/m.md']));
  return { mem, data };
}

describe('attributeSessionCost (real schemas)', () => {
  it('writes feature_costs rows that sum to the session cost, and the tool reports them as an allocation', () => {
    const { mem, data } = dbs();
    mem.prepare(`INSERT INTO session_costs (session_id, total_tokens, estimated_cost_usd, cost_status) VALUES ('s1', 300, 3, 'priced')`).run();
    expect(sessionFileTouches(mem, 's1', ROOT)).toEqual(new Map([['src/billing.ts', 2], ['/home/me/.claude/projects/x/memory/m.md', 1]]));
    const rows = attributeSessionCost(mem, data, 's1', ROOT);
    expect(rows.map((r) => [r.featureKey, r.costUsd])).toEqual([['billing', 2], [UNATTRIBUTED_FEATURE, 1]]);
    const stored = mem.prepare('SELECT feature_key, estimated_cost_usd c FROM feature_costs ORDER BY c DESC').all();
    expect(stored).toEqual([{ feature_key: 'billing', c: 2 }, { feature_key: UNATTRIBUTED_FEATURE, c: 1 }]);
    const out = handleCostToolCall('massu_cost_feature', { days: 30 }, mem).content[0].text;
    expect(out).toContain('billing');
    expect(out).toContain('ALLOCATED');
  });

  it('re-running replaces the rows (derived data, never accumulated)', () => {
    const { mem, data } = dbs();
    mem.prepare(`INSERT INTO session_costs (session_id, total_tokens, estimated_cost_usd, cost_status) VALUES ('s1', 300, 3, 'priced')`).run();
    attributeSessionCost(mem, data, 's1', ROOT);
    attributeSessionCost(mem, data, 's1', ROOT);
    expect(mem.prepare('SELECT COUNT(*) n, SUM(estimated_cost_usd) c FROM feature_costs').get()).toEqual({ n: 2, c: 3 });
  });

  it('a session with UNKNOWN cost gets no feature rows', () => {
    const { mem, data } = dbs();
    mem.prepare(`INSERT INTO session_costs (session_id, cost_status) VALUES ('s1', 'unknown')`).run();
    expect(attributeSessionCost(mem, data, 's1', ROOT)).toEqual([]);
    expect(mem.prepare('SELECT COUNT(*) n FROM feature_costs').get()).toEqual({ n: 0 });
  });
});

describe('sessionFileTouches is bounded and never truncates', () => {
  it('counts each file across calls, skipping malformed and non-array rows', () => {
    const { mem } = dbs();
    const call = mem.prepare(
      `INSERT INTO tool_call_details (session_id, turn_number, tool_name, files_involved) VALUES ('s1', 2, 'Edit', ?)`,
    );
    call.run('not json');
    call.run(JSON.stringify({ file: '/repo/src/billing.ts' }));
    call.run(JSON.stringify([7, '']));
    const t = sessionFileTouches(mem, 's1', '/repo');
    expect(t.get('src/billing.ts')).toBe(2);
    expect(t.size).toBe(2);
  });

  it('past MAX_SESSION_FILES distinct files it refuses rather than allocating a partial list', () => {
    const { mem } = dbs();
    const files = Array.from({ length: MAX_SESSION_FILES }, (_, i) => `/repo/gen/f${i}.ts`);
    mem.prepare(
      `INSERT INTO tool_call_details (session_id, turn_number, tool_name, files_involved) VALUES ('s1', 3, 'Edit', ?)`,
    ).run(JSON.stringify(files));
    // Already 2 distinct files from the fixture, so this is MAX + 2.
    expect(() => sessionFileTouches(mem, 's1', '/repo')).toThrow(/more than/);
  });
});

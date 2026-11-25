// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-001 (plan-living-memory-slice-1) — drift-guard: the startup prune in
 * server.ts MUST call pruneToolCostEvents. Before this slice the retention
 * routine had zero production callers, so tool_cost_events grew unbounded.
 * This test locks the wiring so it cannot silently regress to orphaned.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf-8');
// Since plan 2026-07-23 P8-004 the retention pass is ONE function in memory-retention.ts, called at startup and at
// session end. The property this guard protects is unchanged: tool-cost pruning is reached from production.
const retentionSrc = readFileSync(resolve(__dirname, '..', 'memory-retention.ts'), 'utf-8');

describe('P4-001: server startup prune wires pruneToolCostEvents', () => {
  it('the retention pass imports pruneToolCostEvents from memory-db', () => {
    expect(retentionSrc).toMatch(/import\s*\{[^}]*pruneToolCostEvents[^}]*\}\s*from\s*'\.\/memory-db\.ts'/);
  });

  it('calls pruneToolCostEvents inside runMemoryRetention', () => {
    const fnStart = retentionSrc.indexOf('export function runMemoryRetention');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = retentionSrc.indexOf('\n}\n', fnStart);
    const body = retentionSrc.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
    expect(body).toMatch(/pruneToolCostEvents\(\s*db\s*\)/);
  });

  it('server startup (pruneMemoryOnStartup) calls the retention pass', () => {
    const fnStart = serverSrc.indexOf('function pruneMemoryOnStartup');
    expect(fnStart).toBeGreaterThan(-1);
    const invocation = serverSrc.indexOf('pruneMemoryOnStartup();', fnStart);
    const body = serverSrc.slice(fnStart, invocation > -1 ? invocation : undefined);
    expect(body).toMatch(/runMemoryRetention\(\s*memDb\s*\)/);
  });
});

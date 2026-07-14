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

describe('P4-001: server startup prune wires pruneToolCostEvents', () => {
  it('imports pruneToolCostEvents from memory-db', () => {
    expect(serverSrc).toMatch(/import\s*\{[^}]*pruneToolCostEvents[^}]*\}\s*from\s*'\.\/memory-db\.ts'/);
  });

  it('calls pruneToolCostEvents inside pruneMemoryOnStartup', () => {
    const fnStart = serverSrc.indexOf('function pruneMemoryOnStartup');
    expect(fnStart).toBeGreaterThan(-1);
    // Scope the search to the function body (up to the top-level invocation).
    const invocation = serverSrc.indexOf('pruneMemoryOnStartup();', fnStart);
    const body = serverSrc.slice(fnStart, invocation > -1 ? invocation : undefined);
    expect(body).toMatch(/pruneToolCostEvents\(\s*memDb\s*\)/);
  });
});

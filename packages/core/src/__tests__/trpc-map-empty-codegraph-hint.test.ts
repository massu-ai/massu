// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H009 (plan-stage-c-high-batch) drift-guard DG-4.
 *
 * Closes the bug-class where `trpc_map` declared only `['data']` in
 * TOOL_DB_NEEDS, missing `'codegraph'`. On fresh installs without a built
 * codegraph index, `buildTrpcIndex` never ran; the tool returned silent
 * "Total procedures: 0" — the flagship code-intel tool looked broken.
 *
 * Structural fix:
 *   1. `trpc_map: ['codegraph', 'data']` in tool-db-needs.ts.
 *   2. `handleTrpcMap` emits an actionable remedy hint when 0 procedures
 *      (containing "Empty" and "massu sync") instead of bare "0".
 *
 * This test asserts the structural contract:
 *   - TOOL_DB_NEEDS declaration includes codegraph.
 *   - tools.ts handler source contains the remedy-hint strings.
 *
 * End-to-end behavior (running handleToolCall against a real codegraph)
 * is covered by the integration tests in `__tests__/server-lazy-db-deps.test.ts`
 * (toolNeedsCodegraph returns true for massu_trpc_map) and `server.test.ts`
 * (dispatcher opens BOTH dbs for trpc_map).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOL_DB_NEEDS } from '../tool-db-needs.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('trpc_map TOOL_DB_NEEDS + empty-index remedy hint (DG-4)', () => {
  it('trpc_map declares both codegraph and data dependencies in TOOL_DB_NEEDS', () => {
    const needs = (TOOL_DB_NEEDS as Record<string, readonly string[]>).trpc_map;
    expect(needs).toBeDefined();
    expect(needs).toContain('codegraph');
    expect(needs).toContain('data');
  });

  it('handleTrpcMap source contains actionable remedy hint for empty-index case', () => {
    const toolsSource = readFileSync(
      resolve(__dirname, '../tools.ts'),
      'utf-8',
    );

    // The remedy-hint block must contain a recognizable shape.
    expect(toolsSource).toContain('## tRPC Index Empty');
    expect(toolsSource).toContain('npx massu sync');
    // Guard against regression: the bare "Total procedures: 0" output should
    // be gated behind a non-empty check, not fall through unconditionally.
    expect(toolsSource).toMatch(/if\s*\(\s*total\.count\s*===\s*0\s*\)/);
  });

  it('TOOL_DB_NEEDS comment documents the P-H009 rationale', () => {
    const manifestSource = readFileSync(
      resolve(__dirname, '../tool-db-needs.ts'),
      'utf-8',
    );
    // CR-46: the structural fix MUST self-document the bug class it closes.
    expect(manifestSource).toContain('P-H009');
    expect(manifestSource).toMatch(/codegraph.*trpc/i);
  });
});

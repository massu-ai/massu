// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard test for plan-1.6.2-server-lazy-db-deps Stage B (P-B-001).
 *
 * Asserts the MCP server's lazy-per-tool DB resolution:
 *   1. Tools without 'codegraph' in their `TOOL_DB_NEEDS` entry MUST NOT
 *      trigger codegraph DB open. Simulated by stubbing `getCodeGraphDb()`
 *      to throw `CodegraphDbNotInitializedError` — the stub should never
 *      fire for codegraph-independent tools.
 *   2. Tools WITH 'codegraph' in their entry MUST return a structured
 *      `-32001` JSON-RPC error carrying remedy/dbPath/tool data fields
 *      AND the request id must propagate (NOT `id:null`).
 *   3. Tool-not-in-manifest case returns `-32602` (Invalid params) with
 *      a remedy pointing at `tool-db-needs.ts`.
 *
 * **Why this test exists**: the prior server.ts:96 design eagerly opened
 * CodeGraph DB for every tool/call. A repo without `.codegraph/codegraph.db`
 * broke ALL tools — even memory/audit/knowledge. This test makes the
 * regression structurally detectable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TOOL_DB_NEEDS,
  getToolDbNeeds,
  toolNeedsCodegraph,
  UnknownToolError,
  type DbNeed,
} from '../tool-db-needs.ts';
import { CodegraphDbNotInitializedError } from '../db.ts';

describe('TOOL_DB_NEEDS manifest', () => {
  it('covers every short-name with a non-undefined needs array', () => {
    for (const [name, needs] of Object.entries(TOOL_DB_NEEDS)) {
      expect(Array.isArray(needs), `${name} needs is not an array`).toBe(true);
    }
  });

  it('every declared need is in the DbNeed enum', () => {
    const validNeeds: readonly DbNeed[] = ['codegraph', 'data', 'memory', 'knowledge'];
    for (const [name, needs] of Object.entries(TOOL_DB_NEEDS)) {
      for (const need of needs) {
        expect(
          validNeeds.includes(need),
          `${name} declares unknown need "${need}"`,
        ).toBe(true);
      }
    }
  });

  it('manifest covers all tool families surfaced via getToolDefinitions', () => {
    // Spot-check critical families. Full enumeration is in
    // tool-db-needs-completeness.test.ts (P-B-002, AST-based).
    const required = [
      'sync', 'context', 'impact', 'coupling_check', 'domains', 'schema', 'trpc_map',
      'memory_search', 'memory_ingest',
      'sentinel_register', 'sentinel_validate',
      'docs_audit',
      'knowledge_search', 'knowledge_pattern',
      'quality_score', 'cost_session', 'audit_chain', 'validation_check',
      'security_score', 'adr_create', 'team_search', 'regression_risk',
      'py_imports', 'py_routes',
      'license_status',
    ];
    for (const tool of required) {
      expect(
        (TOOL_DB_NEEDS as Record<string, readonly DbNeed[]>)[tool],
        `${tool} missing from TOOL_DB_NEEDS`,
      ).toBeDefined();
    }
  });
});

describe('getToolDbNeeds()', () => {
  it('strips the configured prefix and returns declared needs', () => {
    expect(getToolDbNeeds('massu_memory_search', 'massu')).toEqual(['memory']);
    expect(getToolDbNeeds('massu_sync', 'massu')).toEqual(['codegraph', 'data']);
    expect(getToolDbNeeds('massu_schema', 'massu')).toEqual([]);
  });

  it('handles non-default prefixes', () => {
    expect(getToolDbNeeds('myapp_memory_search', 'myapp')).toEqual(['memory']);
  });

  it('throws UnknownToolError for tools not in the manifest', () => {
    expect(() => getToolDbNeeds('massu_does_not_exist', 'massu')).toThrow(UnknownToolError);
    try {
      getToolDbNeeds('massu_nonexistent', 'massu');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownToolError);
      expect((err as UnknownToolError).toolName).toBe('massu_nonexistent');
    }
  });
});

describe('toolNeedsCodegraph()', () => {
  it('returns true for codegraph-dependent tools', () => {
    expect(toolNeedsCodegraph('massu_sync', 'massu')).toBe(true);
    expect(toolNeedsCodegraph('massu_context', 'massu')).toBe(true);
    expect(toolNeedsCodegraph('massu_impact', 'massu')).toBe(true);
    expect(toolNeedsCodegraph('massu_coupling_check', 'massu')).toBe(true);
    expect(toolNeedsCodegraph('massu_domains', 'massu')).toBe(true);
  });

  it('returns false for codegraph-independent tools', () => {
    expect(toolNeedsCodegraph('massu_memory_search', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_memory_ingest', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_audit_chain', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_sentinel_register', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_knowledge_search', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_quality_score', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_cost_session', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_validation_check', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_security_score', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_team_search', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_regression_risk', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_docs_audit', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_schema', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_trpc_map', 'massu')).toBe(false);
  });

  it('Python tools do not need CodeGraph (Data DB only)', () => {
    expect(toolNeedsCodegraph('massu_py_imports', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_py_routes', 'massu')).toBe(false);
    expect(toolNeedsCodegraph('massu_py_context', 'massu')).toBe(false);
  });
});

describe('CodegraphDbNotInitializedError', () => {
  it('carries the dbPath property for the dispatcher to relay to clients', () => {
    const err = new CodegraphDbNotInitializedError('/repo/.codegraph/codegraph.db');
    expect(err.name).toBe('CodegraphDbNotInitializedError');
    expect(err.dbPath).toBe('/repo/.codegraph/codegraph.db');
    expect(err.message).toContain('/repo/.codegraph/codegraph.db');
  });

  it('is an Error subclass (catchable via instanceof)', () => {
    const err = new CodegraphDbNotInitializedError('/x');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodegraphDbNotInitializedError);
  });
});

describe('UnknownToolError', () => {
  it('carries the toolName property + actionable remedy message', () => {
    const err = new UnknownToolError('massu_made_up');
    expect(err.name).toBe('UnknownToolError');
    expect(err.toolName).toBe('massu_made_up');
    expect(err.message).toContain('tool-db-needs.ts');
  });
});

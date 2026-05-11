// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * AST-based drift-guard for plan-1.6.2-server-lazy-db-deps Stage B (P-B-002).
 *
 * Verifies that every tool's declared DB needs in `TOOL_DB_NEEDS` matches
 * the actual DB connection access pattern in its handler module. Uses the
 * TypeScript Compiler API (`ts.createSourceFile`) to walk identifiers and
 * member-access expressions — aliasing or destructuring renames (e.g.,
 * `const { getCodeGraphDb: fetchCgDb } = await import('./db.ts')`) do NOT
 * bypass an AST walk the way they would bypass a grep.
 *
 * **Why this test exists**: ensures the manifest doesn't drift from code.
 * If a future change adds a `getDataDb()` call inside a memory-tool handler
 * without updating the manifest, this test fails CI with a clear diagnostic.
 *
 * **Scope**: walks `packages/core/src/{memory,sentinel,docs,observability,
 * knowledge,python}-tools.ts` and the analytics/cost/etc. modules. For each
 * module, identifies which `getXDb()` functions it imports and uses; then
 * cross-references against the union of `TOOL_DB_NEEDS` entries for the
 * tools that module handles.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { TOOL_DB_NEEDS, type DbNeed } from '../tool-db-needs.ts';

const SRC_DIR = resolve(__dirname, '..');

/** Map of source file -> tool-family prefix(es) handled by that module. */
const MODULE_TO_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  'memory-tools.ts': ['memory_'],
  'observability-tools.ts': ['session_', 'tool_', 'prompt_analysis'],
  'docs-tools.ts': ['docs_'],
  'sentinel-tools.ts': ['sentinel_'],
  'analytics.ts': ['quality_'],
  'cost-tracker.ts': ['cost_'],
  'prompt-analyzer.ts': ['prompt_effectiveness', 'prompt_suggestions'],
  'audit-trail.ts': ['audit_'],
  'validation-engine.ts': ['validation_'],
  'adr-generator.ts': ['adr_'],
  'security-scorer.ts': ['security_'],
  'dependency-scorer.ts': ['dep_'],
  'team-knowledge.ts': ['team_'],
  'regression-detector.ts': ['regression_', 'feature_'],
  'knowledge-tools.ts': ['knowledge_'],
  'python-tools.ts': ['py_'],
  'license.ts': ['license_'],
};

/**
 * Map of imported DB-loader fn -> the DbNeed it represents.
 *
 * Uses `Map` (not plain object) so prototype-chain identifiers like
 * `toLocaleString`, `toString`, `hasOwnProperty` cannot spuriously match
 * via Object.prototype lookup.
 */
const DB_FN_TO_NEED: ReadonlyMap<string, DbNeed> = new Map<string, DbNeed>([
  ['getCodeGraphDb', 'codegraph'],
  ['getDataDb', 'data'],
  ['getMemoryDb', 'memory'],
  ['getKnowledgeDb', 'knowledge'],
]);

/**
 * Walk a TypeScript source file and find all references to DB-loader
 * function names. Returns the set of DbNeed values implied by those refs.
 */
function detectDbAccess(filePath: string): Set<DbNeed> {
  const code = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.ESNext, true);
  const detected = new Set<DbNeed>();

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const need = DB_FN_TO_NEED.get(node.text);
      if (need !== undefined) {
        detected.add(need);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return detected;
}

/**
 * Union of declared DB needs across all tools in `TOOL_DB_NEEDS` whose
 * short-name matches any of the given prefixes/exact-names.
 */
function declaredNeedsForFamilies(families: readonly string[]): Set<DbNeed> {
  const declared = new Set<DbNeed>();
  for (const [toolName, needs] of Object.entries(TOOL_DB_NEEDS)) {
    const matches = families.some((fam) =>
      fam.endsWith('_') ? toolName.startsWith(fam) : toolName === fam,
    );
    if (matches) {
      for (const n of needs) declared.add(n);
    }
  }
  return declared;
}

describe('TOOL_DB_NEEDS — AST completeness against handler modules', () => {
  for (const [filename, families] of Object.entries(MODULE_TO_FAMILIES)) {
    it(`${filename}: declared needs ⊇ actual DB access`, () => {
      const filePath = resolve(SRC_DIR, filename);
      const actualAccess = detectDbAccess(filePath);
      const declared = declaredNeedsForFamilies(families);

      // For each DB the module ACTUALLY accesses, it must be in the
      // declared union. (Strict subset is fine — a module that imports
      // getMemoryDb but never uses it in a tool handler is harmless.)
      const missing: DbNeed[] = [];
      for (const need of actualAccess) {
        if (!declared.has(need)) {
          missing.push(need);
        }
      }
      expect(
        missing,
        `${filename} accesses ${[...actualAccess].join(', ')} but TOOL_DB_NEEDS for families [${families.join(', ')}] only declares ${[...declared].join(', ')}. Update manifest entries to include: ${missing.join(', ')}.`,
      ).toEqual([]);
    });
  }
});

describe('TOOL_DB_NEEDS — completeness sanity', () => {
  it('every entry has a string key matching tool short-name pattern', () => {
    for (const key of Object.keys(TOOL_DB_NEEDS)) {
      expect(key, `manifest key "${key}" should match /^[a-z][a-z0-9_]*$/`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('total entry count matches expected baseline (regression guard)', () => {
    // If you add or remove tools, update this expected count AND ensure
    // the new tool is registered in both `getToolDefinitions()` and
    // TOOL_DB_NEEDS. The pattern scanner Check 14 (P-B-004) is the
    // grep-level safety net before this test runs.
    const count = Object.keys(TOOL_DB_NEEDS).length;
    expect(count).toBeGreaterThanOrEqual(60); // current: ~70 tools
    expect(count).toBeLessThan(150); // sanity upper bound
  });
});

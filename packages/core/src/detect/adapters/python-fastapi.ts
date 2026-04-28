// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: FastAPI AST adapter.
 *
 * Extracts:
 *   - auth_dep: name passed to `Depends(...)` in router files
 *   - api_prefix_base: first path segment of `APIRouter(prefix="/...")`
 *   - test_async_pattern: `@pytest.mark.asyncio` (with or without parens)
 *
 * Confidence rules:
 *   - 'high' if the auth dep is found exactly ONCE in routers/ and matches
 *     known FastAPI signatures.
 *   - 'medium' if found in non-routers/ paths (e.g., a deps.py module).
 *   - 'low' if multiple candidate auth deps are found (ambiguous — but still
 *     emitted so the user can see what was found).
 *   - 'none' if no `Depends(...)` calls found AND no `APIRouter(prefix=)` —
 *     adapter doesn't apply, regex fallback takes over.
 *
 * Does NOT use regex on file content — only Tree-sitter S-expression queries
 * compiled via `query-helpers.ts`. Regex would be the regex-fallback path.
 */

import { Parser } from 'web-tree-sitter';
import type { CodebaseAdapter, AdapterResult, DetectionSignals, Provenance, SourceFile } from './types.ts';
import { runQuery, InvalidQueryError } from './query-helpers.ts';
import { loadGrammar } from './tree-sitter-loader.ts';

// ============================================================
// Tree-sitter S-expression queries
// ============================================================

/**
 * Auth dependency: catches `Depends(get_current_user)`, `Depends(require_tier_or_guardian)`,
 * etc. Anchored on the canonical `Depends` call shape.
 *
 * Per the spec doc §3, predicate constraints (#eq?) keep the query from
 * matching arbitrary `<x>(<y>)` calls.
 */
const AUTH_DEP_QUERY = `
(call
  function: (identifier) @_callee (#eq? @_callee "Depends")
  arguments: (argument_list
    (identifier) @auth_dep))
`;

/**
 * APIRouter prefix: `APIRouter(prefix="/api/orders", ...)`. Captures the
 * string literal so the runner can split off the base segment.
 */
const API_PREFIX_QUERY = `
(call
  function: (identifier) @_callee (#eq? @_callee "APIRouter")
  arguments: (argument_list
    (keyword_argument
      name: (identifier) @_kw (#eq? @_kw "prefix")
      value: (string) @prefix_value)))
`;

/**
 * `@pytest.mark.asyncio` decorator. Captures the decorator name string for
 * provenance; the value field is fixed as the canonical form.
 */
const PYTEST_ASYNCIO_QUERY = `
(decorator
  (attribute
    object: (attribute
      object: (identifier) @_pkg (#eq? @_pkg "pytest")
      attribute: (identifier) @_mark (#eq? @_mark "mark"))
    attribute: (identifier) @_marker (#eq? @_marker "asyncio"))) @decorator
`;

// ============================================================
// Adapter
// ============================================================

export const pythonFastApiAdapter: CodebaseAdapter = {
  id: 'python-fastapi',
  languages: ['python'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. Match if:
    //   1. pyproject.toml mentions fastapi (raw text contains 'fastapi'), OR
    //   2. project has a routers/ directory (FastAPI convention), OR
    //   3. project has app/ + python files at top level
    const pyToml = signals.pyprojectToml as { __raw?: string } | undefined;
    if (pyToml?.__raw && /\bfastapi\b/i.test(pyToml.__raw)) return true;
    if (signals.presentDirs.has('routers')) return true;
    if (signals.presentDirs.has('app') && signals.presentFiles.has('main.py')) return true;
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('python');
    } catch (e) {
      // Grammar unavailable → adapter returns 'none' so regex fallback takes
      // over. The runner's stderr line is emitted at the introspector tier.
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    // Per-field collection: { value -> { fileLine, queryName } }
    const authDeps = new Map<string, { line: number; file: string }>();
    const prefixBases = new Map<string, { line: number; file: string }>();
    const testAsyncPatterns = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        try {
          // Auth dep
          for (const hit of runQuery(parser, file.content, AUTH_DEP_QUERY, 'fastapi-auth-dep', file.path)) {
            const name = hit.captures.auth_dep;
            if (name && !authDeps.has(name)) {
              authDeps.set(name, { line: hit.line, file: file.path });
            }
          }
          // API prefix
          for (const hit of runQuery(parser, file.content, API_PREFIX_QUERY, 'fastapi-api-prefix', file.path)) {
            const raw = hit.captures.prefix_value;
            if (!raw) continue;
            // Strip enclosing quotes (string node text includes them)
            const literal = raw.replace(/^['"]/, '').replace(/['"]$/, '');
            const base = extractPrefixBase(literal);
            if (base && !prefixBases.has(base)) {
              prefixBases.set(base, { line: hit.line, file: file.path });
            }
          }
          // pytest.mark.asyncio
          for (const hit of runQuery(parser, file.content, PYTEST_ASYNCIO_QUERY, 'fastapi-pytest-asyncio', file.path)) {
            const pat = '@pytest.mark.asyncio';
            if (!testAsyncPatterns.has(pat)) {
              testAsyncPatterns.set(pat, { line: hit.line, file: file.path });
            }
          }
        } catch (e) {
          if (e instanceof InvalidQueryError) {
            // Compile-time failure of OUR query is a developer bug — surface it.
            throw e;
          }
          // Per-file parse error: skip this file, keep going. Tree-sitter is
          // error-tolerant so this is rare; usually means we got a binary or
          // a non-Python file mislabeled.
          continue;
        }
      }
    } finally {
      try { parser.delete(); } catch { /* ignore */ }
    }

    // Build result
    const conventions: Record<string, unknown> = {};
    const provenance: Provenance[] = [];

    // Auth dep: high if exactly 1, low if >1 (still emit first), none if 0.
    if (authDeps.size === 1) {
      const [name, { line, file }] = authDeps.entries().next().value as [string, { line: number; file: string }];
      conventions.auth_dep = name;
      provenance.push({ field: 'auth_dep', sourceFile: file, line, query: 'fastapi-auth-dep' });
    } else if (authDeps.size >= 2) {
      // Ambiguous — prefer the first-seen (stable order from input file list).
      const [name, { line, file }] = authDeps.entries().next().value as [string, { line: number; file: string }];
      conventions.auth_dep = name;
      provenance.push({ field: 'auth_dep', sourceFile: file, line, query: 'fastapi-auth-dep' });
    }

    if (prefixBases.size >= 1) {
      const [base, { line, file }] = prefixBases.entries().next().value as [string, { line: number; file: string }];
      conventions.api_prefix_base = base;
      provenance.push({ field: 'api_prefix_base', sourceFile: file, line, query: 'fastapi-api-prefix' });
    }

    if (testAsyncPatterns.size >= 1) {
      const [pat, { line, file }] = testAsyncPatterns.entries().next().value as [string, { line: number; file: string }];
      conventions.test_async_pattern = pat;
      provenance.push({ field: 'test_async_pattern', sourceFile: file, line, query: 'fastapi-pytest-asyncio' });
    }

    let confidence: AdapterResult['confidence'];
    if (Object.keys(conventions).length === 0) {
      confidence = 'none';
    } else if (authDeps.size === 1 || (authDeps.size === 0 && prefixBases.size > 0)) {
      confidence = 'high';
    } else if (authDeps.size >= 2) {
      confidence = 'low';
    } else {
      confidence = 'medium';
    }

    return { conventions, provenance, confidence };
  },
};

// ============================================================
// Helpers
// ============================================================

function extractPrefixBase(prefix: string): string | null {
  if (!prefix.startsWith('/')) return null;
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

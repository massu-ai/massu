// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: query-helpers.ts unit tests.
 *
 * Coverage (per audit-iter-5 fix HH):
 *   (a) wrapper exposes the documented Tree-sitter query API surface
 *   (b) invalid S-expression query → throws typed error (InvalidQueryError),
 *       NOT a raw Error
 *
 * NOTE: Most behavior is exercised end-to-end via the per-adapter tests
 * (which load real grammars from cache). This file focuses on the
 * surface-level API contract and the typed-error invariant.
 */

import { describe, expect, it } from 'vitest';
import { InvalidQueryError, runQuery } from '../detect/adapters/query-helpers.ts';

describe('query-helpers: API surface (test a)', () => {
  it('exports InvalidQueryError as a typed error class', () => {
    const err = new InvalidQueryError('test', 'bad source', new Error('cause'));
    expect(err).toBeInstanceOf(InvalidQueryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidQueryError');
    expect(err.queryName).toBe('test');
    expect(err.querySource).toBe('bad source');
    expect(err.message).toContain('Invalid Tree-sitter query');
    expect(err.message).toContain('cause');
  });

  it('exports runQuery as a callable function', () => {
    expect(typeof runQuery).toBe('function');
    // 5 params: parser, source, queryText, queryName, filePath
    expect(runQuery.length).toBe(5);
  });
});

describe('query-helpers: typed error contract (test b)', () => {
  it('runQuery on a parser with no language assigned throws InvalidQueryError, NOT raw Error', () => {
    // Build a minimal parser-shaped object with `language: null`.
    // We can't easily instantiate a real Parser without WASM init, but the
    // `runQuery` function only reads `parser.language`. A shape-compatible
    // mock suffices for this test path.
    const mockParser = { language: null } as any;
    let threw: unknown = null;
    try {
      runQuery(mockParser, '', '(some)', 'test-query', '/tmp/x.py');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(InvalidQueryError);
    expect((threw as InvalidQueryError).queryName).toBe('test-query');
  });

  it('InvalidQueryError preserves the original cause', () => {
    const cause = new Error('original-boom');
    const err = new InvalidQueryError('q', 'source', cause);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('original-boom');
  });
});

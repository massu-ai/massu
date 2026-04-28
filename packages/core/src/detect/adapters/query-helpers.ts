// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: Tree-sitter query wrapper.
 *
 * Adapters consume the helpers in this file — never the raw `web-tree-sitter`
 * API. This keeps the surface area minimal and testable.
 *
 * Design:
 *   - `compileQuery` caches compiled `Query` instances per (language, source)
 *     tuple. Compiling an S-expression is non-trivial; cache hit-rate is
 *     critical when the same query runs across N sampled files.
 *   - `runQuery` returns the captures as `{captures, file, line}` records so
 *     adapters never need to touch raw `Node` objects.
 *   - `InvalidQueryError` is the typed error thrown when an S-expression is
 *     malformed; never let a raw `Error` reach the adapter (per audit-iter-5
 *     fix HH test (b)).
 */

import { Query, type Language, type Node, type Parser, type QueryMatch } from 'web-tree-sitter';

/**
 * Thrown when an S-expression query string fails to compile against the
 * supplied grammar. Carries the original message and the offending source
 * so adapter authors can debug.
 */
export class InvalidQueryError extends Error {
  public readonly queryName: string;
  public readonly querySource: string;
  public readonly cause?: unknown;
  constructor(queryName: string, querySource: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `[query-helpers] Invalid Tree-sitter query "${queryName}": ${causeMsg}\n` +
        `Query source:\n${querySource}`,
    );
    this.name = 'InvalidQueryError';
    this.queryName = queryName;
    this.querySource = querySource;
    this.cause = cause;
  }
}

// ============================================================
// Query compile cache
// ============================================================

// We key by Language identity (not by name) AND by source string. The Query
// type from web-tree-sitter is opaque; we store it directly.
const queryCache = new WeakMap<Language, Map<string, Query>>();

/**
 * Compile (and cache) an S-expression query against `language`.
 *
 * Throws `InvalidQueryError` (NOT raw Error) on malformed S-expressions —
 * adapters can catch this without losing the typed boundary.
 *
 * Cache lookup is O(1) on the (Language, source) tuple via WeakMap+Map.
 */
export function compileQuery(
  language: Language,
  source: string,
  queryName: string,
): Query {
  let perLang = queryCache.get(language);
  if (!perLang) {
    perLang = new Map();
    queryCache.set(language, perLang);
  }
  const cached = perLang.get(source);
  if (cached) return cached;

  let q: Query;
  try {
    q = new Query(language, source);
  } catch (e) {
    throw new InvalidQueryError(queryName, source, e);
  }

  perLang.set(source, q);
  return q;
}

// ============================================================
// Capture extraction
// ============================================================

export interface RunQueryHit {
  /**
   * Capture name → captured text. If the same capture name appears multiple
   * times in a single match, the LAST occurrence wins (callers usually want
   * the most-specific one).
   */
  captures: Record<string, string>;
  /** Absolute path to the file being parsed. */
  file: string;
  /** 1-based line number of the FIRST capture in the match. */
  line: number;
  /** Name of the query (used for provenance). */
  queryName: string;
}

/**
 * Run a compiled query against a parsed tree. Returns a flat list of hits.
 *
 * Each match becomes one `RunQueryHit`. The `line` is computed from the
 * earliest-starting capture in the match (1-based). Note that this helper is
 * intentionally narrow — it is NOT a general node-walker. Adapters that need
 * tree traversal should compose multiple queries instead.
 */
export function runQuery(
  parser: Parser,
  source: string,
  queryText: string,
  queryName: string,
  filePath: string,
): RunQueryHit[] {
  const language = parser.language;
  if (!language) {
    throw new InvalidQueryError(
      queryName,
      queryText,
      new Error('Parser has no language assigned'),
    );
  }
  const query = compileQuery(language, queryText, queryName);

  const tree = parser.parse(source);
  if (!tree) return [];

  let matches: QueryMatch[];
  try {
    matches = query.matches(tree.rootNode);
  } catch (e) {
    // Match-time errors are unusual (compile-time catches most), but we still
    // wrap to keep the typed-error contract.
    throw new InvalidQueryError(queryName, queryText, e);
  }

  const out: RunQueryHit[] = [];
  for (const match of matches) {
    if (!match.captures || match.captures.length === 0) continue;
    const captures: Record<string, string> = {};
    let earliestLine = Number.POSITIVE_INFINITY;
    for (const cap of match.captures) {
      const node: Node = cap.node;
      captures[cap.name] = node.text;
      if (node.startPosition.row + 1 < earliestLine) {
        earliestLine = node.startPosition.row + 1;
      }
    }
    out.push({
      captures,
      file: filePath,
      line: Number.isFinite(earliestLine) ? earliestLine : 1,
      queryName,
    });
  }

  // Per Tree-sitter docs: trees should be deleted to free WASM memory.
  // Adapters call runQuery once per file so this cleanup is local.
  try {
    tree.delete();
  } catch {
    /* deletion is best-effort — some test mocks don't implement delete */
  }

  return out;
}

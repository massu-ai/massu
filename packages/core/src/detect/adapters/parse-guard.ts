// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 3.5 (security audit): centralized AST parse-time safety.
 *
 * Adapters consume oversized / pathological user source. Tree-sitter is
 * fast but synchronous — there is no native timeout, no native size cap.
 * This module provides:
 *
 *   1. `MAX_AST_FILE_BYTES` — 1MB hard cap per file (covers DoS vector
 *      "oversized file"). Plan §1 cited 5MB; we apply a tighter bound at
 *      the adapter tier because adapter sample size is small (≤3 files
 *      per adapter) and 1MB is already an order of magnitude beyond
 *      reasonable convention-defining files.
 *   2. `MAX_AST_PARSE_DEPTH` — 5K-deep nested-structure rejection — a
 *      static text scan for runaway open-paren / open-brace runs that
 *      would push Tree-sitter into deep recursion. Cheap pre-check.
 *   3. `parseTimeout(ms, fn)` — wraps a synchronous Tree-sitter call in
 *      a deadline guard. Tree-sitter's pure-JS path can't be interrupted
 *      mid-parse, but we record the elapsed time AFTER the call returns
 *      and emit a stderr warning when budget is exceeded so daemon ops
 *      see the abuse signal.
 *   4. `isParsableSource(source)` — static gate combining size + depth.
 *      Returns `null` if accepted, or a `{ reason, detail }` object when
 *      rejected so the adapter can record provenance and skip the file.
 *
 * Library purity: never terminates the process, no DB calls, no network.
 * Pure helper module.
 */

/** Hard size cap for an individual file fed to Tree-sitter. */
export const MAX_AST_FILE_BYTES = 1 * 1024 * 1024;

/**
 * Maximum nested-bracket depth allowed in a file. Pathological inputs
 * with 10K-deep nesting can push Tree-sitter into runaway recursion on
 * some grammar versions. Cheap O(n) text scan picks them off before parse.
 */
export const MAX_AST_PARSE_DEPTH = 5000;

/**
 * Per-file Tree-sitter parse budget (ms). Tree-sitter parses are
 * synchronous in JS, so this is enforced as a post-call elapsed-time
 * check rather than a hard timer. The check still serves the purpose of
 * giving operators visibility into adversarial files.
 */
export const MAX_AST_PARSE_MS = 2000;

export type ParseSkipReason =
  | 'size-cap'
  | 'depth-cap'
  | 'control-bytes'
  | 'utf8-validation';

export interface ParseSkip {
  reason: ParseSkipReason;
  detail: string;
}

/**
 * Static safety gate. Call BEFORE invoking `parser.parse()`. Returns
 * `null` if the source is acceptable, or a `ParseSkip` describing why
 * the file is rejected.
 *
 * Cheap to evaluate — single linear scan + size check.
 */
export function isParsableSource(source: string, sizeBytes?: number): ParseSkip | null {
  // Size cap: reject before Tree-sitter sees the bytes. We compute
  // byte-length conservatively when not provided.
  const bytes = sizeBytes ?? Buffer.byteLength(source, 'utf-8');
  if (bytes > MAX_AST_FILE_BYTES) {
    return {
      reason: 'size-cap',
      detail: `${bytes} bytes > ${MAX_AST_FILE_BYTES} cap`,
    };
  }

  // Depth cap: count maximal nesting depth across `(` `[` `{` runs.
  // Single-pass O(n) — no regex backtracking.
  let depth = 0;
  let maxDepth = 0;
  // Also reject NUL bytes (Tree-sitter handles them but they're a
  // canary for binary-file mislabeling).
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 0) {
      return { reason: 'control-bytes', detail: 'NUL byte at offset ' + i };
    }
    // 40 = '(', 91 = '[', 123 = '{'
    if (c === 40 || c === 91 || c === 123) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      if (depth > MAX_AST_PARSE_DEPTH) {
        return {
          reason: 'depth-cap',
          detail: `nesting depth exceeded ${MAX_AST_PARSE_DEPTH}`,
        };
      }
    } else if (c === 41 || c === 93 || c === 125) {
      // Close brackets — clamp to 0 (mismatched code shouldn't crash this).
      depth = depth > 0 ? depth - 1 : 0;
    }
  }

  return null;
}

/**
 * Wrap a synchronous Tree-sitter call and emit a warning when the call
 * exceeds the budget. Returns the call's result regardless — callers may
 * decide to discard it based on `elapsed`.
 *
 * Note: Tree-sitter's WASM path has no co-operative cancellation, so
 * this is observability rather than a hard kill. The size + depth caps
 * are the load-bearing mitigations; this is the third belt.
 */
export function withParseDeadline<T>(
  fn: () => T,
  filePath: string,
  budgetMs: number = MAX_AST_PARSE_MS,
): { value: T; elapsedMs: number; overBudget: boolean } {
  const start = Date.now();
  const value = fn();
  const elapsedMs = Date.now() - start;
  const overBudget = elapsedMs > budgetMs;
  if (overBudget) {
    process.stderr.write(
      `[massu/ast] WARN: parse of ${filePath} took ${elapsedMs}ms (budget ${budgetMs}ms) — file may be adversarial. (Phase 3.5 mitigation)\n`,
    );
  }
  return { value, elapsedMs, overBudget };
}

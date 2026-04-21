// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Shared passthrough helpers for config migration + refresh.
 *
 * These helpers exist to prevent the class of bug fixed in @massu/core@1.2.0
 * (incident 2026-04-19-config-upgrade-data-loss): a hand-maintained allow-list
 * in `migrate.ts` silently dropped any v1 top-level key not on the list, and
 * the parallel rebuild blocks inside `framework` / `paths` / `project` /
 * `python` did the same thing at the nested level.
 *
 * Both helpers are TARGET-WINS: the migrator writes the keys it actively owns,
 * then the helper fills in everything else the user had. A user-authored value
 * in `target` is NEVER overwritten by the source.
 *
 * Why two exports instead of one:
 *   - `copyUnknownKeys` takes an explicit `handledKeys` set — used for TOP-LEVEL
 *     passthrough where the caller enumerates the keys it migrated explicitly
 *     (e.g., schema_version, project, framework, paths, toolPrefix, …).
 *   - `preserveNestedSubkeys` takes no handled-set — used for NESTED passthrough
 *     where the target block was just rebuilt, so `k in target` already skips
 *     any key the rebuild populated. Splitting the two makes callsites
 *     self-documenting without a verbose `new Set()` argument at every nested
 *     call (A-002 architecture-review follow-up).
 */

/** Keys that would mutate Object.prototype if copied as own properties. Explicit
 *  denylist defense-in-depth on top of the existing `k in target` guard and the
 *  `yaml@2.8` parser's non-polluting behavior (S-001 security-review follow-up). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copy any key from `source` into `target` that target doesn't already have set,
 * skipping keys listed in `handledKeys`. Target values ALWAYS win — this function
 * never overwrites an existing target key.
 *
 * - If source[k] is undefined → skip (undefined is not a preservable value).
 * - If k is an UNSAFE_KEYS entry → skip (prototype-pollution defense).
 * - If handledKeys.has(k) → skip (caller has its own handling).
 * - If target already owns k → skip (target wins).
 * - Otherwise → target[k] = deepClone(source[k]).
 *
 * Values are DEEP-CLONED via structuredClone so that mutating the output v2
 * object never reaches back into the v1 input (S-002 security-review follow-up).
 * Preserves the migrator's "pure data in, pure data out" contract.
 */
export function copyUnknownKeys(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  handledKeys: ReadonlySet<string>
): void {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return;
  }
  for (const k of Object.keys(source)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (source[k] === undefined) continue;
    if (handledKeys.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(target, k)) continue;
    target[k] = safeClone(source[k]);
  }
}

/**
 * Preserve every subkey from sourceBlock into targetBlock that targetBlock
 * doesn't already have. Target values ALWAYS win.
 *
 * If sourceBlock is not a plain object (string, array, null, undefined),
 * return early — there are no subkeys to preserve. This matches the coercion
 * semantics of `getRecord` in migrate.ts and prevents throws on loose v1 inputs
 * like `framework: "typescript"`.
 *
 * Values are deep-cloned (see copyUnknownKeys); UNSAFE_KEYS are skipped.
 */
export function preserveNestedSubkeys(
  sourceBlock: unknown,
  targetBlock: Record<string, unknown>
): void {
  if (
    sourceBlock === null ||
    sourceBlock === undefined ||
    typeof sourceBlock !== 'object' ||
    Array.isArray(sourceBlock)
  ) {
    return;
  }
  const src = sourceBlock as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (src[k] === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(targetBlock, k)) continue;
    targetBlock[k] = safeClone(src[k]);
  }
}

/** structuredClone with a fallback for environments without it (Node <17). */
function safeClone<T>(v: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      // structuredClone throws on functions, DOM nodes, etc. — YAML never produces
      // those, but if a caller passes something exotic, fall through to shallow.
    }
  }
  return v;
}

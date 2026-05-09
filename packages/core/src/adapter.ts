/**
 * `@massu/core/adapter` — public adapter authoring SDK (Plan 3c gap-31, gap-35).
 *
 * Adapter authors import from this subpath ONLY; everything inside @massu/core
 * outside this entry point is implementation detail subject to change without
 * a major version bump. The contract surface here is part of the SemVer-
 * stable API.
 *
 * Usage (adapter package author):
 *
 *   import { defineAdapter, type CodebaseAdapter } from '@massu/core/adapter';
 *
 *   export default defineAdapter({
 *     id: 'rails-active-record',
 *     languages: ['ruby'],
 *     matches(signals) {
 *       return Boolean(signals.gemfile?.includes('rails'));
 *     },
 *     async introspect(files, rootDir) {
 *       // Tree-sitter queries, AST walks, file sampling…
 *       return {
 *         conventions: { router: 'rails' },
 *         provenance: [{ field: 'router', value: 'config/routes.rb:1', query: 'gemfile' }],
 *         confidence: 'high',
 *       };
 *     },
 *   });
 *
 * Then in the adapter package's package.json:
 *   {
 *     "name": "@massu/adapter-rails",
 *     "version": "0.1.0",
 *     "main": "dist/index.js",
 *     "type": "module",
 *     "massu-adapter": true,
 *     "massu-adapter-api-version": "1",
 *     "peerDependencies": { "@massu/core": ">=1.5.0 <2.0.0" }
 *   }
 *
 * The adapter loader (Plan 3b runner.ts) does
 *   const mod = await import(`<package-dir>/${main}`);
 *   const adapter = (mod.default ?? mod) as CodebaseAdapter;
 * and dispatches matches() + introspect() accordingly.
 *
 * defineAdapter is a NO-OP at runtime — it's an identity function that
 * exists for compile-time type narrowing (so adapter authors get IDE
 * autocomplete + type errors for missing fields). The factory's only job
 * is to anchor the type contract; it does NOT validate at runtime, register
 * anywhere, or mutate state. Runtime validation happens at the loader
 * (Plan 3b runner.ts) which checks the dispatched object shape before
 * invoking matches/introspect.
 *
 * Stability: every export here is part of @massu/core's public SemVer
 * surface. Breaking changes to the CodebaseAdapter shape (renamed fields,
 * removed methods) require a major version bump per the
 * massu-adapter-api-version contract. Adapter packages declare
 * `"massu-adapter-api-version": "1"` so the loader refuses incompatible
 * majors at startup.
 */

export {
  // The contract every adapter package must implement.
  type CodebaseAdapter,
  // Inputs the runner provides to matches() / introspect().
  type DetectionSignals,
  type SourceFile,
  type TreeSitterLanguage,
  // Output shapes from introspect() + the runner's merge step.
  type AdapterResult,
  type Provenance,
  type AdapterResolved,
  type MergedAdapterOutput,
} from './detect/adapters/types.js';

import type { CodebaseAdapter } from './detect/adapters/types.js';

// ============================================================
// Plan 3c Phase 9b P-A-001a: runtime helper re-exports.
//
// The 5 first-party framework adapters (rails/phoenix/aspnet/spring/go-chi)
// migrated to `packages/adapter-<f>/src/index.ts` workspace packages need
// these helpers from `@massu/core/adapter` rather than reaching into
// `@massu/core` internals (which would couple the workspace package to
// every transitive .ts file).
//
// CR-46: a single SemVer-stable authoring surface. Every export from this
// file is part of the public adapter API; breaking changes require a
// major version bump per `massu-adapter-api-version`.
// ============================================================

// Tree-sitter query helpers (compileQuery is intentionally NOT re-exported —
// only `runQuery` returns the cooked record shape adapters consume).
export { runQuery, InvalidQueryError, type RunQueryHit } from './detect/adapters/query-helpers.js';

// Grammar acquisition (runtime: downloads + verifies SHA-256 + caches).
export { loadGrammar } from './detect/adapters/tree-sitter-loader.js';

// Parse-time safety guards (size cap + nested-depth check).
export {
  isParsableSource,
  MAX_AST_FILE_BYTES,
  MAX_AST_PARSE_DEPTH,
  MAX_AST_PARSE_MS,
  type ParseSkip,
  type ParseSkipReason,
} from './detect/adapters/parse-guard.js';

/**
 * Identity factory — narrows the input's type to `CodebaseAdapter` so
 * authors get compile-time checking + IDE autocomplete for missing /
 * mistyped fields. Runtime: returns the input unchanged. Use this in
 * place of an inline `const adapter: CodebaseAdapter = { ... }`
 * annotation.
 *
 * Returning the input (instead of `void`) means adapter packages can do
 * `export default defineAdapter({ ... })` and the loader's
 * `mod.default` destructuring just works.
 */
export function defineAdapter(spec: CodebaseAdapter): CodebaseAdapter {
  return spec;
}

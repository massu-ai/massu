/**
 * CORE-BUNDLED adapter id source of truth.
 *
 * Plan 3c Phase 5 5H + 5I deliverable. The CLI's `adapters list` consumes
 * this set to know which ids should be classified as CORE-BUNDLED via the
 * three-class trust model (security/adapter-origin.ts:getAdapterOrigin).
 *
 * CR-46 / Rule 0 drift-prevention: a static set is the wrong shape (it
 * inevitably drifts as Plan 3b/Phase 7 adds adapters). Instead the set
 * is paired with a drift-guard test
 * (__tests__/core-bundled-ids-drift.test.ts) that asserts CORE_BUNDLED_IDS
 * matches the actual filesystem state of `detect/adapters/*.ts` minus the
 * support modules (types, runner, query-helpers, parse-guard, tree-sitter-
 * loader, index, discover). A new adapter file added to the directory
 * without updating this set fails the drift-guard test → cannot merge.
 *
 * Plan 3b shipped 4 (next, fastapi, django, swiftui); Phase 7 ships 31
 * more for 35 total. Each Phase 7 commit MUST update this set in lockstep
 * with the new adapter file under detect/adapters/.
 */

export const CORE_BUNDLED_IDS: ReadonlySet<string> = new Set([
  'go-chi',
  'nextjs-trpc',
  'python-django',
  'python-fastapi',
  'python-flask',
  'swift-swiftui',
]);

/**
 * Filenames in `detect/adapters/` that are NOT first-party adapters but
 * support modules (the adapter contract types, the runner, helpers).
 * The drift-guard test uses this list to subtract support files from the
 * filesystem scan before asserting equality with CORE_BUNDLED_IDS.
 */
export const ADAPTER_SUPPORT_FILES: ReadonlySet<string> = new Set([
  'types.ts',
  'runner.ts',
  'query-helpers.ts',
  'parse-guard.ts',
  'tree-sitter-loader.ts',
  'index.ts',
  'discover.ts',
]);

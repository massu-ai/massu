/**
 * Single source of truth for the canonical Massu hook set.
 *
 * P-H001 (plan-stage-c-high-batch): doctor / installer / build:hooks all
 * consume from here. The drift-guard `hook-registry-parity.test.ts` asserts:
 *
 *   1. REGISTERED_HOOKS matches `src/hooks/*.ts` filenames (the build SoT).
 *   2. REGISTERED_HOOKS matches the hook names referenced in
 *      `buildHooksConfig()` (the installer SoT).
 *   3. REGISTERED_HOOKS matches `dist/hooks/*.js` after `npm run build:hooks`
 *      (the runtime SoT, when build artifacts are available).
 *
 * Adding a new hook requires touching THREE places: src/hooks/X.ts,
 * REGISTERED_HOOKS, and buildHooksConfig() — the parity tests enforce this.
 */
export const REGISTERED_HOOKS = [
  'auto-learning-pipeline',
  'classify-failure',
  'cost-tracker',
  'fix-detector',
  'incident-pipeline',
  'intent-suggester',
  'post-edit-context',
  'post-tool-use',
  'pre-compact',
  'pre-delete-check',
  'quality-event',
  'rule-enforcement-pipeline',
  'security-gate',
  'session-end',
  'session-start',
  'user-prompt',
] as const;

export type RegisteredHook = (typeof REGISTERED_HOOKS)[number];

export function getExpectedHookFiles(): readonly string[] {
  return REGISTERED_HOOKS.map((name) => `${name}.js`);
}

export function getRegisteredHookCount(): number {
  return REGISTERED_HOOKS.length;
}

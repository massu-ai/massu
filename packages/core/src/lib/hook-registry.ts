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
  'memory-recall',
  'post-edit-context',
  'post-tool-use',
  'pre-compact',
  // P-E-019 (1.12.0): security-gate + pre-delete-check are kept registered
  // for back-compat (operator settings.json may still reference them
  // individually), but new installs emit only `pre-tool-use-gate` —
  // the consolidated single-spawn PreToolUse hook.
  'pre-delete-check',
  'pre-tool-use-gate',
  'quality-event',
  'rule-enforcement-pipeline',
  'security-gate',
  'session-end',
  'session-start',
  'user-prompt',
] as const;

export type RegisteredHook = (typeof REGISTERED_HOOKS)[number];

/**
 * Hooks whose exit code IS a decision: the PreToolUse gate and the two back-compat entries
 * that run the same decision (`hooks/lib/pre-tool-use-decision.ts`). For these, any exit
 * other than 0 (allow) or 2 (deny) — a crash at import, a signal — must become a DENY:
 * Claude Code treats other codes as a non-blocking error and runs the call.
 *
 * Asserted equal to the set of hook entries that call `runPreToolUseDecision` by
 * `hook-runner-decision-fail-closed.test.ts`, so a new deciding entry cannot be missed.
 */
export const DECISION_HOOKS: readonly RegisteredHook[] = ['pre-delete-check', 'pre-tool-use-gate', 'security-gate'];

export function getExpectedHookFiles(): readonly string[] {
  return REGISTERED_HOOKS.map((name) => `${name}.js`);
}

export function getRegisteredHookCount(): number {
  return REGISTERED_HOOKS.length;
}

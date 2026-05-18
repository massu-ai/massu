// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H001 (plan-stage-c-high-batch) drift-guard DG-1.
 *
 * Closes the bug-class where `doctor.ts:EXPECTED_HOOKS` (hand-maintained list)
 * silently drifts from `installHooks()` (registered in `buildHooksConfig`)
 * and from the actual `src/hooks/*.ts` source set. Pre-fix: doctor reported
 * 11/11 PASS while 5 hooks could be missing from `dist/hooks/*.js`.
 *
 * Structural fix: `lib/hook-registry.ts` is the single source of truth.
 * This test asserts THREE-way parity so adding a hook requires touching all
 * three places (src/hooks/X.ts, REGISTERED_HOOKS, buildHooksConfig).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { REGISTERED_HOOKS, getExpectedHookFiles } from '../lib/hook-registry.ts';
import { buildHooksConfig } from '../commands/init.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('hook-registry parity (DG-1)', () => {
  it('REGISTERED_HOOKS matches src/hooks/*.ts filenames', () => {
    const srcHooksDir = resolve(__dirname, '../hooks');
    const sourceHooks = readdirSync(srcHooksDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();

    const registered = [...REGISTERED_HOOKS].sort();

    expect(registered).toEqual(sourceHooks);
  });

  it('every hook referenced in buildHooksConfig() is REGISTERED (P-E-019 relaxed to subset)', () => {
    // P-E-019 (1.12.0): the consolidation of security-gate + pre-delete-check
    // into pre-tool-use-gate means buildHooksConfig() emits a STRICT SUBSET
    // of REGISTERED_HOOKS — the two consolidated hooks remain registered
    // for back-compat with operator settings.json files that still
    // reference them, but new installs no longer emit them.
    //
    // Drift-guard semantics preserved: every hook NAME emitted by
    // buildHooksConfig MUST exist in REGISTERED_HOOKS (and thus have a
    // src/hooks/<name>.ts file). The reverse direction (every registered
    // hook must be emitted) is no longer required.
    const config = buildHooksConfig();
    const referenced = new Set<string>();

    for (const event of Object.values(config)) {
      if (!Array.isArray(event)) continue;
      for (const group of event) {
        const hooks = (group as { hooks?: Array<{ command?: string }> }).hooks ?? [];
        for (const hook of hooks) {
          if (typeof hook.command !== 'string') continue;
          const match = hook.command.match(/hook-runner\s+(\S+)/);
          if (match) referenced.add(match[1]);
        }
      }
    }

    const registeredSet = new Set<string>(REGISTERED_HOOKS);
    const unregistered = [...referenced].filter((h) => !registeredSet.has(h));
    expect(unregistered, `unregistered hooks emitted by buildHooksConfig: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('back-compat hooks (security-gate, pre-delete-check) remain REGISTERED for legacy settings.json (P-E-019)', () => {
    // Sanity: a customer with `pre-tool-use: security-gate` in their
    // pre-1.12.0 settings.local.json keeps working — `hook-runner
    // security-gate` still resolves to a real bundle.
    expect([...REGISTERED_HOOKS]).toContain('security-gate');
    expect([...REGISTERED_HOOKS]).toContain('pre-delete-check');
    expect([...REGISTERED_HOOKS]).toContain('pre-tool-use-gate');
  });

  it('REGISTERED_HOOKS matches dist/hooks/*.js after build:hooks (when available)', () => {
    const distHooksDir = resolve(__dirname, '../../dist/hooks');
    if (!existsSync(distHooksDir)) {
      // Build artifact missing in this env (e.g., fresh checkout, CI before
      // build step). Skip — covered by the src parity test above.
      return;
    }

    const distHooks = readdirSync(distHooksDir)
      .filter((f) => f.endsWith('.js'))
      .sort();
    const expected = [...getExpectedHookFiles()].sort();

    expect(distHooks).toEqual(expected);
  });

  it('getExpectedHookFiles count matches REGISTERED_HOOKS length', () => {
    expect(getExpectedHookFiles().length).toBe(REGISTERED_HOOKS.length);
  });
});

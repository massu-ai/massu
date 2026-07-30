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
import { HOOK_NAME_TO_FILE, resolveHookFile } from '../commands/hook-runner.ts';

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

  it('REGISTERED_HOOKS matches dist/hooks/*.js after build:hooks', () => {
    const distHooksDir = resolve(__dirname, '../../dist/hooks');
    // FAIL CLOSED (G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates): this used to
    // `return`, so "the hooks were never built" reported identically to "every hook
    // matches". The src-parity test above cannot cover the built artifacts.
    expect(
      existsSync(distHooksDir),
      `${distHooksDir} missing — this test cannot compare against the built hooks. ` +
        `Run "npm run build:hooks" (packages/core). Do NOT restore the skip.`,
    ).toBe(true);

    const distHooks = readdirSync(distHooksDir)
      .filter((f) => f.endsWith('.js'))
      .sort();
    const expected = [...getExpectedHookFiles()].sort();

    expect(distHooks).toEqual(expected);
  });

  it('getExpectedHookFiles count matches REGISTERED_HOOKS length', () => {
    expect(getExpectedHookFiles().length).toBe(REGISTERED_HOOKS.length);
  });

  // 1.13.1 regression guard: closes the 4th parity edge.
  //
  // 1.13.0 shipped pre-tool-use-gate in REGISTERED_HOOKS + src/hooks +
  // buildHooksConfig (all three existing parity assertions passed), but
  // `commands/hook-runner.ts:HOOK_NAME_TO_FILE` was hand-maintained and
  // missed the entry. The dispatcher then rejected every new install's
  // PreToolUse hook with `Unknown hook`, blocking Bash/Edit/Write at
  // the CC tool gate (catch-22: customer cannot edit settings.local.json
  // to fix it because Edit is gated by the broken hook).
  //
  // Structural fix: HOOK_NAME_TO_FILE now derives from REGISTERED_HOOKS,
  // so this drift is impossible by construction. This test pins both
  // the derivation contract AND the specific regression.
  it('HOOK_NAME_TO_FILE keys match REGISTERED_HOOKS (dispatcher parity)', () => {
    const dispatcherKeys = Object.keys(HOOK_NAME_TO_FILE).sort();
    const registered = [...REGISTERED_HOOKS].sort();
    expect(dispatcherKeys).toEqual(registered);
  });

  it('HOOK_NAME_TO_FILE values match `${name}.js` for every registered hook', () => {
    for (const name of REGISTERED_HOOKS) {
      expect(HOOK_NAME_TO_FILE[name]).toBe(`${name}.js`);
    }
  });

  it('resolveHookFile() succeeds for every hook emitted by buildHooksConfig() (closes 1.13.0 regression)', () => {
    // Direct regression guard: every hook name the installer writes to
    // customer settings.local.json MUST be dispatchable at fire-time.
    // FAIL CLOSED (G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates): this used to
    // `return` when the build artifacts were absent, which is precisely the state in
    // which "every emitted hook is dispatchable" is unverifiable.
    const distHooksDir = resolve(__dirname, '../../dist/hooks');
    expect(
      existsSync(distHooksDir),
      `${distHooksDir} missing — dispatchability cannot be proven without the built hooks. ` +
        `Run "npm run build:hooks" (packages/core). Do NOT restore the skip.`,
    ).toBe(true);
    const config = buildHooksConfig();
    const emitted = new Set<string>();
    for (const event of Object.values(config)) {
      if (!Array.isArray(event)) continue;
      for (const group of event) {
        const hooks = (group as { hooks?: Array<{ command?: string }> }).hooks ?? [];
        for (const hook of hooks) {
          if (typeof hook.command !== 'string') continue;
          const match = hook.command.match(/hook-runner\s+(\S+)/);
          if (match) emitted.add(match[1]);
        }
      }
    }
    expect(emitted.size).toBeGreaterThan(0);
    for (const name of emitted) {
      expect(() => resolveHookFile(name)).not.toThrow();
    }
  });
});

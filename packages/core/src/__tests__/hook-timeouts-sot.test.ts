// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-E-021 (plan-stage-e-low-info-sweep) — hook-timeout SoT drift-guard.
 *
 * Asserts that buildHooksConfig() emits timeout values that match
 * HOOK_TIMEOUTS. Future contributors who hard-code a `timeout: 7`
 * inline will FAIL this test and be redirected to the SoT.
 */

import { describe, it, expect } from 'vitest';
import { buildHooksConfig } from '../commands/init.ts';
import { HOOK_TIMEOUTS } from '../lib/hook-timeouts.ts';

interface HookEntry { command: string; timeout: number }
interface HookGroup { hooks: HookEntry[] }

describe('P-E-021: hook-timeout SoT', () => {
  const config = buildHooksConfig();

  it('every emitted timeout matches HOOK_TIMEOUTS entry for the named hook', () => {
    for (const event of Object.values(config)) {
      const groups = event as HookGroup[];
      for (const group of groups) {
        for (const entry of group.hooks) {
          // command shape: "npx -y @massu/core@<v> hook-runner <name>"
          const m = entry.command.match(/hook-runner\s+(\S+)/);
          if (!m) continue;
          const name = m[1];
          const expected = HOOK_TIMEOUTS[name];
          if (expected !== undefined) {
            expect(
              entry.timeout,
              `hook ${name} timeout drifted from HOOK_TIMEOUTS[${name}]=${expected}, got ${entry.timeout}`
            ).toBe(expected);
          }
        }
      }
    }
  });

  it('HOOK_TIMEOUTS exposes a stable shape (Record<string, number>)', () => {
    for (const [name, val] of Object.entries(HOOK_TIMEOUTS)) {
      expect(typeof name).toBe('string');
      expect(typeof val).toBe('number');
      expect(val).toBeGreaterThan(0);
      expect(val).toBeLessThan(600);
    }
  });
});

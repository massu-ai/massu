// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu init` emits Claude Code's `"async": true` for exactly the hooks declared in
 * BACKGROUND_HOOKS (lib/hook-timeouts.ts), through the one entry builder in init.ts.
 * session-end must be among them: when it blocked the Stop event it cost every user
 * 11-15 s per turn (plan-2026-07-23-hook-latency-silent-loss-fixes, P3).
 */
import { describe, it, expect } from 'vitest';
import { buildHooksConfig } from '../commands/init.ts';
import { BACKGROUND_HOOKS } from '../lib/hook-timeouts.ts';

describe('massu init emits the background flag from the declaration', () => {
  it('every hook declared in BACKGROUND_HOOKS is emitted async, and no other hook is', () => {
    const config = buildHooksConfig() as unknown as Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>>;
    const entries = Object.values(config).flat().flatMap((g) => g.hooks);
    const nameOf = (cmd: string) => cmd.trim().split(/\s+/).pop() as string;
    const asyncNames = entries.filter((e) => e.async === true).map((e) => nameOf(e.command)).sort();
    expect(entries.length).toBeGreaterThan(10); // a zero scope would pass vacuously
    expect(asyncNames).toEqual([...BACKGROUND_HOOKS].sort());
    expect(asyncNames).toContain('session-end');
  });
});

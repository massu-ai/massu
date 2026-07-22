// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Regression guard: `massu doctor` must recognize hooks committed in `.claude/settings.json`,
 * not only `.claude/settings.local.json`.
 *
 * Bug (2026-07-22): `checkHooksConfig` / `checkShellHooksWired` read ONLY settings.local.json.
 * This repo — like any project that version-controls its Massu hooks — wires all lifecycle
 * hooks in the COMMITTED `settings.json` and keeps no hooks in settings.local.json. Claude Code
 * reads/merges both files, so the hooks fire fine; but doctor reported "No hooks configured" and
 * an overall UNHEALTHY verdict on a fully-working install. The fix makes both checks read the
 * union of settings.json + settings.local.json.
 *
 * This test asserts against THIS repo's real config: hooks live in settings.json (not local),
 * so a revert to the settings.local.json-only logic would flip both checks to `fail` here.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { checkHooksConfig, checkShellHooksWired } from '../commands/doctor.ts';
import { getResolvedPaths } from '../config.ts';

describe('doctor hooks checks — recognize settings.json (not only settings.local.json)', () => {
  const { settingsPath, settingsLocalPath } = getResolvedPaths();

  it('this repo wires hooks in settings.json and NOT in settings.local.json (the bug scenario)', () => {
    expect(existsSync(settingsPath)).toBe(true);
    const sj = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(Object.keys(sj.hooks ?? {}).length).toBeGreaterThan(0);
    // settings.local.json either absent or has no hooks block — otherwise this isn't the
    // scenario the fix targets. (Guards that the test stays meaningful.)
    const localHooks = existsSync(settingsLocalPath)
      ? (JSON.parse(readFileSync(settingsLocalPath, 'utf-8')).hooks ?? {})
      : {};
    expect(Object.keys(localHooks).length).toBe(0);
  });

  it('checkHooksConfig PASSES and attributes the count to settings.json', () => {
    const r = checkHooksConfig('');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/settings\.json/);
    expect(r.detail).toMatch(/\d+ hooks configured/);
  });

  it('checkShellHooksWired PASSES on settings.json-wired lifecycle hooks', () => {
    const r = checkShellHooksWired('');
    expect(r.status).toBe('pass');
  });
});

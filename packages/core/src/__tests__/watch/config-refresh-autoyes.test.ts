// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3a Phase 6: config-refresh autoYes flag.
 *
 * The watcher daemon (stdin detached) and `--yes` CLI flag both pass
 * autoYes:true to skip the non-TTY bail (305-315) AND the confirm gate
 * (319-324). Test forces stdin.isTTY=false and asserts:
 *   - autoYes=false: returns dryRun-like result with "non-interactive" message
 *   - autoYes=true: actually applies and `applied: true`
 */

import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { runConfigRefresh } from '../../commands/config-refresh.ts';

const FIXTURES_ROOT = resolve(__dirname, '..', '..', 'detect', '__tests__', 'fixtures');
const created: string[] = [];

afterAll(() => {
  for (const d of created) {
    if (existsSync(d)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

function stageFixture(name: string): string {
  const src = resolve(FIXTURES_ROOT, name);
  const dest = mkdtempSync(resolve(tmpdir(), `massu-autoyes-${name}-`));
  created.push(dest);
  cpSync(src, dest, { recursive: true });
  return dest;
}

function writeStaleConfig(dir: string): void {
  const baseline = {
    project: { name: 'stale', root: 'auto' },
    framework: { type: 'unknown', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: { '@': 'src' } },
    toolPrefix: 'massu',
    domains: [],
    rules: [{ pattern: 'src/**', rules: ['custom-rule'] }],
  };
  writeFileSync(resolve(dir, 'massu.config.yaml'), yamlStringify(baseline), 'utf-8');
}

describe('config-refresh autoYes (Plan 3a Phase 6)', () => {
  it('autoYes=false + non-TTY stdin: bails with non-interactive message', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const res = await runConfigRefresh({
        cwd: dir,
        silent: true,
        autoYes: false,
        skipCommands: true,
      });
      expect(res.exitCode).toBe(0);
      expect(res.applied).toBe(false);
      expect(res.message).toMatch(/non-interactive/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('autoYes=true + non-TTY stdin: applies and writes the new config', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const res = await runConfigRefresh({
        cwd: dir,
        silent: true,
        autoYes: true,
        skipCommands: true,
      });
      expect(res.exitCode).toBe(0);
      expect(res.applied).toBe(true);

      const written = yamlParse(readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8'));
      // Detector should have updated framework.type away from "unknown".
      expect(written.framework.type).not.toBe('unknown');
      // User-authored rules survive.
      expect(written.rules).toEqual([{ pattern: 'src/**', rules: ['custom-rule'] }]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('autoYes=true + skipCommands=true: NO recursive installAll happens', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await runConfigRefresh({
        cwd: dir,
        silent: true,
        autoYes: true,
        skipCommands: true,
      });
      // installAll wasn't called -> no .claude/commands/ dir
      expect(existsSync(resolve(dir, '.claude', 'commands'))).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('autoYes=true + skipCommands=false: single installAll runs under withInstallLock (manual --yes path)', async () => {
    // Iter-4 enhancement: this is the human `npx massu config refresh --yes`
    // path. autoYes bypasses the confirm gate AND skipCommands stays false,
    // so the recursive installAll call inside runConfigRefresh executes
    // exactly once under the lock. Verifies that .claude/commands/ is
    // populated in a single refresh cycle and that subsequent invocations
    // don't deadlock on the lock (proper-lockfile.lockSync is non-reentrant
    // — a second nested install would throw ELOCKED).
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const res = await runConfigRefresh({
        cwd: dir,
        silent: true,
        autoYes: true,
        skipCommands: false,
      });
      expect(res.exitCode).toBe(0);
      expect(res.applied).toBe(true);
      // installAll DID run -> .claude/commands/ exists.
      expect(existsSync(resolve(dir, '.claude', 'commands'))).toBe(true);

      // Lock file should be released after the call returns.
      const lockPath = resolve(dir, '.massu', 'installAll.lock');
      // The lock dir/file may exist (proper-lockfile leaves the directory
      // in place after release) or may not (if cleanup removed it). Either
      // way, the .pid sidecar must NOT exist — withInstallLock removes it
      // in its finally block.
      expect(existsSync(`${lockPath}.pid`)).toBe(false);

      // Re-run: exit 0 (no-op since YAML now matches detection), no deadlock.
      const res2 = await runConfigRefresh({
        cwd: dir,
        silent: true,
        autoYes: true,
        skipCommands: false,
      });
      expect(res2.exitCode).toBe(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });
});

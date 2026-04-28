// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3a Phase 6 — session-start hook watcher banner tests.
 *
 * Spawns the COMPILED dist/hooks/session-start.js with a fake watch-state.json
 * and asserts:
 *   1. live + fresh -> watcher banner shown, drift banner suppressed
 *   2. dead pid    -> watcher banner suppressed (drift banner may show)
 *   3. stale (>24h refresh) -> watcher banner suppressed
 *   4. MASSU_DRIFT_QUIET=1  -> watcher banner suppressed (env wins)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { stringify as yamlStringify } from 'yaml';

const HOOK = resolve(__dirname, '..', '..', '..', 'dist', 'hooks', 'session-start.js');
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
  const dest = mkdtempSync(resolve(tmpdir(), `massu-watcher-banner-${name}-`));
  created.push(dest);
  cpSync(src, dest, { recursive: true });
  return dest;
}

function writeBaseConfig(dir: string, withFingerprint: string | null): void {
  const cfg: Record<string, unknown> = {
    project: { name: 'x', root: 'auto' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: { '@': 'src' } },
    toolPrefix: 'massu',
    domains: [],
    rules: [],
  };
  if (withFingerprint !== null) {
    cfg.detection = { fingerprint: withFingerprint };
  }
  writeFileSync(resolve(dir, 'massu.config.yaml'), yamlStringify(cfg), 'utf-8');
}

function writeWatchState(dir: string, state: Record<string, unknown>): void {
  mkdirSync(resolve(dir, '.massu'), { recursive: true });
  writeFileSync(
    resolve(dir, '.massu', 'watch-state.json'),
    JSON.stringify({ schema_version: 1, ...state }, null, 2),
    'utf-8',
  );
}

function runHook(cwd: string, env: NodeJS.ProcessEnv = {}): { stdout: string; code: number | null } {
  const input = JSON.stringify({
    session_id: 'watcher-banner-test',
    transcript_path: '',
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  const r = spawnSync('node', [HOOK], {
    encoding: 'utf-8',
    cwd,
    input,
    timeout: 15000,
    env: { ...process.env, HOME: cwd, ...env },
  });
  return { stdout: r.stdout ?? '', code: r.status };
}

describe('session-start watcher banner (Plan 3a Phase 6)', () => {
  beforeAll(() => {
    if (!existsSync(HOOK)) {
      // eslint-disable-next-line no-console
      console.warn(`[session-start-watcher.test] ${HOOK} missing; build:hooks not run`);
    }
  });

  it('shows watcher banner and suppresses drift banner when watcher is live + fresh', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    // Use a STALE fingerprint so the drift banner WOULD fire absent the watcher.
    writeBaseConfig(dir, '0'.repeat(64));
    writeWatchState(dir, {
      daemonPid: process.pid, // current process is alive
      lastRefreshAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastError: null,
      lastFingerprint: '0'.repeat(64),
      tickedAt: new Date().toISOString(),
    });

    const { stdout } = runHook(dir);
    expect(stdout).toMatch(/Massu Watcher/);
    expect(stdout).toMatch(/watcher running, last refresh:/);
    expect(stdout).not.toMatch(/Massu Config Drift/);
  });

  it('suppresses watcher banner when daemon pid is dead', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    writeBaseConfig(dir, null); // no fingerprint -> drift can't fire either
    writeWatchState(dir, {
      daemonPid: 2_000_000_000, // virtually-guaranteed dead
      lastRefreshAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      lastError: null,
      lastFingerprint: null,
      tickedAt: new Date().toISOString(),
    });

    const { stdout } = runHook(dir);
    expect(stdout).not.toMatch(/Massu Watcher/);
  });

  it('suppresses watcher banner when last refresh > 24h ago', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    writeBaseConfig(dir, null);
    writeWatchState(dir, {
      daemonPid: process.pid,
      lastRefreshAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      startedAt: new Date().toISOString(),
      lastError: null,
      lastFingerprint: null,
      tickedAt: new Date().toISOString(),
    });

    const { stdout } = runHook(dir);
    expect(stdout).not.toMatch(/Massu Watcher/);
  });

  it('MASSU_DRIFT_QUIET=1 suppresses watcher banner (env override wins)', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    writeBaseConfig(dir, null);
    writeWatchState(dir, {
      daemonPid: process.pid,
      lastRefreshAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      lastError: null,
      lastFingerprint: null,
      tickedAt: new Date().toISOString(),
    });

    const { stdout } = runHook(dir, { MASSU_DRIFT_QUIET: '1' });
    expect(stdout).not.toMatch(/Massu Watcher/);
    expect(stdout).not.toMatch(/Massu Config Drift/);
  });

  it('emits NO watcher banner and shows drift banner when watch-state.json is absent', () => {
    if (!existsSync(HOOK)) return;
    const dir = stageFixture('ts-nextjs');
    writeBaseConfig(dir, '0'.repeat(64)); // stale fingerprint -> drift banner fires
    // No watch-state.json written.
    const { stdout } = runHook(dir);
    expect(stdout).not.toMatch(/Massu Watcher/);
    expect(stdout).toMatch(/Massu Config Drift/);
  });
});

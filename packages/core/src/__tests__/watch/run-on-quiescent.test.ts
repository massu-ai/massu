// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3a Phase 6 — `runOnQuiescent` integration test.
 *
 * Iter-3 (third pass) G3-iter3-E1: prior tests covered the daemon's
 * quiescence FSM and `readRefreshLog` parsing in isolation. This file
 * exercises the actual quiescence callback end-to-end against a temp
 * fixture and asserts:
 *   1. `runOnQuiescent` calls `appendRefreshLog` exactly once per refresh
 *   2. updateState writes `lastFingerprint` + `lastRefreshAt`
 *   3. a no-op refresh (same fingerprint) skips both the append and the
 *      state mutation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { runOnQuiescent, readRefreshLog } from '../../commands/watch.ts';
import { readState, updateState } from '../../watch/state.ts';
import { resetConfig } from '../../config.ts';

const FIXTURES_ROOT = resolve(__dirname, '..', '..', 'detect', '__tests__', 'fixtures');

function stageFixture(name: string): string {
  const src = resolve(FIXTURES_ROOT, name);
  const dest = mkdtempSync(resolve(tmpdir(), `massu-runOnQuiescent-${name}-`));
  cpSync(src, dest, { recursive: true });
  // Write a minimal massu.config.yaml so runConfigRefresh has a baseline.
  const cfg: Record<string, unknown> = {
    project: { name: 'rqt', root: 'auto' },
    framework: { type: 'unknown', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: { '@': 'src' } },
    toolPrefix: 'massu',
    domains: [],
    rules: [],
  };
  require('fs').writeFileSync(resolve(dest, 'massu.config.yaml'), yamlStringify(cfg), 'utf-8');
  return dest;
}

describe('runOnQuiescent (Plan 3a Phase 6 integration)', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = stageFixture('ts-nextjs');
    process.chdir(dir);
    resetConfig();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
  });

  it('appends exactly one refresh-log event when the fingerprint changes', async () => {
    // No prior fingerprint → first refresh always counts as a change.
    await runOnQuiescent(dir);

    const events = readRefreshLog(dir, 100, { warn: () => {} });
    expect(events).toHaveLength(1);
    expect(events[0].toFingerprint).toMatch(/[a-f0-9]+/i);
    expect(events[0].fromFingerprint).toBeNull();

    // State must reflect the same fingerprint.
    const state = readState(dir);
    expect(state.lastFingerprint).toBe(events[0].toFingerprint);
    expect(state.lastRefreshAt).toBeTypeOf('string');
    expect(state.lastError).toBeNull();
  });

  it('does NOT append a second event when the stack is unchanged (idempotent)', async () => {
    // First refresh — stamps the fingerprint.
    await runOnQuiescent(dir);
    const after1 = readRefreshLog(dir, 100, { warn: () => {} });
    expect(after1).toHaveLength(1);

    // Second refresh — fingerprint unchanged → bail before append.
    await runOnQuiescent(dir);
    const after2 = readRefreshLog(dir, 100, { warn: () => {} });
    expect(after2).toHaveLength(1);
  });

  it('records lastError when a forced upstream failure occurs (writeStateAtomic survives)', async () => {
    // Pre-populate state so the change branch fires; then corrupt the
    // config to trigger runConfigRefresh's error path. We expect the state's
    // lastError to be a non-empty string after the call returns gracefully.
    updateState(dir, { lastFingerprint: 'sentinel-existing' });

    require('fs').writeFileSync(resolve(dir, 'massu.config.yaml'), 'not: [valid: yaml: here', 'utf-8');
    resetConfig();

    // Should not throw — runOnQuiescent catches and persists.
    await runOnQuiescent(dir);

    const state = readState(dir);
    // The detection fingerprint differs from the seeded sentinel, so the
    // change branch fires; runConfigRefresh fails to parse the corrupt YAML
    // and returns exitCode=2 with a non-empty message; runOnQuiescent then
    // calls updateState({ lastError }) with that message. Assert that path
    // actually writes a reason string instead of leaving lastError null.
    expect(state.lastError).toBeTypeOf('string');
    expect(state.lastError).not.toBeNull();
    expect((state.lastError as string).length).toBeGreaterThan(0);
    // refresh-log should NOT have appended on this failed refresh path.
    const events = readRefreshLog(dir, 100, { warn: () => {} });
    // The successful first run hadn't happened; refreshed config write
    // failed; so we expect 0 events appended.
    expect(events.filter((e) => e.toFingerprint).length).toBe(0);
  });

  it('refresh-log file lives at .massu/refresh-log.jsonl', async () => {
    await runOnQuiescent(dir);
    const expectedPath = resolve(dir, '.massu', 'refresh-log.jsonl');
    expect(existsSync(expectedPath)).toBe(true);
    const raw = readFileSync(expectedPath, 'utf-8');
    expect(raw).toMatch(/"toFingerprint"/);
  });
});

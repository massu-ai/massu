// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { getConfig, resetConfig } from '../config.ts';

/**
 * Regression guard for the 2026-07-20 cloud-sync stall.
 *
 * Two defects let a workspace's sync queue amplify indefinitely while every knob
 * appeared to be set correctly:
 *
 *   1. `cloud.requestTimeoutMs` was READ by cloud-sync.ts but ABSENT from
 *      CloudConfigSchema. zod strips unknown keys, so the value set in
 *      massu.config.yaml never reached the reader and the 8s default could not be
 *      raised. Measured: a 423-observation payload needs 9.2s, so every sync timed
 *      out, requeued, and grew the queue.
 *
 *   2. `enabled` used `.default(false)`. Declaring a `cloud:` block to set ANY other
 *      key therefore produced `enabled: false`, which overrode the `enabled: true`
 *      auto-enable via object spread — so tuning the timeout silently turned cloud
 *      sync OFF entirely.
 *
 * Both are config-shape bugs invisible to type checking and to `validate-config`
 * (which reported "valid" for the very config that disabled sync).
 */

const TEST_DIR = resolve(tmpdir(), `massu-test-cloud-knobs-${process.pid}`);
const CONFIG_PATH = resolve(TEST_DIR, 'massu.config.yaml');

const BASE = `schema_version: 2
project:
  name: test
framework:
  type: typescript
paths:
  source: src
`;

function writeConfig(extra: string) {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, BASE + extra, 'utf-8');
}

describe('cloud config knobs', () => {
  const originalCwd = process.cwd();
  const originalKey = process.env.MASSU_API_KEY;

  beforeEach(() => {
    resetConfig();
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
    // A resolved key is what triggers the auto-enable branch under test.
    process.env.MASSU_API_KEY = 'ms_live_testkey_not_a_real_credential';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetConfig();
    if (originalKey === undefined) delete process.env.MASSU_API_KEY;
    else process.env.MASSU_API_KEY = originalKey;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('preserves requestTimeoutMs through schema parsing', () => {
    writeConfig(`cloud:\n  requestTimeoutMs: 18000\n`);
    const cloud = getConfig().cloud as { requestTimeoutMs?: number } | undefined;
    // Pre-fix this was `undefined` — zod stripped the unknown key.
    expect(cloud?.requestTimeoutMs).toBe(18000);
  });

  it('does NOT disable sync when a cloud block sets only requestTimeoutMs', () => {
    writeConfig(`cloud:\n  requestTimeoutMs: 18000\n`);
    // Pre-fix this was `false`: `.default(false)` won the spread and killed sync.
    expect(getConfig().cloud?.enabled).toBe(true);
  });

  it('still honours an EXPLICIT enabled: false', () => {
    writeConfig(`cloud:\n  enabled: false\n  requestTimeoutMs: 18000\n`);
    expect(getConfig().cloud?.enabled).toBe(false);
  });

  it('auto-enables when a key resolves and no cloud block is declared', () => {
    writeConfig('');
    expect(getConfig().cloud?.enabled).toBe(true);
  });

  it('rejects a requestTimeoutMs above the 20s sync deadline', () => {
    writeConfig(`cloud:\n  requestTimeoutMs: 60000\n`);
    // Exceeding SYNC_DEADLINE_MS is meaningless — the deadline clamps every attempt.
    expect(() => getConfig()).toThrow();
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfig, resetConfig } from '../config.ts';

/**
 * Plan #2 P0-003: Round-trip tests for the `detected:` config block.
 *
 * The block is detector-owned (refreshed every `init`/`config refresh`) and
 * declared `.passthrough()` so future detector fields don't break parsing
 * of older configs. These tests assert:
 *   1. Empty/absent `detected:` returns undefined.
 *   2. Partial `detected:` (only one language present) parses without forcing
 *      the other language keys to exist.
 *   3. Full `detected:` round-trips with typed access — no `as any`, no
 *      `// @ts-ignore`.
 */

const TEST_DIR = resolve(__dirname, '../test-config-detected-tmp');
const CONFIG_PATH = resolve(TEST_DIR, 'massu.config.yaml');

function writeConfig(yaml: string): void {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
}

describe('Config: detected block (Plan #2)', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetConfig();
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('absent detected block leaves config.detected undefined', () => {
    writeConfig(`
project:
  name: test-project
toolPrefix: tp
`);
    const config = getConfig();
    expect(config.detected).toBeUndefined();
  });

  it('empty detected block parses to an empty object', () => {
    writeConfig(`
project:
  name: test-project
detected: {}
`);
    const config = getConfig();
    expect(config.detected).toBeDefined();
    expect(typeof config.detected).toBe('object');
  });

  it('partial detected block (python only) round-trips', () => {
    writeConfig(`
project:
  name: test-project
detected:
  python:
    auth_dep: require_tier_or_guardian
    api_prefix_base: /api
`);
    const config = getConfig();
    // Type-safe access — no `as any`, no // @ts-ignore.
    const pythonBlock = config.detected?.python as
      | { auth_dep?: string; api_prefix_base?: string }
      | undefined;
    expect(pythonBlock?.auth_dep).toBe('require_tier_or_guardian');
    expect(pythonBlock?.api_prefix_base).toBe('/api');
    expect(config.detected?.swift).toBeUndefined();
  });

  it('full detected block (python + swift + typescript) round-trips', () => {
    writeConfig(`
project:
  name: test-project
detected:
  python:
    auth_dep: get_current_user
    api_prefix_base: /v1
    test_async_pattern: "@pytest.mark.asyncio"
  swift:
    api_client_class: APIClient
    biometric_policy: deviceOwnerAuthenticationWithBiometrics
  typescript:
    trpc_router_builder: createTRPCRouter
`);
    const config = getConfig();
    const py = config.detected?.python as Record<string, string> | undefined;
    const sw = config.detected?.swift as Record<string, string> | undefined;
    const ts = config.detected?.typescript as Record<string, string> | undefined;

    expect(py?.auth_dep).toBe('get_current_user');
    expect(py?.api_prefix_base).toBe('/v1');
    expect(py?.test_async_pattern).toBe('@pytest.mark.asyncio');
    expect(sw?.api_client_class).toBe('APIClient');
    expect(sw?.biometric_policy).toBe('deviceOwnerAuthenticationWithBiometrics');
    expect(ts?.trpc_router_builder).toBe('createTRPCRouter');
  });

  it('passthrough preserves unknown subkeys (forward-compat)', () => {
    writeConfig(`
project:
  name: test-project
detected:
  python:
    auth_dep: get_current_user
    future_field_v3: tomorrow's data
  someNewLanguage:
    arbitrary_key: arbitrary_value
`);
    const config = getConfig();
    // Cast through Record<string, unknown> to demonstrate that unknown
    // subkeys survive the .passthrough() — without claiming any specific
    // shape via a type assertion bypass.
    const det = config.detected as Record<string, unknown> | undefined;
    expect(det).toBeDefined();
    const py = det?.python as Record<string, string> | undefined;
    expect(py?.auth_dep).toBe('get_current_user');
    expect(py?.future_field_v3).toBe("tomorrow's data");
    const someNew = det?.someNewLanguage as Record<string, string> | undefined;
    expect(someNew?.arbitrary_key).toBe('arbitrary_value');
  });

  it('detected block coexists with framework, paths, and detection blocks', () => {
    writeConfig(`
project:
  name: test-project
framework:
  type: python
  primary: python
paths:
  source: src
detection:
  rules: {}
detected:
  python:
    auth_dep: require_role
`);
    const config = getConfig();
    expect(config.framework.primary).toBe('python');
    expect(config.paths.source).toBe('src');
    expect(config.detection).toBeDefined();
    const py = config.detected?.python as Record<string, string> | undefined;
    expect(py?.auth_dep).toBe('require_role');
  });
});

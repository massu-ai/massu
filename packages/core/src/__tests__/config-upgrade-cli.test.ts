// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-003 tests: `config upgrade` CLI command behavior (read/write + .bak + rollback).
 * The pure `migrateV1ToV2` migration logic is covered in config-upgrade.test.ts.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { runConfigUpgrade } from '../commands/config-upgrade.ts';

const FIXTURES_ROOT = resolve(__dirname, '..', 'detect', '__tests__', 'fixtures');
const created: string[] = [];

afterAll(() => {
  for (const d of created) {
    if (existsSync(d)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

function stageFixture(name: string): string {
  const src = resolve(FIXTURES_ROOT, name);
  const dest = mkdtempSync(resolve(tmpdir(), `massu-upgrade-cli-${name}-`));
  created.push(dest);
  cpSync(src, dest, { recursive: true });
  return dest;
}

function writeV1Config(dir: string, overrides: Record<string, unknown> = {}): string {
  const v1: Record<string, unknown> = {
    project: { name: 'legacy', root: 'auto' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: { '@': 'src' } },
    toolPrefix: 'massu',
    domains: [],
    rules: [{ pattern: 'src/**/*.ts', rules: ['Hand-edited rule'] }],
    ...overrides,
  };
  const p = resolve(dir, 'massu.config.yaml');
  writeFileSync(p, yamlStringify(v1), 'utf-8');
  return p;
}

describe('config upgrade CLI', () => {
  it('migrates a v1 config to schema_version=2 and creates .bak', async () => {
    const dir = stageFixture('ts-nextjs');
    const configPath = writeV1Config(dir);
    const res = await runConfigUpgrade({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(0);
    expect(res.action).toBe('migrated');
    const upgraded = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(upgraded.schema_version).toBe(2);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
  });

  it('preserves hand-edited rules byte-for-byte across upgrade', async () => {
    const dir = stageFixture('ts-nextjs');
    const configPath = writeV1Config(dir);
    const originalRules = (yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>).rules;
    await runConfigUpgrade({ cwd: dir, silent: true });
    const upgraded = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(upgraded.rules).toEqual(originalRules);
  });

  it('stamps detection.fingerprint on upgrade', async () => {
    const dir = stageFixture('ts-nextjs');
    const configPath = writeV1Config(dir);
    await runConfigUpgrade({ cwd: dir, silent: true });
    const upgraded = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const det = upgraded.detection as Record<string, unknown> | undefined;
    expect(typeof det?.fingerprint).toBe('string');
    expect((det?.fingerprint as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent on an already-v2 config', async () => {
    const dir = stageFixture('ts-nextjs');
    writeV1Config(dir);
    await runConfigUpgrade({ cwd: dir, silent: true });
    const firstRead = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
    const second = await runConfigUpgrade({ cwd: dir, silent: true });
    expect(second.action).toBe('already-current');
    const secondRead = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
    expect(secondRead).toBe(firstRead);
  });

  it('--rollback restores the .bak file and deletes it', async () => {
    const dir = stageFixture('ts-nextjs');
    const configPath = writeV1Config(dir);
    const originalBytes = readFileSync(configPath, 'utf-8');
    await runConfigUpgrade({ cwd: dir, silent: true });
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    const res = await runConfigUpgrade({ cwd: dir, rollback: true, silent: true });
    expect(res.exitCode).toBe(0);
    expect(res.action).toBe('rolled-back');
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(originalBytes);
  });

  it('--rollback with no .bak returns exit 1', async () => {
    const dir = stageFixture('ts-nextjs');
    writeV1Config(dir);
    const res = await runConfigUpgrade({ cwd: dir, rollback: true, silent: true });
    expect(res.exitCode).toBe(1);
    expect(res.action).toBe('none');
  });

  it('--ci flag does not prompt and succeeds non-interactively', async () => {
    const dir = stageFixture('ts-nextjs');
    writeV1Config(dir);
    const res = await runConfigUpgrade({ cwd: dir, ci: true, silent: true });
    expect(res.exitCode).toBe(0);
    expect(res.action).toBe('migrated');
  });

  it('returns exit 1 when config file does not exist', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-upgrade-missing-'));
    created.push(dir);
    const res = await runConfigUpgrade({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(1);
  });

  // P2-004: integration smoke — exec upgrade against a temp copy of the
  // example-project-incident fixture; assert no key loss at any depth.
  it('example-project-incident-20260419 fixture: zero key loss end-to-end through CLI', async () => {
    const fixtureRoot = resolve(
      __dirname,
      'fixtures',
      'stale-configs',
      'example-project-incident-20260419'
    );
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-upgrade-example-project-incident-'));
    created.push(dir);
    // Copy fixture repo (for detection) + config into tmp dir.
    cpSync(resolve(fixtureRoot, 'repo'), dir, { recursive: true });
    const fixtureConfigBytes = readFileSync(
      resolve(fixtureRoot, 'massu.config.yaml'),
      'utf-8'
    );
    writeFileSync(resolve(dir, 'massu.config.yaml'), fixtureConfigBytes, 'utf-8');

    const before = yamlParse(fixtureConfigBytes) as Record<string, unknown>;
    const beforeKeys = new Set(Object.keys(before));

    const res = await runConfigUpgrade({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(0);

    const after = yamlParse(
      readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8')
    ) as Record<string, unknown>;
    const afterKeys = new Set(Object.keys(after));

    // Assert no top-level key removals. Every key present before must still be present after.
    for (const k of beforeKeys) {
      expect(afterKeys.has(k), `top-level key "${k}" was dropped by upgrade`).toBe(true);
    }
    // Assert nested preservation on the three example-project-shaped blocks.
    expect((after.project as Record<string, unknown>).description).toBe(
      (before.project as Record<string, unknown>).description
    );
    expect(after.services).toEqual(before.services);
    expect(after.north_stars).toEqual(before.north_stars);
    expect(after.workflow).toEqual(before.workflow);
    expect(after.toolPrefix).toBe('example-project');
  });
});

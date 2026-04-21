// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P5-003 tests: `config check-drift` behavior.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { runConfigCheckDrift } from '../commands/config-check-drift.ts';
import { runConfigRefresh } from '../commands/config-refresh.ts';

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
  const dest = mkdtempSync(resolve(tmpdir(), `massu-drift-${name}-`));
  created.push(dest);
  cpSync(src, dest, { recursive: true });
  return dest;
}

describe('config check-drift', () => {
  it('returns exit 2 when massu.config.yaml is missing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-drift-missing-'));
    created.push(dir);
    const res = await runConfigCheckDrift({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(2);
    expect(res.drifted).toBe(false);
  });

  it('returns exit 2 on unparseable YAML', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-drift-broken-'));
    created.push(dir);
    writeFileSync(resolve(dir, 'massu.config.yaml'), 'not: [[\n  valid\t', 'utf-8');
    const res = await runConfigCheckDrift({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(2);
  });

  it('returns exit 1 when stored fingerprint does not match current', async () => {
    const dir = stageFixture('ts-nextjs');
    // Seed a config with a nonsense fingerprint so it never matches.
    writeFileSync(
      resolve(dir, 'massu.config.yaml'),
      yamlStringify({
        project: { name: 'x', root: 'auto' },
        framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
        paths: { source: 'src', aliases: { '@': 'src' } },
        toolPrefix: 'massu',
        domains: [],
        rules: [],
        detection: { fingerprint: '0'.repeat(64) },
      }),
      'utf-8'
    );
    const res = await runConfigCheckDrift({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(1);
    expect(res.drifted).toBe(true);
    expect(res.storedFingerprint).toBe('0'.repeat(64));
    expect(res.currentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(res.currentFingerprint).not.toBe(res.storedFingerprint);
  });

  it('returns exit 0 when config fully reflects detected stack (fingerprint + languages match)', async () => {
    const dir = stageFixture('ts-nextjs');
    // Build an accurate v2 config directly from the detector, then write it.
    // This is the state left by `massu init` / `massu config refresh --apply`.
    const { runDetection } = await import('../detect/index.ts');
    const { buildConfigFromDetection, renderConfigYaml } = await import('../commands/init.ts');
    const detection = await runDetection(dir);
    const cfg = buildConfigFromDetection({ projectRoot: dir, detection, projectName: 'x' });
    writeFileSync(resolve(dir, 'massu.config.yaml'), renderConfigYaml(cfg), 'utf-8');
    const res = await runConfigCheckDrift({ cwd: dir, silent: true });
    expect(res.exitCode).toBe(0);
    expect(res.drifted).toBe(false);
  });

  it('--verbose includes change list in result', async () => {
    const dir = stageFixture('ts-nextjs');
    writeFileSync(
      resolve(dir, 'massu.config.yaml'),
      yamlStringify({
        project: { name: 'x', root: 'auto' },
        // Mis-declared as python — detection will see typescript.
        framework: {
          type: 'python',
          router: 'none',
          orm: 'none',
          ui: 'none',
          languages: { python: { framework: 'fastapi' } },
        },
        paths: { source: 'src', aliases: { '@': 'src' } },
        toolPrefix: 'massu',
        domains: [],
        rules: [],
        detection: { fingerprint: '0'.repeat(64) },
      }),
      'utf-8'
    );
    const res = await runConfigCheckDrift({ cwd: dir, verbose: true, silent: true });
    expect(res.exitCode).toBe(1);
    expect(res.changes.length).toBeGreaterThan(0);
  });
});

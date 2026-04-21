// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-004: Drift detection logic tests.
 *
 * Exercises `computeFingerprint` + `detectDrift` pure functions against
 * synthesized DetectionResult + config object pairs. Phase 5 runtime is NOT
 * in the MVP cut; these tests verify the logic that Phase 5 will wire up.
 */

import { describe, it, expect } from 'vitest';
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
import { runDetection } from '../detect/index.ts';
import { computeFingerprint, detectDrift } from '../detect/drift.ts';
import { buildConfigFromDetection } from '../commands/init.ts';

const FIXTURES_ROOT = resolve(__dirname, '..', 'detect', '__tests__', 'fixtures');

function stage(name: string): string {
  const dest = mkdtempSync(resolve(tmpdir(), `drift-${name}-`));
  cpSync(resolve(FIXTURES_ROOT, name), dest, { recursive: true });
  // Strip the sibling expected config so detection isn't confused.
  const exp = resolve(dest, 'expected.massu.config.yaml');
  if (existsSync(exp)) {
    try { rmSync(exp); } catch { /* ignore */ }
  }
  return dest;
}

function cleanup(dir: string): void {
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('P7-004: detectDrift / computeFingerprint', () => {
  it('no drift: fresh repo matches its own generated config', async () => {
    const dir = stage('ts-nextjs');
    try {
      const det = await runDetection(dir);
      const cfg = buildConfigFromDetection({ projectRoot: dir, detection: det });
      const report = detectDrift(cfg, det);
      expect(report.drifted).toBe(false);
      expect(report.changes).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('adds a new language → drift reported', async () => {
    const dir = stage('ts-nextjs');
    try {
      const detBefore = await runDetection(dir);
      const cfg = buildConfigFromDetection({ projectRoot: dir, detection: detBefore });

      // Mutate: add a python manifest.
      writeFileSync(
        resolve(dir, 'pyproject.toml'),
        '[project]\nname="new-py"\ndependencies=["fastapi","pytest"]\n',
        'utf-8'
      );
      mkdirSync(resolve(dir, 'api'), { recursive: true });
      writeFileSync(resolve(dir, 'api', 'main.py'), 'from fastapi import FastAPI\napp=FastAPI()\n', 'utf-8');

      const detAfter = await runDetection(dir);
      const report = detectDrift(cfg, detAfter);
      expect(report.drifted).toBe(true);
      const langsChange = report.changes.find((c) => c.field === 'framework.languages');
      expect(langsChange).toBeDefined();
      expect(langsChange?.after).toContain('python');
    } finally {
      cleanup(dir);
    }
  });

  it('changes test framework → drift reported', async () => {
    const dir = stage('ts-nextjs');
    try {
      const det = await runDetection(dir);
      const cfg = buildConfigFromDetection({ projectRoot: dir, detection: det });
      const langsBlock = (cfg.framework as Record<string, unknown>).languages as Record<
        string, Record<string, unknown>
      >;
      // Pretend the user's config said jest even though package.json says vitest.
      langsBlock.typescript.test_framework = 'jest';
      const report = detectDrift(cfg, det);
      expect(report.drifted).toBe(true);
      expect(
        report.changes.some((c) => c.field === 'framework.languages.typescript.test_framework')
      ).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('new manifest file → fingerprint changes', async () => {
    const dir = stage('ts-nextjs');
    try {
      const detBefore = await runDetection(dir);
      const fpBefore = computeFingerprint(detBefore);
      // Add a Cargo.toml to introduce a new manifest path.
      writeFileSync(
        resolve(dir, 'Cargo.toml'),
        '[package]\nname="x"\nversion="0.1.0"\nedition="2021"\n\n[dependencies]\nactix-web="4"\n',
        'utf-8'
      );
      mkdirSync(resolve(dir, 'rust-src'), { recursive: true });
      writeFileSync(resolve(dir, 'rust-src', 'main.rs'), 'fn main(){}\n', 'utf-8');
      const detAfter = await runDetection(dir);
      const fpAfter = computeFingerprint(detAfter);
      expect(fpAfter).not.toBe(fpBefore);
    } finally {
      cleanup(dir);
    }
  });

  it('monorepo workspace added → drift reported against a workspace-listing config', async () => {
    const dir = stage('monorepo-turbo');
    try {
      const detBefore = await runDetection(dir);
      // Build a manual config that records the current workspace list
      // (buildConfigFromDetection doesn't emit `monorepo.workspaces`; we emulate a
      // user-authored config here).
      const workspacesBefore = detBefore.monorepo.packages.map((p) => p.path).sort();
      const cfg: Record<string, unknown> = {
        schema_version: 2,
        project: { name: 'monorepo-turbo-fixture', root: 'auto' },
        framework: {
          type: 'typescript',
          router: 'none',
          orm: 'none',
          ui: 'next',
          languages: {
            typescript: { framework: 'next', test_framework: null },
          },
        },
        paths: { source: 'apps', aliases: { '@': 'apps' } },
        toolPrefix: 'massu',
        domains: [],
        rules: [],
        monorepo: { workspaces: workspacesBefore },
      };

      // No drift yet.
      const noDrift = detectDrift(cfg, detBefore);
      expect(noDrift.changes.some((c) => c.field === 'monorepo.workspaces')).toBe(false);

      // Add a new workspace
      mkdirSync(resolve(dir, 'apps/docs/src'), { recursive: true });
      writeFileSync(
        resolve(dir, 'apps/docs', 'package.json'),
        '{"name":"docs","dependencies":{"react":"^18.0.0"},"devDependencies":{"typescript":"^5.0.0"}}',
        'utf-8'
      );
      writeFileSync(resolve(dir, 'apps/docs', 'tsconfig.json'), '{"compilerOptions":{"strict":true}}', 'utf-8');
      writeFileSync(resolve(dir, 'apps/docs/src', 'index.ts'), 'export {};\n', 'utf-8');

      const detAfter = await runDetection(dir);
      const report = detectDrift(cfg, detAfter);
      expect(report.drifted).toBe(true);
      expect(report.changes.some((c) => c.field === 'monorepo.workspaces')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('idempotent: running detectDrift twice on unchanged inputs yields the same report', async () => {
    const dir = stage('python-fastapi');
    try {
      const det = await runDetection(dir);
      const cfg = buildConfigFromDetection({ projectRoot: dir, detection: det });
      const a = detectDrift(cfg, det);
      const b = detectDrift(cfg, det);
      expect(a).toEqual(b);
      expect(a.drifted).toBe(false);
      // Fingerprint is deterministic on re-run.
      expect(computeFingerprint(det)).toBe(computeFingerprint(det));
    } finally {
      cleanup(dir);
    }
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { runDetection } from '../detect/index.ts';

const __filename_orch = fileURLToPath(import.meta.url);
// Test file lives at packages/core/src/__tests__/detect.orchestrator.test.ts —
// four levels up is the repo root on any machine (dev or CI runner).
const REPO_ROOT = resolve(__filename_orch, '../../../../..');

function touch(root: string, rel: string, contents = ''): void {
  const path = join(root, rel);
  const parts = rel.split('/');
  if (parts.length > 1) {
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(path, contents);
}

describe('detect/orchestrator (runDetection)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-orch-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a DetectionResult with all six composed fields', async () => {
    // Python + TypeScript monorepo (turbo+pnpm)
    touch(root, 'turbo.json', '{}');
    touch(
      root,
      'pnpm-workspace.yaml',
      'packages:\n  - apps/*\n  - packages/*\n'
    );
    touch(
      root,
      'apps/ai-service/pyproject.toml',
      '[project]\nname = "ai"\nversion = "0.1"\ndependencies = ["fastapi", "sqlalchemy"]\n\n[project.optional-dependencies]\ntest = ["pytest"]\n'
    );
    touch(root, 'apps/ai-service/main.py');
    touch(root, 'apps/ai-service/util.py');
    touch(
      root,
      'apps/web/package.json',
      JSON.stringify({
        name: 'web',
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        devDependencies: { typescript: '^5', vitest: '^1' },
      })
    );
    touch(root, 'apps/web/src/page.tsx');
    touch(root, 'apps/web/src/lib.ts');

    const result = await runDetection(root);
    expect(result.projectRoot).toBe(root);
    expect(result.manifests.length).toBeGreaterThanOrEqual(2);
    expect(result.frameworks.python?.framework).toBe('fastapi');
    expect(result.frameworks.typescript?.framework).toBe('next');
    expect(result.monorepo.type).toBe('turbo');
    expect(result.monorepo.packages.map((p) => p.name)).toEqual(
      expect.arrayContaining(['ai', 'web'])
    );
    expect(result.verificationCommands.python?.test).toContain('pytest');
    expect(result.verificationCommands.typescript?.type).toContain(
      'tsc --noEmit'
    );
    expect(result.domains.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it('honors user verification overrides', async () => {
    touch(
      root,
      'package.json',
      JSON.stringify({
        name: 'x',
        dependencies: { next: '^14' },
        devDependencies: { typescript: '^5', vitest: '^1' },
      })
    );
    touch(root, 'src/index.ts');
    const result = await runDetection(root, {
      verification: {
        typescript: { test: 'custom-runner --only=unit' },
      },
    });
    expect(result.verificationCommands.typescript?.test).toBe(
      'custom-runner --only=unit'
    );
    // Non-overridden key still defaults
    expect(result.verificationCommands.typescript?.type).toContain(
      'tsc --noEmit'
    );
  });

  it('honors user detection rules (adds new framework)', async () => {
    touch(
      root,
      'pyproject.toml',
      '[project]\nname = "x"\ndependencies = ["my-house-fw"]\n'
    );
    const result = await runDetection(root, {
      detection: {
        rules: {
          python: {
            HouseFW: { signals: ['my-house-fw'], priority: 50 },
          },
        },
      },
    });
    expect(result.frameworks.python?.framework).toBe('HouseFW');
  });

  it('single-repo with no monorepo signals yields type=single', async () => {
    touch(
      root,
      'package.json',
      JSON.stringify({
        name: 'lone',
        dependencies: { express: '^4' },
        devDependencies: { typescript: '^5' },
      })
    );
    touch(root, 'src/server.ts');
    const result = await runDetection(root);
    expect(result.monorepo.type).toBe('single');
    expect(result.frameworks.typescript?.framework).toBe('express');
    expect(result.verificationCommands.typescript?.type).toContain(
      'npx tsc --noEmit'
    );
  });

  it('returns empty results gracefully for empty dir', async () => {
    const result = await runDetection(root);
    expect(result.manifests).toEqual([]);
    expect(result.frameworks).toEqual({});
    expect(result.monorepo.type).toBe('single');
    expect(result.verificationCommands).toEqual({});
  });

  it('smoke test on massu-internal itself produces valid shape', async () => {
    // Runs against the real repo (resolved from this file's location) so the
    // test works in any checkout, local or CI.
    const result = await runDetection(REPO_ROOT);
    expect(result.manifests.length).toBeGreaterThan(0);
    // Root package.json present → typescript language should be detected
    const hasTs = result.manifests.some(
      (m) =>
        m.language === 'typescript' || m.language === 'javascript'
    );
    expect(hasTs).toBe(true);
    expect(['turbo', 'nx', 'pnpm', 'yarn', 'generic', 'single', 'lerna', 'bazel']).toContain(
      result.monorepo.type
    );
  });

  // P1-002: fallbackTsForJs flag wiring — when a js manifest exists and no ts
  // manifest exists, runDetection passes the flag so .tsx files under apps/
  // are surfaced to the javascript slot. Unblocks init --ci from falling
  // back to the nonexistent root `src/`.
  it('P1-002: picks up .tsx in js-only monorepo root (fallbackTsForJs)', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'js-tsx-monorepo',
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }));
    writeFileSync(join(root, 'turbo.json'), '{"$schema":"https://turbo.build/schema.json","tasks":{}}');
    touch(root, 'apps/web/package.json', JSON.stringify({ name: 'web' }));
    touch(root, 'apps/web/page.tsx', 'export default function Page(){return null}');
    const result = await runDetection(root);
    const langs = result.manifests.map((m) => m.language);
    expect(langs).toContain('javascript');
    expect(langs).not.toContain('typescript');
    expect(result.sourceDirs.javascript?.source_dirs).toEqual(['apps']);
  });

  it('P1-002: ts-only repo unaffected by fallback (flag off)', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'ts-repo',
      devDependencies: { typescript: '^5.0.0' },
    }));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    touch(root, 'src/index.ts', 'export {};');
    const result = await runDetection(root);
    const langs = result.manifests.map((m) => m.language);
    expect(langs).toContain('typescript');
    expect(result.sourceDirs.typescript?.source_dirs).toEqual(['src']);
  });

  it('P1-002: mixed ts+js repo — ts manifest suppresses fallback for js', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
    touch(root, 'apps/web/package.json', JSON.stringify({
      name: 'web',
      devDependencies: { typescript: '^5.0.0' },
    }));
    writeFileSync(join(root, 'apps/web/tsconfig.json'), '{}');
    touch(root, 'apps/web/index.ts', 'export {};');
    touch(root, 'apps/api/package.json', JSON.stringify({ name: 'api' }));
    touch(root, 'apps/api/index.js', '');
    const result = await runDetection(root);
    const langs = result.manifests.map((m) => m.language);
    expect(langs).toContain('typescript');
    expect(langs).toContain('javascript');
    expect(result.sourceDirs.typescript?.source_dirs).toContain('apps');
    expect(result.sourceDirs.javascript?.source_dirs).toContain('apps');
  });
});

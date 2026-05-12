// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { inferDomains } from '../detect/domain-inferrer.ts';
import type { MonorepoInfo } from '../detect/monorepo-detector.ts';
import type { SourceDirMap } from '../detect/source-dir-detector.ts';

function monorepo(
  type: MonorepoInfo['type'],
  packages: { path: string; name: string | null }[] = []
): MonorepoInfo {
  return {
    type,
    packages: packages.map((p) => ({
      path: p.path,
      name: p.name,
      manifest: 'package.json' as const,
    })),
    nested: [],
  };
}

describe('detect/domain-inferrer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-dom-inf-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('suggests one domain per monorepo workspace with deterministic ordering', () => {
    const info = monorepo('turbo', [
      { path: 'apps/web', name: 'web' },
      { path: 'apps/ai-service', name: 'ai-service' },
      { path: 'packages/shared', name: 'shared' },
    ]);
    const out = inferDomains(root, info, {});
    expect(out.map((d) => d.name)).toEqual(['ai-service', 'shared', 'web']);
    for (const d of out) expect(d.allowedImportsFrom).toEqual([]);
  });

  it('falls back to src/<subdirs> for single repos', () => {
    mkdirSync(join(root, 'src', 'controllers'), { recursive: true });
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    const out = inferDomains(root, monorepo('single'), {});
    const names = out.map((d) => d.name).sort();
    expect(names).toEqual(['Controllers', 'Services', 'Utils']);
  });

  it('falls back to language names when no src/ and no workspaces', () => {
    const sourceDirs: SourceDirMap = {
      python: {
        source_dirs: ['app'],
        test_dirs: ['tests'],
        colocated: false,
        file_count: 5,
      },
    };
    const out = inferDomains(root, monorepo('single'), sourceDirs);
    expect(out.map((d) => d.name)).toEqual(['Python']);
  });

  it('uses package name when present, path tail otherwise', () => {
    const info = monorepo('generic', [
      { path: 'apps/ai', name: null }, // no name → title-case path tail
      { path: 'apps/bar', name: '@scope/bar' },
    ]);
    const out = inferDomains(root, info, {});
    expect(out.map((d) => d.name).sort()).toEqual(['@scope/bar', 'Ai']);
  });

  it('dedupes domains with the same name', () => {
    const info = monorepo('pnpm', [
      { path: 'apps/x', name: 'shared' },
      { path: 'packages/x', name: 'shared' },
    ]);
    const out = inferDomains(root, info, {});
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('shared');
  });

  it('returns empty array when nothing detectable', () => {
    const out = inferDomains(root, monorepo('single'), {});
    expect(out).toEqual([]);
  });

  // ----------------------------------------------------------------
  // plan-1.7.0-cohesive-cleanup P-B-002 + P-B-003b structural fix
  // ----------------------------------------------------------------

  it('consumes detected source dirs (no hardcoded src/) for single-repo subdir enumeration', () => {
    // Single-repo layout where source lives under `lib/`, not `src/`.
    mkdirSync(join(root, 'lib', 'controllers'), { recursive: true });
    mkdirSync(join(root, 'lib', 'services'), { recursive: true });
    const sourceDirs: SourceDirMap = {
      typescript: {
        source_dirs: ['lib'],
        test_dirs: ['tests'],
        colocated: false,
        file_count: 4,
      },
    };
    const out = inferDomains(root, monorepo('single'), sourceDirs);
    const names = out.map((d) => d.name).sort();
    expect(names).toEqual(['Controllers', 'Services']);
  });

  it('unions subdirs across multiple detected source dirs for single repos', () => {
    // Two source dirs (multi-language) — controllers under one, services under the other.
    mkdirSync(join(root, 'lib', 'controllers'), { recursive: true });
    mkdirSync(join(root, 'app', 'services'), { recursive: true });
    const sourceDirs: SourceDirMap = {
      typescript: { source_dirs: ['lib'], test_dirs: ['tests'], colocated: false, file_count: 2 },
      python: { source_dirs: ['app'], test_dirs: ['tests'], colocated: false, file_count: 2 },
    };
    const out = inferDomains(root, monorepo('single'), sourceDirs);
    const names = out.map((d) => d.name).sort();
    expect(names).toEqual(['Controllers', 'Services']);
  });
});

// ----------------------------------------------------------------
// plan-1.7.0-cohesive-cleanup P-B-003 + P-B-003b: monorepo-apps-no-root-src fixture
// ----------------------------------------------------------------

describe('detect/domain-inferrer · monorepo-apps-no-root-src fixture', () => {
  const FIXTURE_DIR = resolve(
    __dirname,
    '..',
    'detect',
    '__tests__',
    'fixtures',
    'monorepo-apps-no-root-src',
  );

  it('fixture has apps/{web,api}/src layout with NO root src/', () => {
    expect(existsSync(join(FIXTURE_DIR, 'package.json'))).toBe(true);
    expect(existsSync(join(FIXTURE_DIR, 'apps', 'web', 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(FIXTURE_DIR, 'apps', 'api', 'src', 'index.ts'))).toBe(true);
    // Critical invariant: no root-level src/ in this fixture.
    expect(existsSync(join(FIXTURE_DIR, 'src'))).toBe(false);
  });

  it('inferDomains returns BOTH web and api as domains when workspace packages are detected', () => {
    // Simulate the monorepo-detector output that the upstream pipeline
    // would produce for this fixture (workspaces: ["apps/*"] →
    // 2 workspace packages).
    const info: MonorepoInfo = {
      type: 'yarn',
      packages: [
        { path: 'apps/web', name: 'web', manifest: 'package.json' as const },
        { path: 'apps/api', name: 'api', manifest: 'package.json' as const },
      ],
      nested: [],
    };
    const sourceDirs: SourceDirMap = {
      typescript: {
        source_dirs: ['apps/web/src', 'apps/api/src'],
        test_dirs: [],
        colocated: false,
        file_count: 2,
      },
    };
    const out = inferDomains(FIXTURE_DIR, info, sourceDirs);
    const names = out.map((d) => d.name).sort();
    expect(names).toEqual(['api', 'web']);
  });
});

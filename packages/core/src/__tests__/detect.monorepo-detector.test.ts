// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectMonorepo } from '../detect/monorepo-detector.ts';

function touch(root: string, rel: string, contents = ''): void {
  const path = join(root, rel);
  const parts = rel.split('/');
  if (parts.length > 1) {
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(path, contents);
}

describe('detect/monorepo-detector', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-mono-det-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns single for a flat repo with no monorepo signals', () => {
    touch(root, 'package.json', JSON.stringify({ name: 'flat' }));
    const info = detectMonorepo(root);
    expect(info.type).toBe('single');
    expect(info.packages).toEqual([]);
  });

  it('detects turbo + pnpm and reports pnpm as nested', () => {
    touch(root, 'turbo.json', '{}');
    touch(root, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    touch(
      root,
      'apps/web/package.json',
      JSON.stringify({ name: 'web', dependencies: { next: '^14' } })
    );
    touch(
      root,
      'packages/shared/package.json',
      JSON.stringify({ name: 'shared' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('turbo');
    expect(info.packages.map((p) => p.name)).toEqual(
      expect.arrayContaining(['web', 'shared'])
    );
    expect(info.nested.length).toBeGreaterThan(0);
    expect(info.nested[0].type).toBe('pnpm');
  });

  it('detects pnpm workspaces without turbo/nx', () => {
    touch(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    touch(
      root,
      'packages/core/package.json',
      JSON.stringify({ name: 'core' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('pnpm');
    expect(info.packages).toHaveLength(1);
    expect(info.packages[0].name).toBe('core');
  });

  it('detects yarn workspaces from package.json', () => {
    touch(
      root,
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      })
    );
    touch(
      root,
      'packages/alpha/package.json',
      JSON.stringify({ name: 'alpha' })
    );
    touch(
      root,
      'packages/beta/package.json',
      JSON.stringify({ name: 'beta' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('yarn');
    expect(info.packages.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('detects nx monorepo', () => {
    touch(root, 'nx.json', '{}');
    touch(
      root,
      'package.json',
      JSON.stringify({ name: 'nx-root', workspaces: ['apps/*'] })
    );
    touch(
      root,
      'apps/shop/package.json',
      JSON.stringify({ name: 'shop' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('nx');
    expect(info.packages.map((p) => p.name)).toContain('shop');
  });

  it('falls back to generic when conventional workspace dirs exist without manager', () => {
    touch(
      root,
      'apps/a/package.json',
      JSON.stringify({ name: 'a' })
    );
    touch(
      root,
      'services/b/package.json',
      JSON.stringify({ name: 'b' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('generic');
    expect(info.packages.map((p) => p.name).sort()).toEqual(['a', 'b']);
  });

  it('detects Bazel when WORKSPACE is present', () => {
    touch(root, 'WORKSPACE', '');
    touch(
      root,
      'apps/a/package.json',
      JSON.stringify({ name: 'a' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('bazel');
  });

  it('detects lerna', () => {
    touch(root, 'lerna.json', '{}');
    touch(
      root,
      'package.json',
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] })
    );
    touch(
      root,
      'packages/x/package.json',
      JSON.stringify({ name: 'x' })
    );
    const info = detectMonorepo(root);
    expect(info.type).toBe('lerna');
    expect(info.packages.map((p) => p.name)).toContain('x');
  });

  it('picks up Cargo workspace package paths via generic fallback', () => {
    touch(root, 'Cargo.toml', '[workspace]\nmembers = ["apps/gateway"]\n');
    touch(
      root,
      'apps/gateway/Cargo.toml',
      '[package]\nname = "gateway"\nversion = "0.1.0"\n'
    );
    const info = detectMonorepo(root);
    // No turbo/nx/pnpm/yarn, no Bazel — generic picks up apps/gateway
    expect(info.type).toBe('generic');
    expect(info.packages[0].path).toBe('apps/gateway');
    expect(info.packages[0].manifest).toBe('Cargo.toml');
  });

  // P3-006: parity coverage — yarn-object-form workspaces, nx+yarn combo,
  // and the full apps/+libs/ nx shape that the nx-monorepo fresh-install
  // fixture exercises.
  it('detects yarn workspaces in object form ({ packages: [...] })', () => {
    touch(root, 'package.json', JSON.stringify({
      name: 'r',
      workspaces: { packages: ['apps/*'] },
    }));
    touch(root, 'apps/web/package.json', JSON.stringify({ name: 'web' }));
    const info = detectMonorepo(root);
    expect(info.type).toBe('yarn');
    expect(info.packages.map((p) => p.path)).toEqual(['apps/web']);
  });

  it('nx monorepo with apps/ AND libs/ both present via yarn workspaces', () => {
    // Mirrors the nx-monorepo fresh-install fixture used by P4's CI gate.
    touch(root, 'nx.json', '{}');
    touch(root, 'package.json', JSON.stringify({
      name: 'nx-repo',
      workspaces: ['apps/*', 'libs/*'],
    }));
    touch(root, 'apps/web/package.json', JSON.stringify({ name: 'web' }));
    touch(root, 'libs/ui/package.json', JSON.stringify({ name: 'ui' }));
    const info = detectMonorepo(root);
    expect(info.type).toBe('nx');
    const paths = info.packages.map((p) => p.path).sort();
    expect(paths).toEqual(['apps/web', 'libs/ui']);
  });

  // P4.8-003: detectMonorepo must not follow symlinks that forge a workspace
  // manifest pointing to something outside the tree. safeReadText (at
  // monorepo-detector.ts:107-121) rejects symlinked manifest files via
  // lstatSync, so the forged workspace cannot be parsed.
  it('P4.8-003: symlinked forged package.json is ignored by detectMonorepo', async () => {
    const { symlinkSync: sym } = await import('fs');
    const outside = mkdtempSync(join(tmpdir(), 'massu-mono-outside-'));
    try {
      // Legit workspace first.
      touch(root, 'package.json', JSON.stringify({
        name: 'r', workspaces: ['apps/*'],
      }));
      touch(root, 'apps/web/package.json', JSON.stringify({ name: 'web' }));
      // Forged workspace: a symlinked package.json pointing outside the repo.
      writeFileSync(join(outside, 'forged.json'), JSON.stringify({ name: 'forged' }));
      mkdirSync(join(root, 'apps/forged'), { recursive: true });
      sym(join(outside, 'forged.json'), join(root, 'apps/forged/package.json'));
      const info = detectMonorepo(root);
      expect(info.type).toBe('yarn');
      // Legit web workspace detected; forged workspace's manifest read returns
      // null (safeReadText rejects symlinks), so the `name` ends up null but
      // the path itself is still listed. Assert the legit workspace is intact.
      const paths = info.packages.map((p) => p.path);
      expect(paths).toContain('apps/web');
      // The forged workspace's `name` should be null because safeReadText
      // refused to follow the symlink.
      const forged = info.packages.find((p) => p.path === 'apps/forged');
      expect(forged?.name).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

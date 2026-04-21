// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-001: Detection fixture tests.
 *
 * Runs `runDetection` against 11 checked-in fixture directories (one per
 * supported stack / monorepo kind) and asserts the expected DetectionResult
 * shape. Fixtures are immutable — tests must not write to them.
 *
 * Fixtures live in: packages/core/src/detect/__tests__/fixtures/<name>/
 *
 * NOTE: these tests intentionally use checked-in fixture directories (not
 * tmpdir) because we want the fixtures themselves to be reviewed, versioned,
 * and reused by the init-integration and e2e-install test suites (P7-002,
 * P7-005). See the detect/__tests__/fixtures/ tree.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { runDetection } from '../detect/index.ts';

const FIXTURES_ROOT = resolve(__dirname, '..', 'detect', '__tests__', 'fixtures');

function fixtureDir(name: string): string {
  return resolve(FIXTURES_ROOT, name);
}

describe('P7-001: detection fixture suite', () => {
  describe('python-fastapi fixture', () => {
    it('detects python + fastapi + pytest', async () => {
      const r = await runDetection(fixtureDir('python-fastapi'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['python']);
      expect(r.frameworks.python?.framework).toBe('fastapi');
      expect(r.frameworks.python?.test_framework).toBe('pytest');
      expect(r.frameworks.python?.orm).toBe('sqlalchemy');
    });

    it('has source_dirs = ["src"] and monorepo=single', async () => {
      const r = await runDetection(fixtureDir('python-fastapi'));
      expect(r.sourceDirs.python?.source_dirs).toContain('src');
      expect(r.monorepo.type).toBe('single');
    });

    it('emits vr test command referencing pytest', async () => {
      const r = await runDetection(fixtureDir('python-fastapi'));
      expect(r.verificationCommands.python?.test).toContain('pytest');
    });
  });

  describe('python-django fixture', () => {
    it('detects python + django', async () => {
      const r = await runDetection(fixtureDir('python-django'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['python']);
      expect(r.frameworks.python?.framework).toBe('django');
    });

    it('finds the app/ source directory', async () => {
      const r = await runDetection(fixtureDir('python-django'));
      expect(r.sourceDirs.python?.source_dirs).toContain('app');
    });
  });

  describe('ts-nextjs fixture', () => {
    it('detects typescript + next', async () => {
      const r = await runDetection(fixtureDir('ts-nextjs'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['typescript']);
      expect(r.frameworks.typescript?.framework).toBe('next');
      expect(r.frameworks.typescript?.test_framework).toBe('vitest');
    });

    it('uses src/ as source dir, monorepo=single', async () => {
      const r = await runDetection(fixtureDir('ts-nextjs'));
      expect(r.sourceDirs.typescript?.source_dirs).toContain('src');
      expect(r.monorepo.type).toBe('single');
    });

    it('emits vr type command referencing tsc', async () => {
      const r = await runDetection(fixtureDir('ts-nextjs'));
      expect(r.verificationCommands.typescript?.type).toContain('tsc');
    });
  });

  describe('ts-nestjs fixture', () => {
    it('detects typescript + nestjs', async () => {
      const r = await runDetection(fixtureDir('ts-nestjs'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['typescript']);
      expect(r.frameworks.typescript?.framework).toBe('nestjs');
    });

    it('picks jest as test framework', async () => {
      const r = await runDetection(fixtureDir('ts-nestjs'));
      expect(r.frameworks.typescript?.test_framework).toBe('jest');
    });
  });

  describe('rust-actix fixture', () => {
    it('detects rust + actix-web', async () => {
      const r = await runDetection(fixtureDir('rust-actix'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['rust']);
      expect(r.frameworks.rust?.framework).toBe('actix-web');
    });

    it('emits cargo test as vr test command', async () => {
      const r = await runDetection(fixtureDir('rust-actix'));
      expect(r.verificationCommands.rust?.test).toContain('cargo test');
    });
  });

  describe('swift-ios fixture', () => {
    it('detects swift manifest', async () => {
      const r = await runDetection(fixtureDir('swift-ios'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['swift']);
    });

    it('finds the Sources/ directory', async () => {
      const r = await runDetection(fixtureDir('swift-ios'));
      expect(r.sourceDirs.swift?.source_dirs).toContain('Sources');
    });

    it('emits swift test as vr test command', async () => {
      const r = await runDetection(fixtureDir('swift-ios'));
      expect(r.verificationCommands.swift?.test).toContain('swift test');
    });
  });

  describe('go-gin fixture', () => {
    it('detects go + gin', async () => {
      const r = await runDetection(fixtureDir('go-gin'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language)));
      expect(langs).toEqual(['go']);
      expect(r.frameworks.go?.framework).toBe('gin');
    });

    it('emits go test as vr test command', async () => {
      const r = await runDetection(fixtureDir('go-gin'));
      expect(r.verificationCommands.go?.test).toContain('go test');
    });
  });

  describe('multi-runtime fixture (example-project-like)', () => {
    it('detects 4 languages across apps/*', async () => {
      const r = await runDetection(fixtureDir('multi-runtime'));
      const langs = Array.from(new Set(r.manifests.map((m) => m.language))).sort();
      expect(langs).toEqual(['python', 'rust', 'swift', 'typescript']);
    });

    it('reports a generic monorepo with 4 workspace packages', async () => {
      const r = await runDetection(fixtureDir('multi-runtime'));
      expect(r.monorepo.type).toBe('generic');
      expect(r.monorepo.packages.length).toBe(4);
    });

    it('infers framework per language (fastapi, next, actix-web)', async () => {
      const r = await runDetection(fixtureDir('multi-runtime'));
      expect(r.frameworks.python?.framework).toBe('fastapi');
      expect(r.frameworks.typescript?.framework).toBe('next');
      expect(r.frameworks.rust?.framework).toBe('actix-web');
    });
  });

  describe('monorepo-turbo fixture', () => {
    it('detects turbo monorepo type', async () => {
      const r = await runDetection(fixtureDir('monorepo-turbo'));
      expect(r.monorepo.type).toBe('turbo');
    });

    it('enumerates apps/web and apps/api workspaces', async () => {
      const r = await runDetection(fixtureDir('monorepo-turbo'));
      const names = r.monorepo.packages.map((p) => p.name).sort();
      expect(names).toContain('web');
      expect(names).toContain('api');
    });
  });

  describe('monorepo-nx fixture', () => {
    it('detects nx monorepo type', async () => {
      const r = await runDetection(fixtureDir('monorepo-nx'));
      expect(r.monorepo.type).toBe('nx');
    });

    it('enumerates apps/web and libs/ui workspaces', async () => {
      const r = await runDetection(fixtureDir('monorepo-nx'));
      const names = r.monorepo.packages.map((p) => p.name).sort();
      expect(names).toContain('web');
      expect(names).toContain('ui');
    });
  });

  describe('monorepo-pnpm fixture', () => {
    it('detects pnpm monorepo type', async () => {
      const r = await runDetection(fixtureDir('monorepo-pnpm'));
      expect(r.monorepo.type).toBe('pnpm');
    });

    it('enumerates packages/ui and packages/server workspaces', async () => {
      const r = await runDetection(fixtureDir('monorepo-pnpm'));
      const names = r.monorepo.packages.map((p) => p.name).sort();
      expect(names).toContain('ui');
      expect(names).toContain('server');
    });
  });

  describe('determinism', () => {
    it('runDetection is pure: consecutive runs on the same fixture match', async () => {
      const a = await runDetection(fixtureDir('python-fastapi'));
      const b = await runDetection(fixtureDir('python-fastapi'));
      // Compare language set + framework identity
      expect(a.frameworks.python?.framework).toBe(b.frameworks.python?.framework);
      expect(a.manifests.length).toBe(b.manifests.length);
      expect(a.monorepo.type).toBe(b.monorepo.type);
    });
  });
});

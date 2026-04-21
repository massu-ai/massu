// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-003: Migration tests for known stale configs.
 *
 * Exercises `migrateV1ToV2` against five snapshot fixtures that mirror the
 * real-world failure modes we've seen in the wild:
 *
 *   - example-project-prefix/               TS-flavored v1 config with a Python+FastAPI repo
 *   - glyphwise/                  TS v1 on Python+Swift (severe stale)
 *   - eko-ultra-automations/      Hand-customized v1 with invalid router value
 *   - nuroflo/                    Multi-runtime (Python + TS+Next) in v1
 *   - massu-internal/             Self-host (baseline / mild adjustment)
 *
 * Each snapshot lives at:
 *   packages/core/src/__tests__/fixtures/stale-configs/<name>/
 *     massu.config.yaml            — the stale v1 config as recorded
 *     repo/                        — minimal filesystem of the actual repo
 *
 * Phase 4 (`massu config upgrade`) is NOT in MVP cut; these tests validate
 * migration LOGIC as pure functions of (v1Config, detectionResult).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as yamlParse } from 'yaml';
import { runDetection } from '../detect/index.ts';
import { migrateV1ToV2, type AnyConfig } from '../detect/migrate.ts';

const FIXTURES_ROOT = resolve(__dirname, 'fixtures', 'stale-configs');

async function loadFixture(
  name: string
): Promise<{ v1: AnyConfig; v2: AnyConfig; repoRoot: string }> {
  const base = resolve(FIXTURES_ROOT, name);
  const v1 = yamlParse(readFileSync(resolve(base, 'massu.config.yaml'), 'utf-8')) as AnyConfig;
  const repoRoot = resolve(base, 'repo');
  const detection = await runDetection(repoRoot);
  const v2 = migrateV1ToV2(v1, detection);
  return { v1, v2, repoRoot };
}

describe('P7-003: migrateV1ToV2 on known stale configs', () => {
  it('example-project-prefix: TS-flavored v1 → v2 python/fastapi, preserves user domains + rules', async () => {
    const { v1, v2 } = await loadFixture('example-project-prefix');
    expect(v2.schema_version).toBe(2);
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.type).toBe('python');
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.python.framework).toBe('fastapi');
    expect(langs.python.test_framework).toBe('pytest');
    expect(langs.python.orm).toBe('sqlalchemy');
    // User overrides preserved
    expect(v2.rules).toEqual(v1.rules);
    expect(v2.domains).toEqual(v1.domains);
    // toolPrefix preserved
    expect(v2.toolPrefix).toBe('example-project');
    // Verification block populated from detection
    const ver = v2.verification as Record<string, Record<string, string>>;
    expect(ver.python.test).toContain('pytest');
  });

  it('glyphwise: severely stale (TS template on Python+Swift) → multi-runtime v2', async () => {
    const { v2 } = await loadFixture('glyphwise');
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.type).toBe('multi');
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.python.framework).toBe('flask');
    expect(langs.swift).toBeDefined();
    // framework.primary is set for multi
    expect(typeof fw.primary).toBe('string');
    // Both verification blocks populated
    const ver = v2.verification as Record<string, Record<string, string>>;
    expect(ver.python.test).toContain('pytest');
    expect(ver.swift.test).toContain('swift test');
  });

  it('eko-ultra-automations: invalid router enum v1 → v2 preserves the user value', async () => {
    const { v1, v2 } = await loadFixture('eko-ultra-automations');
    // The user had `router: 'hand-rolled'` — NOT a canonical enum value. The
    // migrator should preserve user intent; legacy top-level `router` stays
    // `hand-rolled` because it's a concrete user value (non-empty, non-'none').
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.router).toBe('hand-rolled');
    // Domain override preserved verbatim
    expect(v2.domains).toEqual(v1.domains);
    // canonical_paths preserved verbatim
    expect(v2.canonical_paths).toEqual(v1.canonical_paths);
    // toolPrefix preserved
    expect(v2.toolPrefix).toBe('eko');
    // Detection found express+vitest
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.typescript.test_framework).toBe('vitest');
  });

  it('nuroflo: multi-runtime v1 → v2 with per-language entries and preserved domains', async () => {
    const { v1, v2 } = await loadFixture('nuroflo');
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.type).toBe('multi');
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.python?.framework).toBe('fastapi');
    expect(langs.typescript?.framework).toBe('next');
    // Domains preserved
    expect(v2.domains).toEqual(v1.domains);
    // toolPrefix preserved
    expect(v2.toolPrefix).toBe('nuroflo');
  });

  it('massu-internal: fresh-ish v1 → v2 idempotent on re-run', async () => {
    const { v1, v2 } = await loadFixture('massu-internal');
    expect(v2.schema_version).toBe(2);
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.type).toBe('typescript');
    // Domains/rules preserved
    expect(v2.domains).toEqual(v1.domains);
    expect(v2.rules).toEqual(v1.rules);
  });

  it('migration is idempotent: v2 → migrate → equivalent v2', async () => {
    const { v2, repoRoot } = await loadFixture('example-project-prefix');
    const detection = await runDetection(repoRoot);
    const v2Again = migrateV1ToV2(v2, detection);
    expect(v2Again.schema_version).toBe(2);
    // Framework shape matches on re-run.
    expect(v2Again.framework).toEqual(v2.framework);
    // User collections unchanged.
    expect(v2Again.domains).toEqual(v2.domains);
    expect(v2Again.rules).toEqual(v2.rules);
    expect(v2Again.verification).toEqual(v2.verification);
  });
});

// Synthetic detection used by the passthrough tests — keeps them pure and
// independent of any fixture repo filesystem.
function emptyDetection() {
  return {
    manifests: [],
    frameworks: {},
    sourceDirs: {},
    verificationCommands: {},
    workspaces: [],
    monorepoType: 'single' as const,
    rules: [],
  } as unknown as Parameters<typeof migrateV1ToV2>[1];
}

describe('migrateV1ToV2: top-level passthrough (P2-001)', () => {
  it('preserves a single unknown top-level key verbatim', () => {
    const v1: AnyConfig = { foo_custom: 'bar' };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect(v2.foo_custom).toBe('bar');
  });

  it('preserves multiple unknown top-level keys', () => {
    const v1: AnyConfig = {
      services: { a: 1 },
      north_stars: ['x', 'y'],
      workflow: { phase: 'plan' },
    };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect(v2.services).toEqual({ a: 1 });
    expect(v2.north_stars).toEqual(['x', 'y']);
    expect(v2.workflow).toEqual({ phase: 'plan' });
  });

  it('preserves deep unknown nested object key shape', () => {
    const v1: AnyConfig = {
      services: { guardian: { port: 3000, notes: 'keep me' } },
    };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect((v2.services as Record<string, Record<string, unknown>>).guardian.port).toBe(3000);
    expect((v2.services as Record<string, Record<string, unknown>>).guardian.notes).toBe('keep me');
  });

  it('null value under unknown top-level key: key preserved as null (not dropped)', () => {
    // Per P1-003 semantics: copyUnknownKeys skips undefined but preserves null.
    const v1: AnyConfig = { opt_in_feature: null };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect('opt_in_feature' in v2).toBe(true);
    expect(v2.opt_in_feature).toBeNull();
  });
});

describe('migrateV1ToV2: example-project-incident-20260419 regression (P2-003)', () => {
  it('12-top-level-key example-project shape survives migration with zero top-level loss', async () => {
    const { v1, v2 } = await loadFixture('example-project-incident-20260419');
    // Every top-level key from v1 must appear in v2. (schema_version + detection are additions.)
    for (const key of Object.keys(v1)) {
      expect(v2, `missing top-level key: ${key}`).toHaveProperty(key);
    }
    // Spot-check the 3 keys the incident actually lost.
    expect(v2.services).toEqual(v1.services);
    expect(v2.north_stars).toEqual(v1.north_stars);
    expect(v2.workflow).toEqual(v1.workflow);
    // Nested preservation: framework language sub-blocks, paths custom keys, project.description.
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.python).toBeDefined();
    expect(fw.typescript).toBeDefined();
    expect(fw.swift).toBeDefined();
    expect(fw.rust).toBeDefined();
    const paths = v2.paths as Record<string, unknown>;
    expect(paths.adr).toBe('docs/adr');
    expect(paths.monorepo_root).toBe('apps');
    expect(paths.plans).toBe('docs/plans');
    const project = v2.project as Record<string, unknown>;
    expect(project.description).toBe('World-class enterprise-grade auto-trading platform');
    // toolPrefix preserved as 'example-project'.
    expect(v2.toolPrefix).toBe('example-project');
  });
});

describe('migrateV1ToV2: nested passthrough (P2-005..P2-008)', () => {
  it('P2-005: preserves unknown framework.* language sub-blocks', () => {
    const v1: AnyConfig = {
      framework: {
        type: 'typescript',
        router: 'trpc',
        orm: 'prisma',
        ui: 'nextjs',
        python: { root: 'api', exclude_dirs: ['.venv'] },
        rust: { root: 'gateway' },
      },
    };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    const fw = v2.framework as Record<string, unknown>;
    expect(fw.python).toEqual({ root: 'api', exclude_dirs: ['.venv'] });
    expect(fw.rust).toEqual({ root: 'gateway' });
  });

  it('P2-006: preserves unknown paths.* custom entries', () => {
    const v1: AnyConfig = {
      paths: {
        source: 'src',
        aliases: { '@': 'src' },
        adr: 'docs/adr',
        data_runtime: 'data',
        web_source: 'apps/web/src',
        plans: 'docs/plans',
      },
    };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    const paths = v2.paths as Record<string, unknown>;
    expect(paths.adr).toBe('docs/adr');
    expect(paths.data_runtime).toBe('data');
    expect(paths.web_source).toBe('apps/web/src');
    expect(paths.plans).toBe('docs/plans');
  });

  it('P2-007: preserves project.description and other custom subkeys', () => {
    const v1: AnyConfig = {
      project: {
        name: 'example-project',
        root: '/some/root',
        description: 'Trading platform',
        author: 'team-example-project',
      },
    };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    const project = v2.project as Record<string, unknown>;
    expect(project.name).toBe('example-project');
    expect(project.root).toBe('/some/root');
    expect(project.description).toBe('Trading platform');
    expect(project.author).toBe('team-example-project');
  });

  it('P2-008: preserves unknown python.* subkeys when python is present', () => {
    // Use a fixture that detects python so the detected-python branch runs.
    // Fake detection with python manifest so `languages.includes('python')` is true.
    const detection = {
      manifests: [{ language: 'python' as const, manifest: 'pyproject.toml', path: 'pyproject.toml' }],
      frameworks: { python: { framework: 'fastapi', orm: 'sqlalchemy', test_framework: 'pytest' } },
      sourceDirs: { python: { source_dirs: ['app'] } },
      verificationCommands: { python: { test: 'pytest' } },
      workspaces: [],
      monorepoType: 'single' as const,
      rules: [],
    } as unknown as Parameters<typeof migrateV1ToV2>[1];
    const v1: AnyConfig = {
      python: {
        root: 'app',
        exclude_dirs: ['.venv'],
        test_framework: 'pytest-asyncio',
        database: 'postgres',
      },
    };
    const v2 = migrateV1ToV2(v1, detection);
    const py = v2.python as Record<string, unknown>;
    expect(py.test_framework).toBe('pytest-asyncio');
    expect(py.database).toBe('postgres');
  });
});

describe('migrateV1ToV2: loose v1 input coercion (P2-013)', () => {
  it('framework as string does not throw and yields a valid object', () => {
    const v1: AnyConfig = { framework: 'typescript' };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect(typeof v2.framework).toBe('object');
    expect(v2.framework).not.toBeNull();
  });

  it('paths as null does not throw and yields a valid paths object', () => {
    const v1: AnyConfig = { paths: null };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect(typeof v2.paths).toBe('object');
    expect(v2.paths).not.toBeNull();
    const paths = v2.paths as Record<string, unknown>;
    expect(typeof paths.source).toBe('string');
  });

  it('project as array does not throw and yields default project object', () => {
    const v1: AnyConfig = { project: [] as unknown as Record<string, unknown> };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    const project = v2.project as Record<string, unknown>;
    expect(project.name).toBe('my-project');
    expect(project.root).toBe('auto');
  });

  it('python undefined does not throw; v2.python either omitted or preserved', () => {
    const v1: AnyConfig = { python: undefined };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    // `python` undefined + no python detection → v2.python should be absent.
    expect(v2.python).toBeUndefined();
  });
});

/**
 * A-003 architecture-review follow-up: property-style regression guard.
 *
 * If a future contributor adds a new rebuild-from-scratch block in migrate.ts
 * (e.g., `ios:`, `rust:`) without opting into `preserveNestedSubkeys`, this
 * sentinel-injection test fails. For every known rebuilt top-level block AND
 * every top-level v1 custom key, inject a `__test_marker__` sentinel value and
 * assert it survives migration. Each known rebuild site is expected to call
 * passthrough; any new block that forgets to will drop the sentinel.
 */
describe('migrateV1ToV2: sentinel-injection property test (A-003)', () => {
  const rebuiltBlocks: Array<'framework' | 'paths' | 'project' | 'python'> = [
    'framework', 'paths', 'project', 'python',
  ];

  for (const block of rebuiltBlocks) {
    it(`rebuilt block "${block}": injected __test_marker__ subkey survives migration`, () => {
      const v1: AnyConfig = {
        framework: { type: 'typescript' },
        paths: { source: 'src' },
        project: { name: 'x', root: 'auto' },
        python: { root: 'py' },
      };
      // Inject sentinel into the target block.
      (v1[block] as Record<string, unknown>).__test_marker__ = 'SENTINEL_VALUE';
      const v2 = migrateV1ToV2(v1, emptyDetection());
      const v2Block = v2[block] as Record<string, unknown> | undefined;
      expect(v2Block).toBeDefined();
      expect(v2Block?.__test_marker__).toBe('SENTINEL_VALUE');
    });
  }

  it('unknown top-level key with complex shape survives verbatim', () => {
    const sentinel = {
      nested: { arr: [1, 2, { deep: 'ok' }], flag: true },
      scalar: 42,
    };
    const v1: AnyConfig = {
      project: { name: 'x', root: 'auto' },
      __custom_top_level__: sentinel,
    };
    const v2 = migrateV1ToV2(v1, emptyDetection());
    expect(v2.__custom_top_level__).toEqual(sentinel);
  });
});

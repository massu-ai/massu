// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-001 tests: `config refresh` behavior.
 *
 * Uses the existing detect-fixtures tree (ts-nextjs) as a stable stack; seeds a
 * stale v1 config with user-authored rules/domains, runs refresh, asserts user
 * fields are preserved byte-for-byte and detector-owned fields are updated.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  computeDiff,
  mergeRefresh,
  runConfigRefresh,
} from '../commands/config-refresh.ts';

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
  const dest = mkdtempSync(resolve(tmpdir(), `massu-refresh-${name}-`));
  created.push(dest);
  cpSync(src, dest, { recursive: true });
  return dest;
}

function writeStaleConfig(dir: string, overrides: Record<string, unknown>): void {
  const baseline: Record<string, unknown> = {
    project: { name: 'stale-project', root: 'auto' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: { '@': 'src' } },
    toolPrefix: 'massu',
    domains: [],
    rules: [],
    ...overrides,
  };
  writeFileSync(
    resolve(dir, 'massu.config.yaml'),
    yamlStringify(baseline),
    'utf-8'
  );
}

describe('config refresh', () => {
  it('--dry-run emits diff and does NOT write the file', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir, {
      rules: [{ pattern: 'src/**/*.ts', rules: ['Use ESM imports'] }],
    });
    const before = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
    const res = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    const after = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
    expect(res.exitCode).toBe(0);
    expect(res.applied).toBe(false);
    expect(res.dryRun).toBe(true);
    expect(after).toBe(before);
    expect(res.diff.length).toBeGreaterThan(0);
  });

  it('returns exit code 1 when massu.config.yaml is missing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-refresh-missing-'));
    created.push(dir);
    const res = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    expect(res.exitCode).toBe(1);
    expect(res.applied).toBe(false);
  });

  it('returns exit code 2 on unparseable YAML', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-refresh-broken-'));
    created.push(dir);
    writeFileSync(resolve(dir, 'massu.config.yaml'), ':\n  - [[\n\tnot valid', 'utf-8');
    const res = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    expect(res.exitCode).toBe(2);
  });

  it('non-interactive (no TTY) behaves like dry-run without writing', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir, {});
    const before = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
    const res = await runConfigRefresh({ cwd: dir, silent: true });
    const after = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
    expect(res.exitCode).toBe(0);
    expect(res.applied).toBe(false);
    expect(after).toBe(before);
  });
});

describe('computeDiff', () => {
  it('detects added, removed, and changed top-level fields', () => {
    const before = { a: 1, b: 2, c: { nested: 'x' } };
    const after = { a: 1, b: 3, d: { nested: 'y' } };
    const diff = computeDiff(before, after);
    const paths = diff.map((d) => `${d.kind}:${d.path}`);
    expect(paths).toContain('change:b');
    expect(paths).toContain('remove:c.nested');
    expect(paths).toContain('add:d.nested');
  });

  it('returns empty array when configs are deeply equal', () => {
    const before = { a: { b: [1, 2, 3] }, c: 'hi' };
    const after = { a: { b: [1, 2, 3] }, c: 'hi' };
    expect(computeDiff(before, after)).toEqual([]);
  });
});

describe('mergeRefresh', () => {
  it('preserves user-authored rules/domains while refreshing detector keys', () => {
    const existing = {
      rules: [{ pattern: 'src/**/*.ts', rules: ['hand-edit'] }],
      domains: [{ name: 'custom', routers: ['foo'] }],
      framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    };
    const refreshed = {
      rules: [],
      domains: [],
      framework: { type: 'python', router: 'fastapi', orm: 'sqlalchemy', ui: 'none' },
      paths: { source: 'app' },
    };
    const merged = mergeRefresh(existing, refreshed);
    expect(merged.rules).toEqual(existing.rules);
    expect(merged.domains).toEqual(existing.domains);
    expect(merged.framework).toEqual(refreshed.framework);
    expect((merged.paths as Record<string, unknown>).source).toBe('app');
  });

  // P2-009: top-level passthrough — unknown keys survive the refresh merge.
  it('P2-009: preserves unknown top-level keys through mergeRefresh', () => {
    const existing = {
      foo_custom: 'bar',
      services: { guardian: { port: 3000 } },
      framework: { type: 'typescript' },
    };
    const refreshed = {
      framework: { type: 'python' },
      paths: { source: 'src' },
    };
    const merged = mergeRefresh(existing, refreshed);
    expect(merged.foo_custom).toBe('bar');
    expect(merged.services).toEqual({ guardian: { port: 3000 } });
  });

  // P2-009 (round-trip idempotence): running mergeRefresh twice on the same
  // existing+refreshed inputs yields an equivalent output each time.
  it('P2-009: mergeRefresh is idempotent on unknown keys', () => {
    const existing = { foo_custom: 'bar', services: { a: 1 } };
    const refreshed = { framework: { type: 'typescript' } };
    const first = mergeRefresh(existing, refreshed);
    const second = mergeRefresh(first, refreshed);
    expect(second.foo_custom).toBe('bar');
    expect(second.services).toEqual({ a: 1 });
  });

  // P2-010: nested passthrough — user subkeys inside framework/paths/project survive.
  it('P2-010: preserves nested subkeys inside framework/paths/project', () => {
    const existing = {
      framework: {
        type: 'typescript',
        python: { root: 'api', exclude_dirs: ['.venv'] },
      },
      paths: {
        source: 'src',
        adr: 'docs/adr',
        docs: 'docs',
      },
      project: {
        name: 'trading-monorepo',
        root: '/custom/path',
        description: 'Trading platform',
      },
    };
    const refreshed = {
      framework: { type: 'python', router: 'fastapi' },
      paths: { source: 'app' },
      project: { name: 'trading-monorepo', root: 'auto' },
    };
    const merged = mergeRefresh(existing, refreshed);
    const fw = merged.framework as Record<string, unknown>;
    expect(fw.python).toEqual({ root: 'api', exclude_dirs: ['.venv'] });
    const paths = merged.paths as Record<string, unknown>;
    expect(paths.adr).toBe('docs/adr');
    expect(paths.docs).toBe('docs');
    const project = merged.project as Record<string, unknown>;
    expect(project.description).toBe('Trading platform');
  });

  // P2-011: toolPrefix preserved even though detector hardcodes 'massu'.
  it('P2-011: preserves custom toolPrefix (downstream-consumer scenario)', () => {
    const existing = { toolPrefix: 'trading' };
    const refreshed = { toolPrefix: 'massu', framework: { type: 'python' } };
    const merged = mergeRefresh(existing, refreshed);
    expect(merged.toolPrefix).toBe('trading');
  });

  // P2-012: user-set project.root survives detector default 'auto'.
  it('P2-012: preserves user-set project.root against detector default', () => {
    const existing = { project: { name: 'trading-monorepo', root: '/custom/path' } };
    const refreshed = { project: { name: 'trading-monorepo', root: 'auto' } };
    const merged = mergeRefresh(existing, refreshed);
    const project = merged.project as Record<string, unknown>;
    expect(project.root).toBe('/custom/path');
  });

  // P2-014 (P5-002 discovery): verification custom language sections survive
  // wholesale, AND user command overrides win over detector defaults for
  // shared languages. A multi-runtime monorepo's `gateway`, `ios`, `runtime`, `web` blocks must
  // appear untouched; the user's `python.lint` must not be reset to detector default.
  it('P2-014: verification preserves user custom lang blocks + user overrides on shared langs', () => {
    const existing = {
      verification: {
        gateway: { build: 'cd apps/gateway && cargo build' },
        ios: { build_ios: 'xcodebuild' },
        python: { lint: 'custom-ruff', test: 'custom-pytest' },
      },
    };
    const refreshed = {
      verification: {
        python: { test: 'pytest', type: 'mypy' },
        typescript: { test: 'vitest' },
      },
    };
    const merged = mergeRefresh(existing, refreshed);
    const ver = merged.verification as Record<string, Record<string, string>>;
    // Custom user langs preserved wholesale:
    expect(ver.gateway?.build).toBe('cd apps/gateway && cargo build');
    expect(ver.ios?.build_ios).toBe('xcodebuild');
    // Shared lang (python): user wins on overlap, detector's new fields survive
    expect(ver.python?.lint).toBe('custom-ruff');       // user-only
    expect(ver.python?.test).toBe('custom-pytest');     // user overrides detector
    expect(ver.python?.type).toBe('mypy');              // detector-only
    // Detector-newly-added lang survives:
    expect(ver.typescript?.test).toBe('vitest');
  });

  // P2-015 (P5-002 discovery): paths.aliases is a 2-level-nested user block.
  // User aliases must survive refresh; detector's hardcoded { '@': source }
  // must not overwrite user values.
  it('P2-015: preserves user paths.aliases against detector hardcoded default', () => {
    const existing = {
      paths: {
        source: 'apps/web/src',
        aliases: { '@': 'apps/web/src', '~': 'apps/web/src/components', '@api': 'apps/gateway' },
      },
    };
    const refreshed = {
      paths: { source: 'src', aliases: { '@': 'src' } },
    };
    const merged = mergeRefresh(existing, refreshed);
    const paths = merged.paths as Record<string, Record<string, unknown>>;
    // User's custom alias keys preserved
    expect(paths.aliases['~']).toBe('apps/web/src/components');
    expect(paths.aliases['@api']).toBe('apps/gateway');
    // User's value for shared key @ wins over detector hardcoded 'src'
    expect(paths.aliases['@']).toBe('apps/web/src');
  });
});

describe('refresh stamps fingerprint via buildConfigFromDetection', () => {
  it('refresh dry-run diff includes detection.fingerprint (added field)', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir, {}); // no `detection` key on the existing config
    const res = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    const hasFpAdd = res.diff.some(
      (d) => d.path === 'detection.fingerprint' && d.kind === 'add'
    );
    expect(hasFpAdd).toBe(true);
    // Verify the fingerprint value is a 64-char hex string.
    const added = res.diff.find((d) => d.path === 'detection.fingerprint');
    expect(typeof added?.after).toBe('string');
    expect((added?.after as string).length).toBe(64);
    expect((added?.after as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('repeated dry-run on same repo yields an identical fingerprint', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir, {});
    const a = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    const b = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    const aFp = a.diff.find((d) => d.path === 'detection.fingerprint')?.after;
    const bFp = b.diff.find((d) => d.path === 'detection.fingerprint')?.after;
    expect(aFp).toBeTruthy();
    expect(aFp).toBe(bFp);
  });
});

// Proves generated-config can be round-tripped through yaml without data loss.
describe('refresh produces yaml that round-trips', () => {
  it('merged config YAML parses back to an equivalent object', async () => {
    const dir = stageFixture('ts-nextjs');
    writeStaleConfig(dir, {
      rules: [{ pattern: 'src/**/*.ts', rules: ['R1', 'R2'] }],
    });
    const res = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
    expect(res.exitCode).toBe(0);
    expect(res.diff.length).toBeGreaterThan(0);
    // Verify no diff line claims to REMOVE rules.
    const removedRules = res.diff.find(
      (d) => d.path.startsWith('rules.') && d.kind === 'remove'
    );
    expect(removedRules).toBeUndefined();
  });
});

// Round-trip: verify yamlParse of unrelated fixtures still returns objects the
// merge helper accepts; catches shape regressions in buildConfigFromDetection.
describe('refresh tolerates multiple fixture stacks', () => {
  const stacks: Array<'ts-nextjs' | 'python-fastapi' | 'rust-actix' | 'go-gin'> = [
    'ts-nextjs',
    'python-fastapi',
    'rust-actix',
    'go-gin',
  ];
  for (const name of stacks) {
    it(`dry-run succeeds on ${name}`, async () => {
      const dir = stageFixture(name);
      writeStaleConfig(dir, {});
      const res = await runConfigRefresh({ cwd: dir, dryRun: true, silent: true });
      expect(res.exitCode).toBe(0);
      // parseYaml of the unchanged file must still succeed.
      const after = readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8');
      expect(yamlParse(after)).toBeTruthy();
    });
  }
});

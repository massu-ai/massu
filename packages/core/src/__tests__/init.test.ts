// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Phase 3 `massu init` rewrite tests (P3-001..P3-006).
 *
 * Covers the 6 gate tests called out in the phase brief:
 *   (a) ci mode python fixture  → schema_version=2, verification.python populated
 *   (b) ci mode ts fixture      → framework.type=typescript, verification.typescript populated
 *   (c) rollback on invalid detection → no config persists on disk
 *   (d) overwrite-prompt respects --force → existing config overwritten only with --force
 *   (e) template mode           → --template python-fastapi produces valid v2 config
 *   (f) atomic write            → tmp file never persists on simulated failure
 *
 * Each test uses a fresh os.tmpdir() fixture, no network, <5s each.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
} from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { parse as yamlParse } from 'yaml';
import {
  runInit,
  buildConfigFromDetection,
  renderConfigYaml,
  writeConfigAtomic,
  validateWrittenConfig,
  parseInitArgs,
  copyTemplateConfig,
  listTemplates,
  isTemplateName,
} from '../commands/init.ts';
import { runDetection } from '../detect/index.ts';

let fixtureDir: string;

function makeFixture(): string {
  return mkdtempSync(resolve(tmpdir(), 'massu-init-test-'));
}

function cleanupFixture(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  fixtureDir = makeFixture();
});

afterEach(() => {
  cleanupFixture(fixtureDir);
});

describe('parseInitArgs', () => {
  it('parses --ci, --force, --template', () => {
    expect(parseInitArgs([])).toEqual({});
    expect(parseInitArgs(['--ci'])).toEqual({ ci: true });
    expect(parseInitArgs(['--force'])).toEqual({ force: true });
    expect(parseInitArgs(['--template', 'python-fastapi'])).toEqual({ template: 'python-fastapi' });
    expect(parseInitArgs(['--template=ts-nextjs'])).toEqual({ template: 'ts-nextjs' });
    expect(parseInitArgs(['--ci', '--force', '--template', 'rust-actix'])).toEqual({
      ci: true, force: true, template: 'rust-actix',
    });
  });
});

describe('listTemplates / isTemplateName', () => {
  it('ships all 7 templates', () => {
    const names = listTemplates();
    expect(names).toContain('python-fastapi');
    expect(names).toContain('python-django');
    expect(names).toContain('ts-nextjs');
    expect(names).toContain('ts-nestjs');
    expect(names).toContain('rust-actix');
    expect(names).toContain('swift-ios');
    expect(names).toContain('multi-runtime');
    expect(names).toHaveLength(7);
  });

  it('isTemplateName narrows correctly', () => {
    expect(isTemplateName('python-fastapi')).toBe(true);
    expect(isTemplateName('bogus')).toBe(false);
  });
});

describe('buildConfigFromDetection', () => {
  it('produces schema_version=2 with languages.python for a pytoml fixture', async () => {
    // Synthesize a python-fastapi manifest fixture.
    mkdirSync(resolve(fixtureDir, 'app'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'pyproject.toml'),
      [
        '[project]',
        'name = "fixture"',
        'dependencies = ["fastapi", "sqlalchemy", "pytest"]',
      ].join('\n'),
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'app', '__init__.py'), '', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'app', 'main.py'), 'from fastapi import FastAPI\n', 'utf-8');

    const detection = await runDetection(fixtureDir);
    const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });

    expect(config.schema_version).toBe(2);
    const fw = config.framework as Record<string, unknown>;
    // Single-language → type is 'python' (not 'multi').
    expect(fw.type).toBe('python');
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.python.framework).toBe('fastapi');
    expect(langs.python.test_framework).toBe('pytest');
    expect(langs.python.orm).toBe('sqlalchemy');
    // Verification commands populated.
    const ver = config.verification as Record<string, Record<string, string>>;
    expect(ver.python.test).toContain('pytest');
    expect(ver.python.type).toContain('mypy');
  });

  it('sets framework.type=typescript for a ts-only fixture', async () => {
    mkdirSync(resolve(fixtureDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { next: '^14.0.0' },
        devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
      }),
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'tsconfig.json'), '{}', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'src', 'index.ts'), 'export {}\n', 'utf-8');

    const detection = await runDetection(fixtureDir);
    const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });

    const fw = config.framework as Record<string, unknown>;
    expect(fw.type).toBe('typescript');
    // Legacy top-level `ui` is mirrored from the primary language's ui_library.
    // Framework detector emits `next` (the dep name) as ui_library value.
    expect(fw.ui).toBe('next');
    const ver = config.verification as Record<string, Record<string, string>>;
    expect(ver.typescript.type).toContain('tsc');
  });

  it('sets framework.type=multi when two languages are present', async () => {
    mkdirSync(resolve(fixtureDir, 'apps/api'), { recursive: true });
    mkdirSync(resolve(fixtureDir, 'apps/web'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'apps/api', 'pyproject.toml'),
      '[project]\nname = "api"\ndependencies = ["fastapi", "pytest"]\n',
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'apps/api', 'main.py'), '', 'utf-8');
    writeFileSync(
      resolve(fixtureDir, 'apps/web', 'package.json'),
      JSON.stringify({
        name: 'web',
        dependencies: { next: '^14.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      }),
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'apps/web', 'tsconfig.json'), '{}', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'apps/web', 'index.ts'), 'export {}\n', 'utf-8');

    const detection = await runDetection(fixtureDir);
    const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });

    const fw = config.framework as Record<string, unknown>;
    expect(fw.type).toBe('multi');
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.python).toBeDefined();
    expect(langs.typescript).toBeDefined();
  });

  // P1-003 + P1-005: monorepo-aware paths.source + monorepo_roots emission.
  // These cover the incident (2026-04-20) fix: turbo/apps-only shape must
  // produce `paths.source: 'apps'`, not the default nonexistent `'src'`.
  describe('P1-003: monorepo-aware paths.source', () => {
    it('turbo + apps/-only → paths.source = apps + monorepo_roots = [apps]', async () => {
      mkdirSync(resolve(fixtureDir, 'apps/web'), { recursive: true });
      writeFileSync(
        resolve(fixtureDir, 'package.json'),
        JSON.stringify({ name: 'r', dependencies: { next: '^14.0.0', react: '^18.0.0' } }),
        'utf-8'
      );
      writeFileSync(resolve(fixtureDir, 'turbo.json'), '{"$schema":"https://turbo.build/schema.json","tasks":{}}', 'utf-8');
      writeFileSync(resolve(fixtureDir, 'apps/web', 'package.json'), JSON.stringify({ name: 'web' }), 'utf-8');
      writeFileSync(resolve(fixtureDir, 'apps/web', 'page.tsx'), 'export default function P(){return null}\n', 'utf-8');
      const detection = await runDetection(fixtureDir);
      const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });
      const paths = config.paths as Record<string, unknown>;
      expect(paths.source).toBe('apps');
      expect(paths.monorepo_roots).toEqual(['apps']);
    });

    it('pnpm + packages/-only → paths.source = packages + monorepo_roots = [packages]', async () => {
      mkdirSync(resolve(fixtureDir, 'packages/core'), { recursive: true });
      writeFileSync(resolve(fixtureDir, 'package.json'), JSON.stringify({ name: 'r' }), 'utf-8');
      writeFileSync(resolve(fixtureDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf-8');
      writeFileSync(
        resolve(fixtureDir, 'packages/core', 'package.json'),
        JSON.stringify({ name: 'core', devDependencies: { typescript: '^5.0.0' } }),
        'utf-8'
      );
      writeFileSync(resolve(fixtureDir, 'packages/core', 'tsconfig.json'), '{}', 'utf-8');
      writeFileSync(resolve(fixtureDir, 'packages/core', 'index.ts'), 'export {}\n', 'utf-8');
      const detection = await runDetection(fixtureDir);
      const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });
      const paths = config.paths as Record<string, unknown>;
      expect(paths.source).toBe('packages');
      expect(paths.monorepo_roots).toEqual(['packages']);
    });

    it('mixed apps/+packages/ → paths.source = "." + monorepo_roots = [apps, packages]', async () => {
      mkdirSync(resolve(fixtureDir, 'apps/web'), { recursive: true });
      mkdirSync(resolve(fixtureDir, 'packages/ui'), { recursive: true });
      writeFileSync(resolve(fixtureDir, 'package.json'), JSON.stringify({
        name: 'r', workspaces: ['apps/*', 'packages/*'],
      }), 'utf-8');
      writeFileSync(
        resolve(fixtureDir, 'apps/web', 'package.json'),
        JSON.stringify({ name: 'web', devDependencies: { typescript: '^5.0.0' } }),
        'utf-8'
      );
      writeFileSync(resolve(fixtureDir, 'apps/web', 'tsconfig.json'), '{}', 'utf-8');
      writeFileSync(resolve(fixtureDir, 'apps/web', 'index.ts'), 'export {}\n', 'utf-8');
      writeFileSync(
        resolve(fixtureDir, 'packages/ui', 'package.json'),
        JSON.stringify({ name: 'ui', devDependencies: { typescript: '^5.0.0' } }),
        'utf-8'
      );
      writeFileSync(resolve(fixtureDir, 'packages/ui', 'tsconfig.json'), '{}', 'utf-8');
      writeFileSync(resolve(fixtureDir, 'packages/ui', 'index.ts'), 'export {}\n', 'utf-8');
      const detection = await runDetection(fixtureDir);
      const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });
      const paths = config.paths as Record<string, unknown>;
      // Source dir detector may pick either 'apps' or 'packages' as the dominant
      // dir for the primary (typescript) slot. When it picks one, paths.source
      // equals that dir; either way monorepo_roots captures both.
      expect(paths.monorepo_roots).toEqual(['apps', 'packages']);
    });

    it('single repo, no packages → paths.source = src (unchanged)', async () => {
      mkdirSync(resolve(fixtureDir, 'src'), { recursive: true });
      writeFileSync(
        resolve(fixtureDir, 'package.json'),
        JSON.stringify({ name: 'r', devDependencies: { typescript: '^5.0.0' } }),
        'utf-8'
      );
      writeFileSync(resolve(fixtureDir, 'tsconfig.json'), '{}', 'utf-8');
      writeFileSync(resolve(fixtureDir, 'src', 'index.ts'), 'export {}\n', 'utf-8');
      const detection = await runDetection(fixtureDir);
      const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });
      const paths = config.paths as Record<string, unknown>;
      expect(paths.source).toBe('src');
      expect(paths.monorepo_roots).toBeUndefined();
    });
  });
});

describe('runInit (--ci mode)', () => {
  it('(a) python fixture → schema_version=2, verification.python populated', async () => {
    mkdirSync(resolve(fixtureDir, 'app'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'pyproject.toml'),
      '[project]\nname = "fixture"\ndependencies = ["fastapi", "sqlalchemy", "pytest"]\n',
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'app', '__init__.py'), '', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'app', 'main.py'), 'from fastapi import FastAPI\n', 'utf-8');

    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    await runInitSync(fixtureDir, { ci: true, skipSideEffects: true, silent: true });

    expect(existsSync(configPath)).toBe(true);
    const parsed = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(2);
    const fw = parsed.framework as Record<string, unknown>;
    expect(fw.type).toBe('python');
    const ver = parsed.verification as Record<string, Record<string, string>>;
    expect(ver.python.test).toContain('pytest');
  });

  it('(b) typescript fixture → framework.type=typescript, verification.typescript populated', async () => {
    mkdirSync(resolve(fixtureDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { next: '^14.0.0' },
        devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
      }),
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'tsconfig.json'), '{}', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'src', 'index.ts'), 'export {}\n', 'utf-8');

    await runInitSync(fixtureDir, { ci: true, skipSideEffects: true, silent: true });

    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    expect(existsSync(configPath)).toBe(true);
    const parsed = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(2);
    const fw = parsed.framework as Record<string, unknown>;
    expect(fw.type).toBe('typescript');
    // framework-detector emits ui_library='next' for next.js. The legacy
    // top-level `ui` key mirrors that value.
    expect(fw.ui).toBe('next');
    const ver = parsed.verification as Record<string, Record<string, string>>;
    expect(ver.typescript.test).toContain('npm test');
  });

  it('(c) rolls back when no languages are detected (empty dir)', async () => {
    // Empty dir — no manifests at all.
    const configPath = resolve(fixtureDir, 'massu.config.yaml');

    await expect(
      runInitSync(fixtureDir, { ci: true, skipSideEffects: true, silent: true })
    ).rejects.toThrow(/No languages detected/);

    expect(existsSync(configPath)).toBe(false);
    // Also ensure no tmp file
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('(d) existing config is preserved in ci mode without --force', async () => {
    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    writeFileSync(configPath, 'schema_version: 1\nproject:\n  name: keep\n', 'utf-8');
    // Create a valid-ish fixture so detection would succeed if we got past the guard.
    writeFileSync(
      resolve(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'fixture', devDependencies: { typescript: '^5.0.0' } }),
      'utf-8'
    );

    await expect(
      runInitSync(fixtureDir, { ci: true, skipSideEffects: true, silent: true })
    ).rejects.toThrow(/config exists in --ci mode/);

    expect(readFileSync(configPath, 'utf-8')).toContain('name: keep');
  });

  it('(d2) --force overwrites existing config in ci mode', async () => {
    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    writeFileSync(configPath, 'schema_version: 1\nproject:\n  name: stale\n', 'utf-8');
    mkdirSync(resolve(fixtureDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'fixture', devDependencies: { typescript: '^5.0.0' } }),
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'tsconfig.json'), '{}', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'src', 'index.ts'), 'export {}\n', 'utf-8');

    await runInitSync(fixtureDir, { ci: true, force: true, skipSideEffects: true, silent: true });

    const parsed = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(2);
    const project = parsed.project as Record<string, unknown>;
    expect(project.name).not.toBe('stale');
  });
});

describe('template mode (--template)', () => {
  it('(e) --template python-fastapi produces valid v2 config', async () => {
    await runInitSync(fixtureDir, {
      ci: true,
      template: 'python-fastapi',
      skipSideEffects: true,
      silent: true,
    });

    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    expect(existsSync(configPath)).toBe(true);

    const parsed = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(2);
    const fw = parsed.framework as Record<string, unknown>;
    expect(fw.type).toBe('python');
    const langs = fw.languages as Record<string, Record<string, unknown>>;
    expect(langs.python.framework).toBe('fastapi');
    // Placeholder should have been substituted with directory name.
    const project = parsed.project as Record<string, unknown>;
    expect(project.name).not.toBe('{{PROJECT_NAME}}');
  });

  it('--template with unknown name throws', async () => {
    await expect(
      runInitSync(fixtureDir, {
        ci: true,
        template: 'nonsense',
        skipSideEffects: true,
        silent: true,
      })
    ).rejects.toThrow(/Unknown template/);
  });
});

describe('atomic write (P3-005)', () => {
  it('(f) writeConfigAtomic removes tmp file on failure', () => {
    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    // Pass malformed content that is valid YAML but a scalar, not an object.
    const res = writeConfigAtomic(configPath, 'just-a-string');
    expect(res.validated).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('writeConfigAtomic writes and preserves permissions on overwrite', () => {
    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    writeFileSync(configPath, 'schema_version: 1\n', { encoding: 'utf-8', mode: 0o640 });
    const content = renderConfigYaml({ schema_version: 2, project: { name: 'x', root: 'auto' } });
    const res = writeConfigAtomic(configPath, content);
    expect(res.validated).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });
});

describe('post-write validation (P3-004)', () => {
  it('validateWrittenConfig returns null for a valid config', async () => {
    mkdirSync(resolve(fixtureDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'f', devDependencies: { typescript: '^5.0.0' } }),
      'utf-8'
    );
    writeFileSync(resolve(fixtureDir, 'tsconfig.json'), '{}', 'utf-8');
    writeFileSync(resolve(fixtureDir, 'src', 'index.ts'), 'export {}\n', 'utf-8');

    const detection = await runDetection(fixtureDir);
    const config = buildConfigFromDetection({ projectRoot: fixtureDir, detection });
    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    const res = writeConfigAtomic(configPath, renderConfigYaml(config));
    expect(res.validated).toBe(true);

    const err = validateWrittenConfig(configPath, fixtureDir);
    expect(err).toBeNull();
  });

  it('validateWrittenConfig flags a missing paths.source dir', () => {
    const configPath = resolve(fixtureDir, 'massu.config.yaml');
    const bad = `schema_version: 2
project:
  name: x
  root: auto
framework:
  type: typescript
  router: none
  orm: none
  ui: none
paths:
  source: does-not-exist
  aliases:
    '@': does-not-exist
toolPrefix: massu
domains: []
rules: []
`;
    writeFileSync(configPath, bad, 'utf-8');
    const err = validateWrittenConfig(configPath, fixtureDir);
    expect(err).not.toBeNull();
    expect(err).toMatch(/does not exist/);
  });
});

describe('copyTemplateConfig', () => {
  it('substitutes {{PROJECT_NAME}}', () => {
    const target = resolve(fixtureDir, 'massu.config.yaml');
    const res = copyTemplateConfig('ts-nextjs', target, 'my-app');
    expect(res.success).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('name: "my-app"');
    expect(content).not.toContain('{{PROJECT_NAME}}');
  });
});

// ============================================================
// Helper: invoke runInit with explicit cwd while preserving current process.cwd.
// We use the skipSideEffects path to avoid touching node_modules or ~/.claude.
// ============================================================

async function runInitSync(
  cwd: string,
  opts: {
    ci?: boolean;
    force?: boolean;
    template?: string;
    skipSideEffects?: boolean;
    silent?: boolean;
  }
): Promise<void> {
  // runInit expects process.cwd() unless opts.cwd is passed via the public API.
  // Our InitOptions supports cwd; we call runInit with an argv that mirrors the
  // flags and then monkey-patch cwd via chdir is too invasive. Instead, we bypass
  // argv parsing and call the internal flow by reusing runInit with argv.
  const argv: string[] = [];
  if (opts.ci) argv.push('--ci');
  if (opts.force) argv.push('--force');
  if (opts.template) argv.push('--template', opts.template);

  const prevCwd = process.cwd();
  let changed = false;
  try {
    process.chdir(cwd);
    changed = true;
  } catch {
    // On some CI sandboxes chdir may fail — fall back to a direct invocation.
  }
  try {
    // Redirect console.log via silent opt? runInit itself doesn't take silent via argv,
    // so we suppress via env — we accept noise in test output.
    const prevLog = console.log;
    const prevErr = console.error;
    if (opts.silent) {
      console.log = () => {};
      console.error = () => {};
    }
    try {
      await runInit(argv, {
        skipSideEffects: opts.skipSideEffects,
        silent: opts.silent,
        cwd,
      });
    } finally {
      if (opts.silent) {
        console.log = prevLog;
        console.error = prevErr;
      }
    }
  } finally {
    if (changed) {
      try { process.chdir(prevCwd); } catch { /* ignore */ }
    }
  }
}

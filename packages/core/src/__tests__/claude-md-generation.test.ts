// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { scanDirectoryStructure, buildClaudeMdContent } from '../claude-md-templates.ts';
import { generateClaudeMd } from '../commands/init.ts';

const TEST_DIR = resolve(__dirname, '../test-claude-md-tmp');

function makeFramework(overrides: Partial<{ type: string; router: string; orm: string; ui: string }> = {}) {
  return {
    type: overrides.type ?? 'typescript',
    router: overrides.router ?? 'none',
    orm: overrides.orm ?? 'none',
    ui: overrides.ui ?? 'none',
  };
}

function makePython(overrides: Partial<{
  detected: boolean; root: string; hasFastapi: boolean;
  hasSqlalchemy: boolean; hasAlembic: boolean; alembicDir: string | null;
}> = {}) {
  return {
    detected: overrides.detected ?? false,
    root: overrides.root ?? '',
    hasFastapi: overrides.hasFastapi ?? false,
    hasSqlalchemy: overrides.hasSqlalchemy ?? false,
    hasAlembic: overrides.hasAlembic ?? false,
    alembicDir: overrides.alembicDir ?? null,
  };
}

describe('CLAUDE.md Generation', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ---- P-C01: generateClaudeMd tests ----

  describe('generateClaudeMd', () => {
    it('creates CLAUDE.md in empty directory', () => {
      const result = generateClaudeMd(TEST_DIR, makeFramework(), makePython());
      expect(result.created).toBe(true);
      expect(result.skipped).toBe(false);
      expect(existsSync(resolve(TEST_DIR, 'CLAUDE.md'))).toBe(true);
    });

    it('skips if CLAUDE.md already exists', () => {
      writeFileSync(resolve(TEST_DIR, 'CLAUDE.md'), '# Existing content\n', 'utf-8');
      const result = generateClaudeMd(TEST_DIR, makeFramework(), makePython());
      expect(result.created).toBe(false);
      expect(result.skipped).toBe(true);
      // Verify original content preserved
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('# Existing content\n');
    });

    it('content includes project name', () => {
      generateClaudeMd(TEST_DIR, makeFramework(), makePython());
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('test-claude-md-tmp');
    });

    it('content includes detected framework (Next.js)', () => {
      generateClaudeMd(TEST_DIR, makeFramework({ ui: 'nextjs' }), makePython());
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Next.js');
      expect(content).toContain('App Router');
    });

    it('content includes massu workflow section', () => {
      generateClaudeMd(TEST_DIR, makeFramework(), makePython());
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Massu Workflow');
      expect(content).toContain('/massu-create-plan');
    });

    it('content includes memory system section', () => {
      generateClaudeMd(TEST_DIR, makeFramework(), makePython());
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Memory System');
    });

    it('Python/FastAPI project gets FastAPI-specific conventions', () => {
      generateClaudeMd(
        TEST_DIR,
        makeFramework(),
        makePython({ detected: true, hasFastapi: true, root: 'app' }),
      );
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('FastAPI');
      expect(content).toContain('Pydantic');
      expect(content).toContain('APIRouter');
    });

    it('content includes directory structure section', () => {
      // Create some test directories
      mkdirSync(resolve(TEST_DIR, 'src'), { recursive: true });
      mkdirSync(resolve(TEST_DIR, 'tests'), { recursive: true });
      writeFileSync(resolve(TEST_DIR, 'package.json'), '{}', 'utf-8');

      generateClaudeMd(TEST_DIR, makeFramework(), makePython());
      const content = readFileSync(resolve(TEST_DIR, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Directory Structure');
      expect(content).toContain('src/');
      expect(content).toContain('tests/');
    });
  });

  // ---- P-C02: Directory scanner tests ----

  describe('scanDirectoryStructure', () => {
    it('scans fixture directory correctly', () => {
      mkdirSync(resolve(TEST_DIR, 'src/components'), { recursive: true });
      mkdirSync(resolve(TEST_DIR, 'tests'), { recursive: true });
      writeFileSync(resolve(TEST_DIR, 'package.json'), '{}', 'utf-8');
      writeFileSync(resolve(TEST_DIR, 'src/index.ts'), '', 'utf-8');

      const tree = scanDirectoryStructure(TEST_DIR);
      expect(tree).toContain('src/');
      expect(tree).toContain('tests/');
      expect(tree).toContain('package.json');
      expect(tree).toContain('index.ts');
    });

    it('excludes node_modules, .git, __pycache__', () => {
      mkdirSync(resolve(TEST_DIR, 'node_modules/foo'), { recursive: true });
      mkdirSync(resolve(TEST_DIR, '.git/objects'), { recursive: true });
      mkdirSync(resolve(TEST_DIR, '__pycache__'), { recursive: true });
      mkdirSync(resolve(TEST_DIR, 'src'), { recursive: true });

      const tree = scanDirectoryStructure(TEST_DIR);
      expect(tree).not.toContain('node_modules');
      expect(tree).not.toContain('__pycache__');
      expect(tree).toContain('src/');
    });

    it('respects maxDepth parameter', () => {
      mkdirSync(resolve(TEST_DIR, 'a/b/c/d'), { recursive: true });

      const shallow = scanDirectoryStructure(TEST_DIR, 1);
      expect(shallow).toContain('a/');
      expect(shallow).not.toContain('b/');

      const deep = scanDirectoryStructure(TEST_DIR, 3);
      expect(deep).toContain('a/');
      expect(deep).toContain('b/');
      expect(deep).toContain('c/');
    });

    it('handles empty directories', () => {
      const tree = scanDirectoryStructure(TEST_DIR);
      // Should just have the root name
      expect(tree).toContain('test-claude-md-tmp/');
      // No connectors for empty dir
      expect(tree).not.toContain('\u251c');
      expect(tree).not.toContain('\u2514');
    });
  });

  // ---- P-C02 extra: buildClaudeMdContent unit tests ----

  describe('buildClaudeMdContent', () => {
    it('generates content for TypeScript project', () => {
      const content = buildClaudeMdContent('my-app', TEST_DIR, makeFramework(), makePython());
      expect(content).toContain('# my-app');
      expect(content).toContain('Typescript');
      expect(content).toContain('ESM imports');
    });

    it('generates SvelteKit-specific content', () => {
      const content = buildClaudeMdContent(
        'svelte-app', TEST_DIR,
        makeFramework({ ui: 'sveltekit' }),
        makePython(),
      );
      expect(content).toContain('SvelteKit');
      expect(content).toContain('load functions');
      expect(content).toContain('form actions');
    });

    it('generates content with Prisma ORM', () => {
      const content = buildClaudeMdContent(
        'prisma-app', TEST_DIR,
        makeFramework({ orm: 'prisma' }),
        makePython(),
      );
      expect(content).toContain('Prisma');
      expect(content).toContain('prisma/schema.prisma');
    });

    it('generates content with tRPC router', () => {
      const content = buildClaudeMdContent(
        'trpc-app', TEST_DIR,
        makeFramework({ router: 'trpc' }),
        makePython(),
      );
      expect(content).toContain('TRPC');
      expect(content).toContain('Zod input validation');
    });

    it('generates content for Python + SQLAlchemy project', () => {
      const content = buildClaudeMdContent(
        'py-app', TEST_DIR,
        makeFramework(),
        makePython({ detected: true, hasSqlalchemy: true, root: 'app' }),
      );
      expect(content).toContain('Python');
      expect(content).toContain('SQLAlchemy');
      expect(content).toContain('type hints');
    });

    it('includes Critical Rules section', () => {
      const content = buildClaudeMdContent('app', TEST_DIR, makeFramework(), makePython());
      expect(content).toContain('Critical Rules');
      expect(content).toContain('Never commit secrets');
    });
  });
});

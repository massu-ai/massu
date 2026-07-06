// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { resetConfig } from '../config.ts';
import {
  getDocsToolDefinitions,
  handleDocsToolCall,
} from '../docs-tools.ts';

// The help site path resolves to `../<project.name>-help` relative to the
// project root. By naming the project `proj/inner` and rooting the temp
// project at a directory whose basename is `proj`, the `../proj/...` segment
// cancels back into the root so the help directory lives INSIDE the root and
// survives the ensureWithinRoot() path-traversal guard. This lets the full
// audit/coverage logic execute against a real on-disk help site.
const TEST_DIR = resolve(__dirname, '../test-docs-tools-cov-tmp');
const PROJ_DIR = resolve(TEST_DIR, 'proj');
const HELP_DIR = resolve(PROJ_DIR, 'inner-help');

function write(path: string, content: string) {
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function writeConfig() {
  write(resolve(PROJ_DIR, 'massu.config.yaml'), 'project:\n  name: proj/inner\npaths:\n  source: src\n');
}

function writeDocsMap(map: unknown) {
  write(resolve(PROJ_DIR, '.massu/docs-map.json'), JSON.stringify(map));
}

const FULL_MAP = {
  version: 1,
  mappings: [
    {
      id: 'dash',
      helpPage: 'pages/dash.mdx',
      appRoutes: ['src/app/dash/**'],
      routers: ['dash.ts'],
      components: ['src/components/Dash*.tsx'],
      keywords: ['dashboard'],
    },
    {
      id: 'users',
      helpPage: 'pages/users.mdx',
      appRoutes: ['src/app/users/**'],
      routers: ['users.ts'],
      components: [],
      keywords: [],
    },
  ],
  userGuideInheritance: {
    examples: { 'getting-started': 'dash' },
  },
};

describe('docs-tools (module handlers)', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(PROJ_DIR, { recursive: true });
    writeConfig();
    process.chdir(PROJ_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('getDocsToolDefinitions', () => {
    it('returns docs_audit and docs_coverage tool definitions with prefix', () => {
      const defs = getDocsToolDefinitions();
      expect(defs).toHaveLength(2);
      const names = defs.map(d => d.name);
      expect(names).toContain('massu_docs_audit');
      expect(names).toContain('massu_docs_coverage');
      const audit = defs.find(d => d.name === 'massu_docs_audit')!;
      expect(audit.inputSchema.required).toContain('changed_files');
      expect(audit.inputSchema.properties).toHaveProperty('changed_files');
    });
  });

  describe('handleDocsToolCall routing', () => {
    it('returns an error message for an unknown docs tool', () => {
      writeDocsMap(FULL_MAP);
      const r = handleDocsToolCall('massu_docs_bogus', {});
      expect(r.content[0].text).toContain('Unknown docs tool');
    });

    it('routes a non-prefixed base name', () => {
      writeDocsMap(FULL_MAP);
      const r = handleDocsToolCall('docs_audit', { changed_files: [] });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.summary).toContain('No changed files');
    });
  });

  describe('handleDocsAudit', () => {
    it('reports no files when changed_files is empty', () => {
      writeDocsMap(FULL_MAP);
      const r = handleDocsToolCall('massu_docs_audit', { changed_files: [] });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.affectedPages).toEqual([]);
      expect(parsed.summary).toContain('No changed files');
    });

    it('reports zero affected pages when nothing matches', () => {
      writeDocsMap(FULL_MAP);
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['README.md', 'src/unrelated/thing.ts'],
      });
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed.affectedPages).toEqual([]);
      expect(parsed.summary).toContain('0 help pages affected');
    });

    it('flags NEW status when the help page does not exist', () => {
      writeDocsMap(FULL_MAP);
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/app/users/page.tsx'],
      });
      const parsed = JSON.parse(r.content[0].text);
      const page = parsed.affectedPages.find((p: { mappingId: string }) => p.mappingId === 'users');
      expect(page).toBeDefined();
      expect(page.status).toBe('NEW');
      expect(page.reason).toContain('does not exist');
      expect(parsed.summary).toContain('NEW');
    });

    it('flags STALE for undocumented router procedures + old lastVerified + commit hint', () => {
      writeDocsMap(FULL_MAP);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        '---\nlastVerified: 2020-01-01\nstatus: published\n---\n\n## Overview\n\nDashboard docs.\n\n### Details\n\nmore.\n'
      );
      write(
        resolve(PROJ_DIR, 'src/server/api/routers/dash.ts'),
        'export const dashRouter = router({\n  list: protectedProcedure.query(() => {}),\n  remove: protectedProcedure.mutation(() => {}),\n});\n'
      );
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/server/api/routers/dash.ts', 'src/app/dash/page.tsx'],
        commit_message: 'add new feature for dashboard',
      });
      const parsed = JSON.parse(r.content[0].text);
      const page = parsed.affectedPages.find((p: { mappingId: string }) => p.mappingId === 'dash');
      expect(page.status).toBe('STALE');
      expect(page.reason).toContain('not documented');
      expect(page.reason).toContain('list');
      expect(page.reason).toContain('days old');
      expect(page.reason).toContain('new functionality');
      expect(page.sections).toContain('## Overview');
      expect(page.sections).toContain('### Details');
    });

    it('flags STALE when no lastVerified frontmatter is present', () => {
      writeDocsMap(FULL_MAP);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        '---\nstatus: published\n---\n\n## Overview\n\nDocs body.\n'
      );
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/app/dash/page.tsx'],
      });
      const parsed = JSON.parse(r.content[0].text);
      const page = parsed.affectedPages.find((p: { mappingId: string }) => p.mappingId === 'dash');
      expect(page.status).toBe('STALE');
      expect(page.reason).toContain('No lastVerified');
    });

    it('reports OK when recently verified and no other staleness signals', () => {
      writeDocsMap(FULL_MAP);
      const recent = new Date().toISOString().slice(0, 10);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        `---\nlastVerified: ${recent}\nstatus: published\n---\n\n## Overview\n\nUp to date.\n`
      );
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/components/DashWidget.tsx'],
      });
      const parsed = JSON.parse(r.content[0].text);
      const page = parsed.affectedPages.find((p: { mappingId: string }) => p.mappingId === 'dash');
      expect(page.status).toBe('OK');
      expect(page.reason).toContain('current');
      expect(parsed.summary).toContain('OK');
    });

    it('does not flag procedures documented via camelCase / spaced-word form', () => {
      const map = {
        version: 1,
        mappings: [
          {
            id: 'dash',
            helpPage: 'pages/dash.mdx',
            appRoutes: [],
            routers: ['dash.ts'],
            components: [],
            keywords: [],
          },
        ],
        userGuideInheritance: { examples: {} },
      };
      writeDocsMap(map);
      const recent = new Date().toISOString().slice(0, 10);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        `---\nlastVerified: ${recent}\n---\n\n## API\n\nThe bulk update status endpoint works.\n`
      );
      write(
        resolve(PROJ_DIR, 'src/server/api/routers/dash.ts'),
        'export const r = router({\n  bulkUpdateStatus: protectedProcedure.mutation(() => {}),\n});\n'
      );
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/server/api/routers/dash.ts'],
      });
      const parsed = JSON.parse(r.content[0].text);
      const page = parsed.affectedPages.find((p: { mappingId: string }) => p.mappingId === 'dash');
      expect(page.reason).not.toContain('not documented');
    });

    it('flags inherited user guides when parent mapping is stale', () => {
      writeDocsMap(FULL_MAP);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        '---\nstatus: published\n---\n\n## Overview\n\nbody.\n'
      );
      write(
        resolve(HELP_DIR, 'pages/user-guides/getting-started/index.mdx'),
        '## Getting Started\n\nGuide body without frontmatter.\n'
      );
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/app/dash/page.tsx'],
      });
      const parsed = JSON.parse(r.content[0].text);
      const guide = parsed.affectedPages.find(
        (p: { mappingId: string }) => p.mappingId === 'dash:getting-started'
      );
      expect(guide).toBeDefined();
      expect(guide.status).toBe('STALE');
      expect(guide.reason).toContain('Inherited from parent');
      expect(guide.sections).toContain('## Getting Started');
    });

    it('matches routers via the /routers/<name> path suffix', () => {
      writeDocsMap(FULL_MAP);
      const recent = new Date().toISOString().slice(0, 10);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        `---\nlastVerified: ${recent}\n---\n\n## Docs\n\nbody covering list and remove procedures.\n`
      );
      // No source router on disk -> extractProcedureNames returns [] via both
      // the primary and alt-path miss, exercising that early-return branch.
      const r = handleDocsToolCall('massu_docs_audit', {
        changed_files: ['src/server/api/routers/dash.ts'],
      });
      const parsed = JSON.parse(r.content[0].text);
      const page = parsed.affectedPages.find((p: { mappingId: string }) => p.mappingId === 'dash');
      expect(page).toBeDefined();
    });

    it('throws when docs-map.json is missing', () => {
      expect(() =>
        handleDocsToolCall('massu_docs_audit', { changed_files: ['x.ts'] })
      ).toThrow(/docs-map.json not found/);
    });
  });

  describe('handleDocsCoverage', () => {
    it('reports full coverage for an existing content page (filtered domain)', () => {
      writeDocsMap(FULL_MAP);
      write(
        resolve(HELP_DIR, 'pages/dash.mdx'),
        '---\nlastVerified: 2024-01-01\nstatus: published\n---\n\n' +
          Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
      );
      const r = handleDocsToolCall('massu_docs_coverage', { domain: 'dash' });
      const out = r.content[0].text;
      expect(out).toContain('Docs Coverage Report (dash)');
      expect(out).toContain('Total mappings: 1');
      expect(out).toContain('Pages existing: 1');
      expect(out).toContain('Coverage: 100%');
      expect(out).toContain('[OK] dash');
      expect(out).toContain('verified: 2024-01-01');
      expect(out).toContain('[published]');
    });

    it('lists gaps and MISSING pages when help pages are absent', () => {
      writeDocsMap(FULL_MAP);
      const r = handleDocsToolCall('massu_docs_coverage', {});
      const out = r.content[0].text;
      expect(out).toContain('Total mappings: 2');
      expect(out).toContain('### Gaps');
      expect(out).toContain('Help page missing');
      expect(out).toContain('[MISSING]');
      expect(out).toContain('not verified');
      expect(out).toContain('Coverage: 0%');
    });

    it('marks a thin page (<= 10 lines) as THIN', () => {
      writeDocsMap(FULL_MAP);
      write(resolve(HELP_DIR, 'pages/dash.mdx'), '---\n---\n# Title\nshort\n');
      const r = handleDocsToolCall('massu_docs_coverage', { domain: 'dash' });
      const out = r.content[0].text;
      expect(out).toContain('[THIN] dash');
      expect(out).toContain('Pages with content: 0');
    });
  });
});

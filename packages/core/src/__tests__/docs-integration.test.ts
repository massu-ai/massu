// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { getResolvedPaths } from '../config.ts';

/**
 * Integration tests for docs tools against the real help site.
 * These tests verify the tools work with actual MDX files.
 */

const HELP_SITE_PATH = getResolvedPaths().helpSitePath;
const DOCS_MAP_PATH = getResolvedPaths().docsMapPath;

describe('docs integration: real help site', () => {
  let docsMap: any;

  beforeAll(() => {
    // Skip tests if help site is not available
    if (!existsSync(HELP_SITE_PATH)) {
      console.warn('Help site not found at', HELP_SITE_PATH);
      return;
    }
    docsMap = JSON.parse(readFileSync(DOCS_MAP_PATH, 'utf-8'));
  });

  it('help site exists and has pages directory', () => {
    if (!existsSync(HELP_SITE_PATH)) return; // Skip when help site not available
    expect(existsSync(resolve(HELP_SITE_PATH, 'pages'))).toBe(true);
  });

  it('all mapped help pages exist', () => {
    if (!docsMap) return;

    const missing: string[] = [];
    for (const mapping of docsMap.mappings) {
      const fullPath = resolve(HELP_SITE_PATH, mapping.helpPage);
      if (!existsSync(fullPath)) {
        missing.push(`${mapping.id}: ${mapping.helpPage}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('coverage report includes all 8+ top-level categories', () => {
    if (!docsMap) return;

    const topLevelPages = docsMap.mappings.filter((m: any) =>
      m.helpPage.startsWith('pages/') && !m.helpPage.includes('/index.mdx') ||
      m.helpPage.endsWith('/index.mdx')
    );
    expect(topLevelPages.length).toBeGreaterThanOrEqual(8);
  });

  it('frontmatter parsing works on real MDX files', () => {
    if (!docsMap) return;

    // Test a few real MDX files
    const testPages = ['pages/dashboard.mdx', 'pages/users.mdx', 'pages/billing.mdx'];
    for (const page of testPages) {
      const fullPath = resolve(HELP_SITE_PATH, page);
      if (!existsSync(fullPath)) continue;

      const content = readFileSync(fullPath, 'utf-8');

      // Check frontmatter exists
      expect(content.startsWith('---')).toBe(true);

      // Extract frontmatter
      const endIndex = content.indexOf('---', 3);
      expect(endIndex).toBeGreaterThan(3);

      const frontmatter = content.substring(3, endIndex).trim();
      expect(frontmatter).toContain('lastVerified');
      expect(frontmatter).toContain('status');
    }
  });

  it('known router change maps to correct help page', () => {
    if (!docsMap) return;

    // Simulate: dashboard.ts changed, should map to dashboard help page
    const changedFile = 'src/server/api/routers/dashboard.ts';
    const fileName = 'dashboard.ts';

    let foundMapping = false;
    for (const mapping of docsMap.mappings) {
      if (mapping.routers.includes(fileName)) {
        if (mapping.id === 'dashboard') {
          foundMapping = true;
          // Verify the help page exists
          const helpPath = resolve(HELP_SITE_PATH, mapping.helpPage);
          expect(existsSync(helpPath)).toBe(true);
        }
      }
    }
    expect(foundMapping).toBe(true);
  });

  it('non-user-facing changes return no affected mappings', () => {
    if (!docsMap) return;

    const nonUserFiles = [
      'scripts/pattern-scanner.sh',
      'package.json',
      '.gitignore',
      'tsconfig.json',
      'jest.config.js',
    ];

    for (const file of nonUserFiles) {
      const fileName = file.split('/').pop() || '';
      let matched = false;

      for (const mapping of docsMap.mappings) {
        if (mapping.routers.includes(fileName)) {
          matched = true;
          break;
        }
      }

      expect(matched).toBe(false);
    }
  });

  it('changelog page exists', () => {
    if (!existsSync(HELP_SITE_PATH)) return;
    const changelogPath = resolve(HELP_SITE_PATH, 'pages/changelog.mdx');
    expect(existsSync(changelogPath)).toBe(true);

    const content = readFileSync(changelogPath, 'utf-8');
    expect(content).toContain('lastVerified');
    expect(content).toContain("What's New");
  });

  it('_meta.json includes changelog', () => {
    if (!existsSync(HELP_SITE_PATH)) return;
    const metaPath = resolve(HELP_SITE_PATH, 'pages/_meta.json');
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(meta.changelog).toBeDefined();
  });

  it('all MDX files have lastVerified frontmatter', () => {
    if (!existsSync(HELP_SITE_PATH)) return;

    function findMdxFiles(dir: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory() && entry !== 'node_modules' && entry !== '.next') {
          files.push(...findMdxFiles(fullPath));
        } else if (entry.endsWith('.mdx')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const mdxFiles = findMdxFiles(resolve(HELP_SITE_PATH, 'pages'));
    const missingFrontmatter: string[] = [];

    for (const file of mdxFiles) {
      const content = readFileSync(file, 'utf-8');
      if (!content.includes('lastVerified')) {
        missingFrontmatter.push(file.replace(HELP_SITE_PATH + '/', ''));
      }
    }

    expect(missingFrontmatter).toEqual([]);
    // Expect at least 5 MDX files for a meaningful docs site
    expect(mdxFiles.length).toBeGreaterThanOrEqual(5);
  });
});

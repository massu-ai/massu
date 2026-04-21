// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Source Directory Detector (P1-003)
 * ==================================
 *
 * For each detected language, glob files of that type repo-wide (honoring
 * .gitignore and a hard-coded ignore set), then cluster by common prefix
 * directory and pick the directory with the highest file density.
 *
 * Handles:
 *   - Colocated tests (src/**​/*.test.ts next to source). Sets `colocated: true`
 *     on the language entry when test files are <30% of a dir's file count
 *     AND no dedicated tests/__tests__/ dir exists.
 *   - Top-level `tests/` or `__tests__/` directories (honored as test_dirs).
 *   - Monorepo packages/apps/services/libs/modules subtrees (each treated as
 *     a workspace root).
 *
 * Security (CR-3, CR-9):
 *   - Glob roots strictly inside projectRoot. Symlinks escaping projectRoot
 *     are rejected.
 *   - Secret-ish files (.env*, *.pem, *.key, .aws/, .ssh/, credentials.json)
 *     are excluded from globs.
 *   - Only the filename is ever read — never file contents.
 *
 * Usage:
 * ```ts
 * import { detectSourceDirs } from './detect/source-dir-detector.ts';
 * const map = detectSourceDirs('/repo', ['python', 'typescript']);
 * ```
 */

import { realpathSync } from 'fs';
import { resolve } from 'path';
import fg from 'fast-glob';
import type { SupportedLanguage } from './package-detector.ts';

export interface SourceDirInfo {
  /** Source directories (relative to projectRoot, forward-slash). */
  source_dirs: string[];
  /** Test directories (relative to projectRoot, forward-slash). */
  test_dirs: string[];
  /** True when tests live next to source (no dedicated tests/ dir). */
  colocated: boolean;
  /** Number of source files detected for this language. */
  file_count: number;
}

export type SourceDirMap = Partial<Record<SupportedLanguage, SourceDirInfo>>;

const IGNORE_PATTERNS: string[] = [
  '**/node_modules/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/dist/**',
  '**/build/**',
  '**/.build/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.massu/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/DerivedData/**',
  '**/Pods/**',
  // Secret-ish patterns
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/.aws/**',
  '**/.ssh/**',
  '**/credentials.json',
  '**/*.p12',
  '**/*.pfx',
];

const EXTENSIONS: Record<SupportedLanguage, string[]> = {
  python: ['py'],
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  rust: ['rs'],
  swift: ['swift'],
  go: ['go'],
  java: ['java', 'kt'],
  ruby: ['rb'],
};

const TEST_FILE_PATTERNS: Record<SupportedLanguage, RegExp[]> = {
  python: [/_test\.py$/, /test_[^/]*\.py$/],
  typescript: [/\.test\.tsx?$/, /\.spec\.tsx?$/],
  javascript: [/\.test\.[mc]?jsx?$/, /\.spec\.[mc]?jsx?$/],
  rust: [/tests\/.*\.rs$/],
  swift: [/Tests\//],
  go: [/_test\.go$/],
  java: [/Test[^/]*\.(java|kt)$/, /[^/]*Test\.(java|kt)$/],
  ruby: [/_spec\.rb$/, /_test\.rb$/],
};

const TEST_DIR_KEYWORDS = ['tests', 'test', '__tests__', 'spec', 'specs'];

function extsFor(language: SupportedLanguage): string[] {
  return EXTENSIONS[language] ?? [];
}

/**
 * Extensions for a language, with optional fallback for javascript-only repos
 * that still contain `.ts`/`.tsx` files (no `typescript` manifest, no
 * `tsconfig.json`). Fixes the bug where `apps/web/page.tsx` in a plain-JS
 * monorepo is invisible to the javascript glob, causing `init --ci` to fall
 * back to the nonexistent `src/`. See plan item P1-001 and incident
 * `2026-04-20-massu-core-monorepo-paths-source.md`.
 */
function extsWithFallback(
  language: SupportedLanguage,
  fallbackTsForJs: boolean
): string[] {
  const base = extsFor(language);
  if (language === 'javascript' && fallbackTsForJs) {
    return [...base, 'ts', 'tsx'];
  }
  return base;
}

function isTestPath(language: SupportedLanguage, path: string): boolean {
  // Any dedicated test-dir keyword in the path segments
  const segments = path.split('/');
  for (const seg of segments) {
    if (TEST_DIR_KEYWORDS.includes(seg)) return true;
  }
  const patterns = TEST_FILE_PATTERNS[language] ?? [];
  return patterns.some((re) => re.test(path));
}

/** Get the top-level directory segment of a relative path (or '.' for root). */
function topSegment(rel: string): string {
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : '.';
}

/**
 * Check that a path (after realpath) is inside the projectRoot.
 * Symlinks escaping the tree are rejected.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realCand = realpathSync(resolve(root, candidate));
    return realCand === realRoot || realCand.startsWith(realRoot + '/');
  } catch {
    return false;
  }
}

/**
 * Detect source and test directories per language.
 *
 * @param projectRoot absolute path to repo root
 * @param languages   list of languages to probe (derived from P1-001 manifests)
 * @param opts        optional flags:
 *   - `fallbackTsForJs`: when true AND the language is `javascript` AND no
 *     `typescript` manifest was discovered, also glob `.ts`/`.tsx`. This is
 *     the P1-001 fix for plain-JS monorepos (e.g. turbo with `next` in a
 *     package.json that lacks a typescript dep) that still use `.tsx`.
 */
export function detectSourceDirs(
  projectRoot: string,
  languages: SupportedLanguage[],
  opts?: { fallbackTsForJs?: boolean }
): SourceDirMap {
  const fallbackTsForJs = opts?.fallbackTsForJs ?? false;
  const out: SourceDirMap = {};
  for (const lang of languages) {
    const exts = extsWithFallback(lang, fallbackTsForJs);
    if (exts.length === 0) continue;
    const patterns = exts.map((e) => `**/*.${e}`);
    let files: string[];
    try {
      files = fg.sync(patterns, {
        cwd: projectRoot,
        dot: false,
        ignore: IGNORE_PATTERNS,
        followSymbolicLinks: false,
        suppressErrors: true,
      });
    } catch {
      files = [];
    }

    // Drop any file whose resolved realpath escapes the root (defence in depth).
    files = files.filter((f) => isInsideRoot(projectRoot, f));

    if (files.length === 0) {
      continue;
    }

    // Split into source vs test files.
    const sourceFiles: string[] = [];
    const testFiles: string[] = [];
    for (const f of files) {
      if (isTestPath(lang, f)) testFiles.push(f);
      else sourceFiles.push(f);
    }

    // Cluster by top segment.
    const srcCluster = new Map<string, number>();
    for (const f of sourceFiles) {
      const k = topSegment(f);
      srcCluster.set(k, (srcCluster.get(k) ?? 0) + 1);
    }
    const testCluster = new Map<string, number>();
    for (const f of testFiles) {
      const k = topSegment(f);
      testCluster.set(k, (testCluster.get(k) ?? 0) + 1);
    }

    const source_dirs: string[] = [];
    const test_dirs: string[] = [];

    // Any top segment with at least one source file counts.
    // Sort by density desc, then name asc for determinism.
    const srcSorted = [...srcCluster.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    for (const [seg] of srcSorted) source_dirs.push(seg);

    // Test dirs: any top-level dir named in TEST_DIR_KEYWORDS that accrued files,
    // plus any top segment with test files.
    const testSet = new Set<string>();
    for (const [seg] of testCluster.entries()) {
      if (TEST_DIR_KEYWORDS.includes(seg)) testSet.add(seg);
    }
    // Also pick up "tests/" under each source dir — e.g. apps/ai-service/tests/
    // Glob again just for test dirs this language may have.
    let testDirHits: string[] = [];
    try {
      testDirHits = fg.sync(
        TEST_DIR_KEYWORDS.map((k) => `**/${k}/**/*.${exts[0]}`),
        {
          cwd: projectRoot,
          dot: false,
          ignore: IGNORE_PATTERNS,
          followSymbolicLinks: false,
          suppressErrors: true,
        }
      );
    } catch {
      testDirHits = [];
    }
    const testPrefixes = new Set<string>();
    for (const f of testDirHits) {
      // Keep the prefix up to and including the test keyword dir
      const segs = f.split('/');
      for (let i = 0; i < segs.length; i++) {
        if (TEST_DIR_KEYWORDS.includes(segs[i])) {
          testPrefixes.add(segs.slice(0, i + 1).join('/'));
          break;
        }
      }
    }
    for (const p of testPrefixes) testSet.add(p);
    for (const seg of testSet) test_dirs.push(seg);
    test_dirs.sort();

    // Colocated if test_dirs set is empty AND test files exist AND testFiles/(src+test) < 0.3
    const totalFiles = sourceFiles.length + testFiles.length;
    const testRatio = totalFiles === 0 ? 0 : testFiles.length / totalFiles;
    const hasDedicatedTestDir = test_dirs.length > 0;
    const colocated =
      !hasDedicatedTestDir && testFiles.length > 0 && testRatio < 0.3;
    if (colocated) {
      for (const s of source_dirs) if (!test_dirs.includes(s)) test_dirs.push(s);
    }

    out[lang] = {
      source_dirs,
      test_dirs,
      colocated,
      file_count: files.length,
    };
  }
  return out;
}

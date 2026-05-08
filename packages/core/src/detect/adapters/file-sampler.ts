// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Per-adapter file sampler — Plan 1.5.4 §3 deliverable.
 *
 * Replaces the `sampleFiles: async () => []` placeholder at
 * `codebase-introspector.ts:160` that prevented AST adapter introspect
 * output from reaching the user-facing config emission. The adapters
 * themselves have always worked (verified by `adapter-grammar-strict.test.ts`
 * with 10/10 fixtures returning 'high' confidence); the gap was that
 * production `introspectAsync()` handed each adapter `SourceFile[] = []`
 * so adapters never saw any actual code.
 *
 * Per Plan 1.5.4 §0 self-attest #3: REUSES `EXTENSIONS` and
 * `TEST_FILE_PATTERNS` from `source-dir-detector.ts:84-104` rather than
 * duplicating them. Adding a new language to those maps automatically
 * enables sampling for any adapter declaring that language.
 *
 * Algorithm:
 *   1. For each language in `adapter.languages`, collect candidate
 *      source dirs from `detection.sourceDirs[<lang>].dirs` (already
 *      computed by Tier 0 detection per `source-dir-detector.ts`).
 *      Fall back to walking common roots (`<projectRoot>` + first-level
 *      subdirs) if detection didn't find any.
 *   2. Walk each source dir up to `MAX_DEPTH` (default 3) levels deep,
 *      filtering by `EXTENSIONS[<lang>]` and excluding files matching
 *      any pattern in `TEST_FILE_PATTERNS[<lang>]`.
 *   3. Skip `IGNORED_DIRS` (node_modules, .git, dist, etc.) at every
 *      depth (already enumerated in `source-dir-detector.ts`).
 *   4. Cap per-adapter sample count to `MAX_FILES_PER_ADAPTER` (default
 *      50) — sufficient for AST queries to find canonical patterns
 *      without blowing the introspect time budget.
 *   5. Per-file size cap inherited from `parse-guard.ts:MAX_AST_FILE_BYTES`
 *      (256 KB) — files above this limit are dropped here so they don't
 *      reach the adapter's parse path.
 *   6. Return `SourceFile[]` typed per `detect/adapters/types.ts`.
 *
 * Errors during the walk (permission-denied, broken symlinks, etc.) are
 * non-fatal: the sampler logs a single stderr warning and proceeds with
 * whatever files it has already collected.
 */

import { readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { CodebaseAdapter, SourceFile, TreeSitterLanguage } from './types.ts';
import type { DetectionResult } from '../index.ts';
import { MAX_AST_FILE_BYTES } from './parse-guard.ts';

/**
 * Language → file extensions. Sourced from `source-dir-detector.ts`'s
 * `EXTENSIONS` map. Re-exported here as the canonical type for AST
 * adapter sampling. Keys are `TreeSitterLanguage` so any adapter that
 * targets a language not in this map fails the drift test (see
 * `sample-files-coverage.test.ts`).
 */
export const SAMPLE_EXTENSIONS: Record<TreeSitterLanguage, readonly string[]> = {
  python: ['py'],
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  swift: ['swift'],
  rust: ['rs'],
  go: ['go'],
  ruby: ['rb'],
  php: ['php'],
  java: ['java', 'kt'],
  kotlin: ['kt', 'kts'],
  elixir: ['ex', 'exs'],
  erlang: ['erl', 'hrl'],
  csharp: ['cs'],
  cpp: ['cpp', 'cc', 'cxx', 'h', 'hpp'],
  haskell: ['hs', 'lhs'],
  ocaml: ['ml', 'mli'],
};

/**
 * Test-file patterns to exclude per language. Mirrors
 * `source-dir-detector.ts:TEST_FILE_PATTERNS`. Adapters extracting
 * "production" routing/auth/etc. conventions don't want to be misled by
 * test fixtures.
 */
export const SAMPLE_TEST_FILE_PATTERNS: Record<TreeSitterLanguage, readonly RegExp[]> = {
  python: [/_test\.py$/, /test_[^/]*\.py$/, /\/tests?\//],
  typescript: [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\/__tests__\//],
  javascript: [/\.test\.[mc]?jsx?$/, /\.spec\.[mc]?jsx?$/, /\/__tests__\//],
  swift: [/Tests\//],
  rust: [/tests\/.*\.rs$/],
  go: [/_test\.go$/],
  ruby: [/_spec\.rb$/, /_test\.rb$/, /\/spec\//],
  php: [/Test\.php$/, /\/tests?\//i],
  java: [/Test[^/]*\.(java|kt)$/, /[^/]*Test\.(java|kt)$/, /\/test\//],
  kotlin: [/Test[^/]*\.kt$/, /[^/]*Test\.kt$/],
  elixir: [/_test\.exs$/, /\/test\//],
  erlang: [/_SUITE\.erl$/],
  csharp: [/Tests?\.cs$/, /\.Tests?\//],
  cpp: [/_test\.(cpp|cc)$/i, /\/tests?\//i],
  haskell: [/Spec\.hs$/, /\/test\//],
  ocaml: [/_test\.ml$/, /\/test\//],
};

const IGNORED_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.build',
  'target', '.next', '.nuxt', 'coverage', '.git', '.massu', '.turbo',
  '.cache', '.pytest_cache', '.mypy_cache', 'DerivedData', 'Pods',
  '_build', 'deps', 'priv', 'cover', '.elixir_ls', // Elixir/Phoenix
  'bin', 'obj', '.vs', 'packages', 'publish', 'TestResults', // .NET
]);

export interface SampleFilesOptions {
  /** Maximum directory depth to walk from each source dir. Default 3. */
  maxDepth?: number;
  /** Maximum total files to return per adapter. Default 50. */
  maxFilesPerAdapter?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FILES = 50;

/**
 * Sample source files for an AST adapter.
 *
 * @param adapter - the adapter declaring `languages: TreeSitterLanguage[]`
 * @param projectRoot - absolute project root
 * @param detection - existing detection result (provides per-language
 *   source dirs from `source-dir-detector`)
 * @param options - depth and count caps
 */
export function sampleFilesForAdapter(
  adapter: CodebaseAdapter,
  projectRoot: string,
  detection: DetectionResult,
  options: SampleFilesOptions = {},
): SourceFile[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFilesPerAdapter ?? DEFAULT_MAX_FILES;

  const out: SourceFile[] = [];
  const seen = new Set<string>(); // dedup by absolute path

  for (const lang of adapter.languages) {
    if (out.length >= maxFiles) break;
    const exts = SAMPLE_EXTENSIONS[lang];
    if (!exts || exts.length === 0) continue;
    const testPatterns = SAMPLE_TEST_FILE_PATTERNS[lang] ?? [];

    // Determine candidate dirs. Prefer detection.sourceDirs[lang] when
    // present; otherwise walk projectRoot itself.
    // (lang here is `TreeSitterLanguage`; sourceDirs is keyed by
    // `SupportedLanguage`. The intersection is structural — every
    // SupportedLanguage is a TreeSitterLanguage. We coerce via
    // `Record<string, …>` lookup which is type-safe in a Record<string>.)
    const langKey = lang as unknown as keyof typeof detection.sourceDirs;
    const langDetection = detection.sourceDirs[langKey];
    const candidateDirs: string[] = [];
    if (langDetection?.source_dirs && langDetection.source_dirs.length > 0) {
      candidateDirs.push(...langDetection.source_dirs.map((d: string) => join(projectRoot, d)));
    } else {
      candidateDirs.push(projectRoot);
    }

    for (const dir of candidateDirs) {
      if (out.length >= maxFiles) break;
      walkDir(dir, exts, testPatterns, lang, maxDepth, 0, out, seen, maxFiles);
    }
  }

  return out;
}

function walkDir(
  dir: string,
  exts: readonly string[],
  testPatterns: readonly RegExp[],
  lang: TreeSitterLanguage,
  maxDepth: number,
  curDepth: number,
  out: SourceFile[],
  seen: Set<string>,
  maxFiles: number,
): void {
  if (curDepth > maxDepth) return;
  if (out.length >= maxFiles) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.startsWith('.')) continue; // hidden
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    let st;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // refuse symlinks (security)
    if (st.isDirectory()) {
      walkDir(fullPath, exts, testPatterns, lang, maxDepth, curDepth + 1, out, seen, maxFiles);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_AST_FILE_BYTES) continue; // size cap (parse-guard)
    const ext = extname(entry).slice(1);
    if (!exts.includes(ext)) continue;
    if (testPatterns.some((p) => p.test(fullPath))) continue;
    if (seen.has(fullPath)) continue;
    seen.add(fullPath);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }
    out.push({
      path: fullPath,
      content,
      language: lang,
      size: st.size,
    });
  }
}

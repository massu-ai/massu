// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Watch glob derivation.
 *
 * Watch surface = manifest files (always) + source directories
 * (from massu.config.yaml's paths.* and framework.languages.*.source_dirs,
 * or fallback safe-default globs when both absent), bounded by exclusion
 * globs.
 */

import type { Config } from '../config.ts';

export const ALWAYS_WATCH_FILES = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  '*.csproj',
  'mix.exs',
  'requirements*.txt',
  'setup.py',
] as const;

export const FALLBACK_SOURCE_GLOBS = [
  'src/**',
  'app/**',
  'apps/**',
  'packages/**',
  'lib/**',
  'cmd/**',
] as const;

export const DEFAULT_EXCLUSIONS = [
  '**/node_modules/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/**',
  '**/build/**',
  '**/dist/**',
  '**/.git/**',
  '**/.massu/**',
  '**/.claude/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  // Iter-7 fix: editor temp files inside watched dirs fire spurious chokidar
  // events and inflate the storm-detection counter without representing real
  // stack changes. Cover the most common cases:
  //   *.swp / *.swo / 4913   -> vim atomic-write probe + swap files
  //   .#*                    -> emacs lockfiles
  //   *~                     -> gedit / many editors backup
  //   .DS_Store              -> macOS Finder metadata
  '**/*.swp',
  '**/*.swo',
  '**/4913',
  '**/.#*',
  '**/*~',
  '**/.DS_Store',
];

export interface DerivedWatchGlobs {
  /** Globs/files to watch. */
  watch: string[];
  /** Globs to exclude. */
  ignore: string[];
  /** True when fallback globs were used (because config didn't declare any source paths). */
  usedFallback: boolean;
}

/**
 * Build the watch + ignore glob set for chokidar from a loaded Config.
 * Returns project-relative globs; the daemon resolves them against its root.
 *
 * `watch.scope` (Plan 3a §167 + §251 risk #1):
 *   - `'paths'` (default) — watch only declared `paths.*` + `framework.languages.*.source_dirs`
 *     (or fallback safe-default globs when none declared). Bounded watch surface.
 *   - `'full'` — watch the entire project root (`'**'`) bounded by exclusion globs.
 *     Opt-in for users on small repos who want every file under the toplevel
 *     to count. NOT recommended for huge (>10K-file) repos.
 */
export function deriveWatchGlobs(config: Config): DerivedWatchGlobs {
  const sourceDirs = new Set<string>();
  const scope = config.watch?.scope ?? 'paths';

  if (scope === 'full') {
    // Full-repo opt-in. Just watch '**' and rely on DEFAULT_EXCLUSIONS for
    // node_modules / .git / .massu / .claude / build dirs.
    sourceDirs.add('**');
    return {
      watch: [...ALWAYS_WATCH_FILES, ...sourceDirs],
      ignore: [...DEFAULT_EXCLUSIONS],
      usedFallback: false,
    };
  }

  if (config.paths.source && typeof config.paths.source === 'string') {
    sourceDirs.add(toGlob(config.paths.source));
  }

  const langs = config.framework.languages;
  if (langs && typeof langs === 'object') {
    for (const langEntry of Object.values(langs)) {
      // Defensive: some entries may not include source_dirs. Use property
      // narrowing instead of an `as unknown as Shape` cast.
      if (
        langEntry &&
        typeof langEntry === 'object' &&
        'source_dirs' in langEntry
      ) {
        const dirs = (langEntry as { source_dirs?: unknown }).source_dirs;
        if (Array.isArray(dirs)) {
          for (const d of dirs) {
            if (typeof d === 'string' && d) sourceDirs.add(toGlob(d));
          }
        }
      }
    }
  }

  const usedFallback = sourceDirs.size === 0;
  if (usedFallback) {
    for (const g of FALLBACK_SOURCE_GLOBS) sourceDirs.add(g);
  }

  return {
    watch: [...ALWAYS_WATCH_FILES, ...sourceDirs],
    ignore: [...DEFAULT_EXCLUSIONS],
    usedFallback,
  };
}

function toGlob(dir: string): string {
  if (dir.endsWith('/**') || dir.includes('*')) return dir;
  return dir.replace(/\/+$/, '') + '/**';
}

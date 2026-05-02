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

import fastGlob from 'fast-glob';
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
  // Plan 3a hotfix 2026-05-02: high-churn directories that are never
  // legitimate stack-detection inputs and produced sustained 30-100% CPU
  // when watched on example-project (62K files / 42 GB tree).
  '**/.next/**',
  '**/coverage/**',
  '**/logs/**',
  '**/*.log',
  // Runtime data dirs. Convention across Python/JS/Rust ecosystems is
  // that `data/` holds runtime artifacts (caches, snapshots, model
  // checkpoints, downloaded fixtures) that change frequently but are
  // never stack-detection inputs. example-project had 135K files in
  // apps/ai-service/data alone, dwarfing legitimate source. If a
  // project genuinely uses `data/` for source content, opt into
  // `watch.scope: 'full'` and `watch.paths_full_root_opt_in: true`.
  '**/data/**',
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

/**
 * Plan 3a hotfix 2026-05-02: explicit root-watch sentinels. Any of these
 * appearing in `framework.languages.*.source_dirs` is treated as the user
 * asking to watch the entire repo root, which requires
 * `watch.paths_full_root_opt_in: true` to override the file-count cap.
 *
 * Why these specifically: the toGlob() helper turns `'.'` into `'./**'`
 * and leaves `'**'` / `'./**'` / `'./'` as-is. Each effectively makes
 * chokidar walk the toplevel — silently, without warning — defeating
 * the scope='paths' bound. We treat them as semantically equivalent to
 * `scope: 'full'`.
 */
export const ROOT_WATCH_SENTINELS = ['.', './', '**', './**', '*'] as const;

export function isRootWatchSentinel(dir: string): boolean {
  return (ROOT_WATCH_SENTINELS as readonly string[]).includes(dir);
}

export class WatchSurfaceTooLargeError extends Error {
  constructor(public readonly fileCount: number, public readonly cap: number) {
    super(
      `massu watch refuses to start: would monitor ${fileCount} files ` +
      `(cap is ${cap}). Narrow framework.languages.*.source_dirs in ` +
      `massu.config.yaml, or set watch.paths_full_root_opt_in: true (and ` +
      `watch.max_watched_files: ${fileCount + 1000}) if root-level watching ` +
      `is genuinely required. Note: monitoring more than 10K files routinely ` +
      `produces 30-100% steady CPU under normal repo activity.`
    );
    this.name = 'WatchSurfaceTooLargeError';
  }
}

export interface DerivedWatchGlobs {
  /** Globs/files to watch. */
  watch: string[];
  /** Globs to exclude. */
  ignore: string[];
  /** True when fallback globs were used (because config didn't declare any source paths). */
  usedFallback: boolean;
  /** Effective scope after considering root sentinels in source_dirs. */
  effectiveScope: 'paths' | 'full';
  /** True when a root sentinel ('.', '**', etc.) was detected in source_dirs and promoted to full scope. */
  rootWatchDetected: boolean;
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
  const explicitScope = config.watch?.scope ?? 'paths';
  let rootWatchDetected = false;

  if (explicitScope === 'full') {
    // Full-repo opt-in. Just watch '**' and rely on DEFAULT_EXCLUSIONS for
    // node_modules / .git / .massu / .claude / build dirs.
    sourceDirs.add('**');
    return {
      watch: [...ALWAYS_WATCH_FILES, ...sourceDirs],
      ignore: [...DEFAULT_EXCLUSIONS],
      usedFallback: false,
      effectiveScope: 'full',
      rootWatchDetected: false,
    };
  }

  if (config.paths.source && typeof config.paths.source === 'string') {
    if (isRootWatchSentinel(config.paths.source)) {
      rootWatchDetected = true;
    } else {
      sourceDirs.add(toGlob(config.paths.source));
    }
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
            if (typeof d !== 'string' || !d) continue;
            if (isRootWatchSentinel(d)) {
              rootWatchDetected = true;
            } else {
              sourceDirs.add(toGlob(d));
            }
          }
        }
      }
    }
  }

  const usedFallback = sourceDirs.size === 0 && !rootWatchDetected;
  if (usedFallback) {
    for (const g of FALLBACK_SOURCE_GLOBS) sourceDirs.add(g);
  }

  // Plan 3a hotfix: a root sentinel in source_dirs is semantically the same
  // as scope='full'. Promote it. The daemon enforces the file-count cap on
  // top of this; an unintentional `.` in source_dirs gets caught there.
  let effectiveScope: 'paths' | 'full' = explicitScope;
  if (rootWatchDetected) {
    sourceDirs.add('**');
    effectiveScope = 'full';
  }

  return {
    watch: [...ALWAYS_WATCH_FILES, ...sourceDirs],
    ignore: [...DEFAULT_EXCLUSIONS],
    usedFallback,
    effectiveScope,
    rootWatchDetected,
  };
}

function toGlob(dir: string): string {
  if (dir.endsWith('/**') || dir.includes('*')) return dir;
  return dir.replace(/\/+$/, '') + '/**';
}

/**
 * Plan 3a hotfix 2026-05-02: count files matching the derived watch globs
 * (after exclusions) without walking past the cap. Used as a startup
 * preflight in the daemon — refuses to start if count > cap and the user
 * hasn't set `watch.paths_full_root_opt_in: true`.
 *
 * Why upfront vs after chokidar: chokidar.getWatched() requires waiting
 * for the `ready` event, which on a 62K-file tree takes 30+ seconds AND
 * does the full walk we're trying to avoid. fast-glob with `onlyFiles`
 * + early-exit via the iterator pattern walks once, bails when we've
 * counted enough to know we're over the cap.
 *
 * Returns Infinity if more than `cap + 1` files exist (signals "exceeds")
 * to avoid walking the full tree just to produce an exact count.
 */
export async function countWatchSurface(
  watch: readonly string[],
  ignore: readonly string[],
  cwd: string,
  cap: number
): Promise<number> {
  // fast-glob's stream API yields one path per event, allowing early-exit.
  const stream = fastGlob.stream(watch as string[], {
    cwd,
    ignore: ignore as string[],
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  let count = 0;
  for await (const _ of stream) {
    count += 1;
    if (count > cap) {
      // We've proven the surface exceeds the cap. Cancel the iterator and
      // return a sentinel value. The caller only needs the exceeds-or-not
      // signal (plus the cap) to produce a useful error.
      // @ts-expect-error fast-glob stream is a NodeJS.ReadableStream
      stream.destroy?.();
      return Infinity;
    }
  }
  return count;
}

/**
 * Plan 3a hotfix 2026-05-02: enforce the watch.max_watched_files cap.
 * Throws WatchSurfaceTooLargeError if the count exceeds the cap and the
 * user has not opted in via `watch.paths_full_root_opt_in: true`.
 *
 * Returns the actual count (or Infinity if early-exit tripped) so the
 * daemon can log the surface size at startup for observability.
 */
export async function enforceWatchSurfaceCap(
  globs: DerivedWatchGlobs,
  cwd: string,
  cap: number,
  optedIn: boolean
): Promise<number> {
  const count = await countWatchSurface(globs.watch, globs.ignore, cwd, cap);
  if (count > cap && !optedIn) {
    throw new WatchSurfaceTooLargeError(count, cap);
  }
  return count;
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Domain Inferrer (P1-006)
 * ========================
 *
 * Suggests `DomainConfig[]` entries based on monorepo + source-dir discovery.
 * Each workspace package (apps/*, packages/*, services/*, libs/*, modules/*)
 * becomes one suggested domain. In single-package repos, top-level
 * `src/<subdir>/` candidates are suggested as domains.
 *
 * Output matches the existing `DomainConfig` type from `config.ts` so init
 * and refresh can write it directly into `massu.config.yaml`. Suggested
 * `allowedImportsFrom` is always empty — the user fills relationships.
 *
 * Deterministic ordering: alphabetical by domain name.
 *
 * Usage:
 * ```ts
 * import { inferDomains } from './detect/domain-inferrer.ts';
 * const domains = inferDomains('/repo', monorepo, sourceDirs);
 * ```
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { DomainConfig } from '../config.ts';
import type { MonorepoInfo, WorkspacePackage } from './monorepo-detector.ts';
import type { SourceDirMap } from './source-dir-detector.ts';

const IGNORED_SUBDIRS = new Set([
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  '.build',
  'target',
  '.next',
  '.git',
  '.massu',
  'coverage',
  'tests',
  'test',
  '__tests__',
]);

function titleCase(s: string): string {
  if (!s) return s;
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function domainFromWorkspace(pkg: WorkspacePackage): DomainConfig {
  // Prefer the explicit package name; fall back to the final path segment.
  const pathTail = pkg.path.split('/').pop() ?? pkg.path;
  const name = pkg.name ?? titleCase(pathTail);
  return {
    name,
    routers: [],
    pages: [],
    tables: [],
    allowedImportsFrom: [],
  };
}

/**
 * Enumerate domain candidates under each detected source directory.
 *
 * The `sourceDirs` argument is the flattened, unique list of relative
 * source paths produced upstream by the source-dir detector
 * (`detectSourceDirs` in `source-dir-detector.ts`). For each path that
 * exists under `root`, this function lists immediate subdirectories as
 * candidate domain names. Hardcoded `src/` lookup was removed (plan
 * `plan-1.7.0-cohesive-cleanup` P-B-002) — the function now consumes
 * the detection pipeline's output verbatim, so projects whose source
 * lives at non-`src/` paths (e.g. `lib/`, `apps/<x>/src/`) are no
 * longer silently dropped.
 *
 * Empty `sourceDirs` is treated as a legacy single-repo `src/` lookup
 * to preserve behavior for callers that pre-date the source-dir
 * pipeline (CLI / test harnesses that hand-wire `inferDomains`).
 *
 * Returns deduplicated subdir names sorted alphabetically.
 */
function topLevelSrcSubdirs(root: string, sourceDirs: readonly string[]): string[] {
  const effective = sourceDirs.length > 0 ? sourceDirs : ['src'];
  const seen = new Set<string>();
  for (const rel of effective) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (IGNORED_SUBDIRS.has(e.name)) continue;
        seen.add(e.name);
      }
    } catch {
      // skip directories that cannot be read; do not throw.
    }
  }
  return Array.from(seen).sort();
}

/**
 * Flatten a `SourceDirMap` into a unique, deduplicated list of relative
 * source paths across all detected languages.
 *
 * Drops the root sentinels `.` and `''` — those are emitted by the
 * source-dir-detector when source files live directly at the project
 * root (e.g. Django's `manage.py` or Swift's `Package.swift`). Treating
 * them as enumerable source dirs causes spurious top-level directory
 * inclusion (Tests/, Sources/, etc.), which collides with the
 * language-fallback path in `inferDomains`. Root-source repos rely on
 * the language-fallback path to emit `{Python}` / `{Swift}` domains,
 * NOT a fan-out of every root subdirectory.
 *
 * Order is not guaranteed — callers that need determinism must sort.
 */
function flattenSourceDirs(sourceDirs: SourceDirMap): string[] {
  const flat = new Set<string>();
  for (const entry of Object.values(sourceDirs)) {
    if (!entry) continue;
    for (const dir of entry.source_dirs) {
      if (dir === '.' || dir === '') continue;
      flat.add(dir);
    }
  }
  return Array.from(flat);
}

/**
 * Produce a suggested `DomainConfig[]`.
 *
 * @param projectRoot absolute path
 * @param monorepo    output of P1-004 detectMonorepo
 * @param sourceDirs  output of P1-003 detectSourceDirs
 */
export function inferDomains(
  projectRoot: string,
  monorepo: MonorepoInfo,
  sourceDirs: SourceDirMap
): DomainConfig[] {
  const domains: DomainConfig[] = [];

  if (monorepo.type !== 'single' && monorepo.packages.length > 0) {
    // Monorepo: one domain per workspace package.
    for (const pkg of monorepo.packages) {
      domains.push(domainFromWorkspace(pkg));
    }
  } else {
    // Single repo: suggest one domain per top-level <sourceDir>/<subdir>/ for
    // every detected source dir (formerly hardcoded to `src/` only — see
    // P-B-002 in plan-1.7.0-cohesive-cleanup).
    const flat = flattenSourceDirs(sourceDirs);
    const subdirs = topLevelSrcSubdirs(projectRoot, flat);
    for (const s of subdirs) {
      domains.push({
        name: titleCase(s),
        routers: [],
        pages: [],
        tables: [],
        allowedImportsFrom: [],
      });
    }
    // If no src/ subdirs, emit a single-language-based domain when sourceDirs has entries.
    if (domains.length === 0) {
      const langs = Object.keys(sourceDirs);
      for (const lang of langs.sort()) {
        domains.push({
          name: titleCase(lang),
          routers: [],
          pages: [],
          tables: [],
          allowedImportsFrom: [],
        });
      }
    }
  }

  // Deterministic alphabetical order by name.
  domains.sort((a, b) => a.name.localeCompare(b.name));

  // Dedup by name (monorepo workspaces may coincidentally share a name).
  const seen = new Set<string>();
  const dedup: DomainConfig[] = [];
  for (const d of domains) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    dedup.push(d);
  }

  return dedup;
}

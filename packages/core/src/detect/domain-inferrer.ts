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

function topLevelSrcSubdirs(root: string): string[] {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) return [];
  try {
    return readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_SUBDIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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
    // Single repo: suggest one domain per top-level src/<subdir>/ if src/ exists.
    const subdirs = topLevelSrcSubdirs(projectRoot);
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

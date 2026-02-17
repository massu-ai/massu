// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { globMatch } from './rules.ts';
import { getConfig, getResolvedPaths } from './config.ts';
import type { DomainConfig } from './config.ts';

// Re-export for backward compatibility
export type { DomainConfig };

/**
 * Get domain configurations from the config file.
 * Returns an empty array if no domains are configured.
 */
function getDomains(): DomainConfig[] {
  return getConfig().domains;
}

/**
 * Classify a router name into its domain.
 * Returns the domain name or 'Unknown' if no match.
 */
export function classifyRouter(routerName: string): string {
  const domains = getDomains();
  for (const domain of domains) {
    for (const pattern of domain.routers) {
      if (globMatchSimple(routerName, pattern)) {
        return domain.name;
      }
    }
  }
  return 'Unknown';
}

/**
 * Classify a file path into its domain.
 */
export function classifyFile(filePath: string): string {
  const domains = getDomains();
  const config = getConfig();
  const normalized = filePath.replace(/\\/g, '/');

  // Check page patterns
  for (const domain of domains) {
    for (const pattern of domain.pages) {
      if (globMatch(normalized, pattern)) {
        return domain.name;
      }
    }
  }

  // Check if it's a router file - derive router dir from config
  const routersPath = config.paths.routers ?? 'src/server/api/routers';
  const routerPrefix = routersPath.replace(/\\/g, '/');
  if (normalized.includes(routerPrefix + '/')) {
    const routerName = normalized
      .replace(routerPrefix + '/', '')
      .replace(/\.ts$/, '')
      .replace(/\/index$/, '');
    return classifyRouter(routerName);
  }

  // Check component paths
  if (normalized.includes('/components/')) {
    const parts = normalized.split('/');
    const compIdx = parts.indexOf('components');
    if (compIdx >= 0 && compIdx + 1 < parts.length) {
      const compGroup = parts[compIdx + 1];
      for (const domain of domains) {
        for (const pattern of domain.routers) {
          if (globMatchSimple(compGroup, pattern)) {
            return domain.name;
          }
        }
      }
    }
  }

  return 'Unknown';
}

/**
 * Simple glob matching for router/table names (single-level, no path separators).
 */
function globMatchSimple(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

/**
 * Find all cross-domain imports using the imports table.
 */
export function findCrossDomainImports(dataDb: Database.Database): {
  source: string;
  target: string;
  sourceDomain: string;
  targetDomain: string;
  allowed: boolean;
}[] {
  const domains = getDomains();
  const config = getConfig();
  const srcPrefix = config.paths.source;

  const srcPattern = srcPrefix + '/%';
  const imports = dataDb.prepare(
    'SELECT source_file, target_file FROM massu_imports WHERE source_file LIKE ? AND target_file LIKE ?'
  ).all(srcPattern, srcPattern) as { source_file: string; target_file: string }[];

  const crossings: {
    source: string; target: string;
    sourceDomain: string; targetDomain: string;
    allowed: boolean;
  }[] = [];

  for (const imp of imports) {
    const sourceDomain = classifyFile(imp.source_file);
    const targetDomain = classifyFile(imp.target_file);

    if (sourceDomain === 'Unknown' || targetDomain === 'Unknown') continue;
    if (sourceDomain === targetDomain) continue;

    // Check if source domain allows wildcard imports
    const sourceConfig = domains.find(d => d.name === sourceDomain);
    if (sourceConfig?.allowedImportsFrom.length === 0) continue; // System domain
    const allowed = sourceConfig?.allowedImportsFrom.includes('*') ||
      sourceConfig?.allowedImportsFrom.includes(targetDomain) || false;

    crossings.push({
      source: imp.source_file,
      target: imp.target_file,
      sourceDomain,
      targetDomain,
      allowed,
    });
  }

  return crossings;
}

/**
 * Get all files in a specific domain.
 */
export function getFilesInDomain(dataDb: Database.Database, codegraphDb: Database.Database, domainName: string): {
  routers: string[];
  pages: string[];
  components: string[];
} {
  const domains = getDomains();
  const config = getConfig();
  const domain = domains.find(d => d.name === domainName);
  if (!domain) return { routers: [], pages: [], components: [] };

  const srcPrefix = config.paths.source;
  const routersPath = config.paths.routers ?? 'src/server/api/routers';

  const srcPattern = srcPrefix + '/%';
  const allFiles = codegraphDb.prepare('SELECT path FROM files WHERE path LIKE ?').all(srcPattern) as { path: string }[];

  const routers: string[] = [];
  const pages: string[] = [];
  const components: string[] = [];

  for (const file of allFiles) {
    const fileDomain = classifyFile(file.path);
    if (fileDomain !== domainName) continue;

    if (file.path.includes(routersPath + '/')) {
      routers.push(file.path);
    } else if (file.path.match(/page\.tsx?$/)) {
      pages.push(file.path);
    } else if (file.path.includes('/components/')) {
      components.push(file.path);
    }
  }

  return { routers, pages, components };
}

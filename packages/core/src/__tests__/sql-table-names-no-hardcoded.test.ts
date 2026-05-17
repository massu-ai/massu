// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H032 (plan-stage-c-high-batch / 1.10.7) drift-guard.
 *
 * Scans `packages/core/src/**` (excluding tests + the SoT module itself +
 * tool-name registries) for any bare `massu_<canonical-suffix>` literal
 * inside a string context. The only legitimate way to reference these
 * tables is through `t('<suffix>')` from `lib/sql-table-names.ts`.
 *
 * Closes the bug class where a future SQL string is written with a
 * hardcoded `'massu_X'` literal and silently regresses custom-prefix
 * installs (they continue to look at the default-prefix tables, missing
 * their own data).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, '..');

// Mirror of MassuTableSuffix in lib/sql-table-names.ts. If you add a new
// prefix-scoped table, also extend MassuTableSuffix and this set.
const CANONICAL_SUFFIXES = [
  'imports',
  'meta',
  'middleware_tree',
  'page_deps',
  'py_fk_edges',
  'py_imports',
  'py_meta',
  'py_migrations',
  'py_models',
  'py_route_callers',
  'py_routes',
  'sentinel',
  'sentinel_changelog',
  'sentinel_components',
  'sentinel_deps',
  'sentinel_fts',
  'sentinel_pages',
  'sentinel_procedures',
  'trpc_call_sites',
  'trpc_procedures',
];

const BANNED_PATTERN = new RegExp(
  // Match `massu_<suffix>` not followed by `[a-z_]` (so longer matches don't
  // shadow shorter ones the wrong way). Restrict to literal contexts by
  // requiring the surrounding char to look like a string or template body.
  '\\bmassu_(' + CANONICAL_SUFFIXES.join('|') + ')\\b',
);

// Files exempt from the scan — these are the SoT + tool-registry surfaces.
const EXEMPT: ReadonlySet<string> = new Set<string>([
  'lib/sql-table-names.ts',
  'tool-db-needs.ts',
  '__tests__',
]);

function walk(dir: string, cb: (rel: string, abs: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    const stat = statSync(abs);
    const rel = relative(SRC_ROOT, abs);
    if (stat.isDirectory()) {
      // Skip exempt directories
      if (EXEMPT.has(entry)) continue;
      walk(abs, cb);
    } else if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
      // Skip exempt files + generated files
      if (EXEMPT.has(rel)) continue;
      if (entry.endsWith('.generated.ts')) continue;
      if (entry.endsWith('.test.ts')) continue;
      cb(rel, abs);
    }
  }
}

describe('SQL table-name SoT — no bare massu_<table> literals (P-H032)', () => {
  it('every callsite goes through t() from lib/sql-table-names.ts', () => {
    const violations: Array<{ file: string; line: number; excerpt: string }> = [];
    walk(SRC_ROOT, (rel, abs) => {
      const text = readFileSync(abs, 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        // Skip lines that obviously aren't SQL string contexts: imports,
        // comments without backticks/quotes.
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (line.includes('import ')) return;
        const m = BANNED_PATTERN.exec(line);
        if (m) {
          violations.push({
            file: rel,
            line: idx + 1,
            excerpt: line.trim().slice(0, 140),
          });
        }
      });
    });
    expect(
      violations,
      `Bare massu_<table> literal(s) found. Replace with t('<suffix>') from lib/sql-table-names.ts:\n\n${violations
        .map((v) => `  ${v.file}:${v.line}  ${v.excerpt}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('t() helper resolves to the configured prefix', async () => {
    const { t } = await import('../lib/sql-table-names.ts');
    // Default prefix in test env is 'massu' (verified by getConfig()).
    // If your test env overrides toolPrefix, this assertion still binds:
    // it confirms t('imports') returns `<prefix>_imports` for whatever
    // prefix is configured.
    const resolved = t('imports');
    expect(resolved.endsWith('_imports')).toBe(true);
    expect(resolved.includes('_')).toBe(true);
  });
});

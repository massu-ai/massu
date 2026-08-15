// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `lib/source-layout.ts` — the SoT for where a project's source lives, and the
 * candidate-set contract every index builder holds over it.
 *
 * Plan: `plan-2026-08-13-index-builder-input-contracts`, Q3 + Q4.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, realpathSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { resetConfig } from '../config.ts';
import {
  CandidateSetContractError,
  assertSourceCandidateSet,
  componentsPredicate,
  getSourceLayout,
  isUnderSourceDir,
  pagesPredicate,
  sourceDirPredicate,
  sourceFilePredicate,
} from '../lib/source-layout.ts';

// Scratch trees live in the OS temp dir, never under packages/core/src — the
// repo's source-scanning drift-guards walk src/, and a tree created and torn
// down repeatedly races them (see page-deps-coverage.test.ts).
const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'massu-source-layout-')));
const originalCwd = process.cwd();

/** Write a massu.config.yaml into the scratch project and load it. */
function useConfig(yaml: string): void {
  writeFileSync(resolve(TEST_DIR, 'massu.config.yaml'), yaml, 'utf-8');
  resetConfig();
  process.chdir(TEST_DIR);
  // Touch the layout so a malformed config fails here rather than mid-assertion.
  getSourceLayout();
}

/** A codegraph-shaped DB holding exactly `paths`. */
function makeCodegraph(paths: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files (path TEXT, indexed_at INTEGER)');
  const ins = db.prepare('INSERT INTO files (path, indexed_at) VALUES (?, 0)');
  for (const p of paths) ins.run(p);
  return db;
}

/** Rows of `files` selected by a predicate — the shape every builder uses. */
function selectPaths(db: Database.Database, pred: { sql: string; params: readonly string[] }): string[] {
  return (db.prepare(`SELECT path FROM files WHERE ${pred.sql}`).all(...pred.params) as { path: string }[])
    .map(r => r.path)
    .sort();
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  resetConfig();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetConfig();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('getSourceLayout — derivation from declarations that already exist', () => {
  it('unions paths.source, paths.monorepo_roots and every language source_dirs', () => {
    useConfig(
      'project:\n  name: app\n' +
      'paths:\n  source: website\n  monorepo_roots:\n    - packages\n' +
      'framework:\n  type: multi\n  languages:\n' +
      '    typescript:\n      source_dirs:\n        - website\n        - scripts\n' +
      '    python:\n      source_dirs:\n        - services\n',
    );

    const layout = getSourceLayout();
    expect(layout.includesRoot).toBe(false);
    // Deduped (website is declared twice) and sorted.
    expect(layout.sourceDirs).toEqual(['packages', 'scripts', 'services', 'website']);
  });

  it('reports a declared root as includesRoot rather than hiding it in a vacuous LIKE', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: website\n' +
      'framework:\n  type: multi\n  languages:\n    typescript:\n      source_dirs:\n        - "."\n',
    );

    const layout = getSourceLayout();
    expect(layout.includesRoot).toBe(true);
    // The dir list is emptied deliberately: the root subsumes every entry, and a
    // list that still named them would suggest a narrowing that does not exist.
    expect(layout.sourceDirs).toEqual([]);
  });

  it('drops declarations that cannot describe a repo-relative indexed path', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: src\n' +
      'framework:\n  type: multi\n  languages:\n    typescript:\n      source_dirs:\n' +
      '        - /etc\n        - ../sibling\n        - "lib/"\n        - "./app"\n',
    );

    const layout = getSourceLayout();
    expect(layout.sourceDirs).toEqual(['app', 'lib', 'src']);
  });

  it('derives pagesDir and componentsDir from paths.source when neither is declared', () => {
    useConfig('project:\n  name: app\npaths:\n  source: website\n');
    const layout = getSourceLayout();
    expect(layout.pagesDir).toBe('website/app');
    expect(layout.componentsDir).toBe('website/components');
  });

  it('prefers the explicit paths.pages / paths.components declarations', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: website\n' +
      '  pages: website/src/app\n  components: website/src/components\n',
    );
    const layout = getSourceLayout();
    expect(layout.pagesDir).toBe('website/src/app');
    expect(layout.componentsDir).toBe('website/src/components');
  });
});

describe('SQL predicates', () => {
  it('sourceDirPredicate selects declared dirs and excludes an undeclared one', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: website\n  monorepo_roots:\n    - packages\n',
    );
    const db = makeCodegraph([
      'website/src/a.ts',
      'packages/core/src/b.ts',
      'vendor/c.ts',        // undeclared — must be excluded
      'websiteX/d.ts',      // prefix-adjacent — must NOT match `website`
    ]);

    expect(selectPaths(db, sourceDirPredicate())).toEqual([
      'packages/core/src/b.ts',
      'website/src/a.ts',
    ]);
    db.close();
  });

  it('sourceFilePredicate additionally requires a parseable extension', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const db = makeCodegraph([
      'src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx',
      'src/e.md', 'src/f.json', 'src/g.py',
    ]);

    expect(selectPaths(db, sourceFilePredicate())).toEqual([
      'src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx',
    ]);
    db.close();
  });

  it('treats LIKE metacharacters in a declared dir as literals', () => {
    // `_` is LIKE's single-character wildcard. Unescaped, `a_b` would also
    // match `axb` — a declared dir silently widening the candidate set.
    useConfig('project:\n  name: app\npaths:\n  source: a_b\n');
    const db = makeCodegraph(['a_b/real.ts', 'axb/impostor.ts']);
    expect(selectPaths(db, sourceDirPredicate())).toEqual(['a_b/real.ts']);
    db.close();
  });

  it('a declared root yields a predicate that matches every row', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: src\n' +
      'framework:\n  type: multi\n  languages:\n    typescript:\n      source_dirs:\n        - "."\n',
    );
    const db = makeCodegraph(['src/a.ts', 'anywhere/b.ts', 'c.ts']);
    expect(selectPaths(db, sourceDirPredicate())).toEqual(['anywhere/b.ts', 'c.ts', 'src/a.ts']);
    db.close();
  });

  it('pagesPredicate and componentsPredicate follow the declared dirs', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: website\n' +
      '  pages: website/src/app\n  components: website/src/components\n',
    );
    const db = makeCodegraph([
      'website/src/app/page.tsx',
      'website/src/app/orders/page.tsx',
      'website/src/app/orders/not-a-page.tsx',
      'src/app/page.tsx',                       // the PRE-FIX literal — must not match
      'website/src/components/Button.tsx',
      'src/components/Old.tsx',                 // the PRE-FIX literal — must not match
    ]);

    expect(selectPaths(db, pagesPredicate())).toEqual([
      'website/src/app/orders/page.tsx',
      'website/src/app/page.tsx',
    ]);
    expect(selectPaths(db, componentsPredicate())).toEqual(['website/src/components/Button.tsx']);
    db.close();
  });

  it('refuses to interpolate a column name that is not an identifier', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    expect(() => sourceDirPredicate("path FROM files; DROP TABLE files; --"))
      .toThrow(/refusing to interpolate/);
  });
});

describe('isUnderSourceDir — the in-JS twin of the SQL predicate', () => {
  it('agrees with sourceDirPredicate on the same corpus', () => {
    useConfig('project:\n  name: app\npaths:\n  source: website\n  monorepo_roots:\n    - packages\n');
    const corpus = ['website/a.ts', 'packages/b.ts', 'vendor/c.ts', 'websiteX/d.ts'];
    const db = makeCodegraph(corpus);

    const viaSql = selectPaths(db, sourceDirPredicate());
    const viaJs = corpus.filter(p => isUnderSourceDir(p)).sort();
    expect(viaJs).toEqual(viaSql);
    db.close();
  });

  it('refuses absolute paths and traversal even when the root is a declared source dir', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: src\n' +
      'framework:\n  type: multi\n  languages:\n    typescript:\n      source_dirs:\n        - "."\n',
    );
    expect(isUnderSourceDir('anything/at/all.ts')).toBe(true);
    // resolveImportPath returns an absolute path for a target outside the project;
    // following one would walk the import graph out of the repo.
    expect(isUnderSourceDir('/etc/passwd')).toBe(false);
    expect(isUnderSourceDir('../sibling/x.ts')).toBe(false);
  });
});

describe('assertSourceCandidateSet — the Q3 contract', () => {
  it('THROWS when declared source dirs match 0 rows of a populated files table', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const db = makeCodegraph(['packages/a.ts', 'website/b.ts', 'scripts/c.ts']);

    expect(() => assertSourceCandidateSet(db, 'buildImportIndex'))
      .toThrow(CandidateSetContractError);
    db.close();
  });

  it('POSITIVE CONTROL: the same call returns quietly when the paths DO match', () => {
    // Without this, "it refused" and "it never ran" are the same observation.
    useConfig('project:\n  name: app\npaths:\n  source: packages\n');
    const db = makeCodegraph(['packages/a.ts', 'website/b.ts', 'scripts/c.ts']);

    expect(() => assertSourceCandidateSet(db, 'buildImportIndex')).not.toThrow();
    db.close();
  });

  it('does NOT fire on a legitimately empty codegraph — the contract is 0-of-N, not 0', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const db = makeCodegraph([]);
    expect(() => assertSourceCandidateSet(db, 'buildImportIndex')).not.toThrow();
    db.close();
  });

  it('reports the denominator, the declaration and the prefixes actually present', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const db = makeCodegraph(['packages/a.ts', 'packages/b.ts', 'website/c.ts']);

    let message = '';
    try {
      assertSourceCandidateSet(db, 'buildImportIndex');
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain('0 of 3 indexed files');   // M1 — it proves it looked
    expect(message).toContain('Declared: src');           // what was asked for
    expect(message).toContain('packages (2)');            // what is actually there
    expect(message).toContain('website (1)');
    expect(message).toContain('massu.config.yaml');       // and how to fix it
    db.close();
  });

  it('names the builder that failed, so the error is attributable', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const db = makeCodegraph(['packages/a.ts']);
    expect(() => assertSourceCandidateSet(db, 'buildPageDeps')).toThrow(/^buildPageDeps:/);
    db.close();
  });
});

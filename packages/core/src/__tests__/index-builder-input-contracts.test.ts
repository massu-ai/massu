// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The index builders' INPUT CONTRACT, exercised through the real builders.
 *
 * Plan: `plan-2026-08-13-index-builder-input-contracts`, Q3 + Q4.
 *
 * Before this, `buildImportIndex` selected `FROM files WHERE path LIKE 'src/%'`
 * and returned `0` in any layout that is not single-package — measured at
 * **0 of 1266** files in this monorepo. Nine read sites answered from the empty
 * table it produced, and nothing reported the emptiness, because an empty index
 * and a correctly-empty index are the same output.
 *
 * Every failure assertion here is paired with a POSITIVE CONTROL running the
 * SAME builder over paths that DO match. Without it, "the builder refused" and
 * "the builder never ran" are indistinguishable results.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, realpathSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { resetConfig } from '../config.ts';
import { buildImportIndex } from '../import-resolver.ts';
import { buildPageDeps } from '../page-deps.ts';
import { CandidateSetContractError } from '../lib/source-layout.ts';
import { t } from '../lib/sql-table-names.ts';

const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'massu-input-contract-')));
const originalCwd = process.cwd();

function write(relPath: string, content: string): void {
  const abs = resolve(TEST_DIR, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function useConfig(yaml: string): void {
  write('massu.config.yaml', yaml);
  resetConfig();
  process.chdir(TEST_DIR);
}

function makeCodegraph(paths: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE files (path TEXT, indexed_at INTEGER)');
  const ins = db.prepare('INSERT INTO files (path, indexed_at) VALUES (?, 0)');
  for (const p of paths) ins.run(p);
  return db;
}

function makeDataDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ${t('imports')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL, target_file TEXT NOT NULL,
      import_type TEXT NOT NULL, imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ${t('page_deps')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_file TEXT NOT NULL, route TEXT NOT NULL, portal TEXT NOT NULL,
      components TEXT NOT NULL, hooks TEXT NOT NULL, routers TEXT NOT NULL,
      tables_touched TEXT NOT NULL);
    CREATE TABLE ${t('trpc_procedures')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_file TEXT NOT NULL, router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL, procedure_type TEXT NOT NULL,
      has_ui_caller INTEGER NOT NULL DEFAULT 0);
  `);
  return db;
}

const importRows = (db: Database.Database) =>
  (db.prepare(`SELECT source_file, target_file FROM ${t('imports')}`).all() as
    { source_file: string; target_file: string }[]);

/** A two-file module under `dir` where the first imports the second. */
function writeImportPair(dir: string): void {
  write(`${dir}/a.ts`, "import { b } from './b.ts';\nexport const a = b;\n");
  write(`${dir}/b.ts`, 'export const b = 1;\n');
}

let dataDb: Database.Database;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  resetConfig();
  dataDb = makeDataDb();
});

afterEach(() => {
  try { dataDb.close(); } catch { /* already closed */ }
  process.chdir(originalCwd);
  resetConfig();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('buildImportIndex — a violated input contract is LOUD', () => {
  it('throws when the declared source dirs match none of a populated files table', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    writeImportPair('packages/core/src');
    const cg = makeCodegraph(['packages/core/src/a.ts', 'packages/core/src/b.ts']);

    expect(() => buildImportIndex(dataDb, cg)).toThrow(CandidateSetContractError);
    cg.close();
  });

  it('POSITIVE CONTROL: the same builder indexes edges when the paths DO match', () => {
    useConfig('project:\n  name: app\npaths:\n  source: packages\n');
    writeImportPair('packages/core/src');
    const cg = makeCodegraph(['packages/core/src/a.ts', 'packages/core/src/b.ts']);

    const edges = buildImportIndex(dataDb, cg);

    expect(edges).toBeGreaterThan(0);
    expect(importRows(dataDb)).toEqual([
      { source_file: 'packages/core/src/a.ts', target_file: 'packages/core/src/b.ts' },
    ]);
    cg.close();
  });

  it('leaves the previous index intact when it refuses', () => {
    // The assertion runs BEFORE the DELETE. A builder that cleared the table and
    // then threw would replace a good index with an empty one on every dispatch —
    // the failure mode is the same emptiness this whole plan exists to remove.
    useConfig('project:\n  name: app\npaths:\n  source: packages\n');
    writeImportPair('packages/core/src');
    const good = makeCodegraph(['packages/core/src/a.ts', 'packages/core/src/b.ts']);
    buildImportIndex(dataDb, good);
    good.close();
    const before = importRows(dataDb);
    expect(before.length).toBeGreaterThan(0);

    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const bad = makeCodegraph(['packages/core/src/a.ts']);
    expect(() => buildImportIndex(dataDb, bad)).toThrow(CandidateSetContractError);
    bad.close();

    expect(importRows(dataDb)).toEqual(before);
  });

  it('does not fire on an empty codegraph — the contract is 0-of-N, not 0', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const cg = makeCodegraph([]);
    expect(buildImportIndex(dataDb, cg)).toBe(0);
    cg.close();
  });
});

describe('buildImportIndex — the candidate set follows the DECLARED layout', () => {
  it('indexes every declared source dir, not just paths.source', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: website\n  monorepo_roots:\n    - packages\n',
    );
    writeImportPair('website/src');
    writeImportPair('packages/core/src');
    const cg = makeCodegraph([
      'website/src/a.ts', 'website/src/b.ts',
      'packages/core/src/a.ts', 'packages/core/src/b.ts',
    ]);

    buildImportIndex(dataDb, cg);

    expect(importRows(dataDb).map(r => r.source_file).sort())
      .toEqual(['packages/core/src/a.ts', 'website/src/a.ts']);
    cg.close();
  });

  it('EXCLUDES a source dir the config does not declare', () => {
    // Q4's acceptance: plant a dir the config never declared and demand it be
    // excluded. `vendor/` is on disk, in CodeGraph, and importable — the only
    // reason it is absent from the index is that nothing declared it.
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    writeImportPair('src');
    writeImportPair('vendor');
    const cg = makeCodegraph(['src/a.ts', 'src/b.ts', 'vendor/a.ts', 'vendor/b.ts']);

    buildImportIndex(dataDb, cg);

    const sources = importRows(dataDb).map(r => r.source_file);
    expect(sources).toEqual(['src/a.ts']);
    expect(sources.some(s => s.startsWith('vendor/'))).toBe(false);
    cg.close();
  });

  it('skips files whose extension no import parser can read', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    writeImportPair('src');
    write('src/notes.md', "import { b } from './b.ts';\n");
    const cg = makeCodegraph(['src/a.ts', 'src/b.ts', 'src/notes.md']);

    buildImportIndex(dataDb, cg);

    expect(importRows(dataDb).map(r => r.source_file)).toEqual(['src/a.ts']);
    cg.close();
  });
});

describe('buildPageDeps — same contract LEVEL, different narrowing', () => {
  it('holds the shared source-dir contract', () => {
    useConfig('project:\n  name: app\npaths:\n  source: src\n');
    const cg = makeCodegraph(['packages/core/src/a.ts']);
    expect(() => buildPageDeps(dataDb, cg)).toThrow(/^buildPageDeps:/);
    cg.close();
  });

  it('indexes 0 pages WITHOUT throwing when the repo simply has none', () => {
    // The distinction the level buys: a library-only repo legitimately has 1266
    // files and no pages. Asserting "pages > 0" here would be red by design in
    // exactly the state it is supposed to tolerate.
    useConfig('project:\n  name: app\npaths:\n  source: packages\n');
    writeImportPair('packages/core/src');
    const cg = makeCodegraph(['packages/core/src/a.ts', 'packages/core/src/b.ts']);

    expect(buildPageDeps(dataDb, cg)).toBe(0);
    cg.close();
  });

  it('POSITIVE CONTROL: finds pages under the declared pages dir, and derives their routes', () => {
    useConfig(
      'project:\n  name: app\npaths:\n  source: website\n  pages: website/src/app\n',
    );
    write('website/src/app/page.tsx', 'export default function Root() { return null; }\n');
    write('website/src/app/orders/page.tsx', 'export default function Orders() { return null; }\n');
    const cg = makeCodegraph([
      'website/src/app/page.tsx',
      'website/src/app/orders/page.tsx',
      'src/app/legacy/page.tsx',   // the PRE-FIX literal — must NOT be picked up
    ]);

    expect(buildPageDeps(dataDb, cg)).toBe(2);

    const routes = (dataDb.prepare(`SELECT page_file, route FROM ${t('page_deps')} ORDER BY page_file`).all() as
      { page_file: string; route: string }[]);
    expect(routes).toEqual([
      { page_file: 'website/src/app/orders/page.tsx', route: '/orders' },
      { page_file: 'website/src/app/page.tsx', route: '/' },
    ]);
    cg.close();
  });
});

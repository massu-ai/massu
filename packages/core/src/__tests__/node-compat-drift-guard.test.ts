import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { DEFAULT_DB_ENGINE } from '../db-driver.ts';

/* ------------------------------------------------------------------ */
/*  DB-engine compatibility drift-guard (Layer 2, CR-69).             */
/*                                                                    */
/*  Origin — incident 2026-07-05 (Node 26 native-module ABI mismatch):*/
/*  @massu/core shipped a prebuilt better-sqlite3 compiled for an      */
/*  older ABI and capped `engines.node` at `<26.0.0`; when Node 26     */
/*  (ABI 147) became the default the native module failed to load.     */
/*                                                                    */
/*  Layer 2 removes the ROOT CAUSE: the DEFAULT engine is Node's       */
/*  built-in `node:sqlite` (native-free, no ABI). better-sqlite3 is    */
/*  retained ONLY as an opt-in fallback. This guard locks:            */
/*    (a) node:sqlite (the default engine) loads + round-trips + FTS5  */
/*        under whatever Node runs the suite;                          */
/*    (a2) better-sqlite3 (the fallback) still loads + round-trips;    */
/*    (b) `engines.node` == `>=22.16.0` EXACTLY (the node:sqlite FTS5/  */
/*        isTransaction floor),                                        */
/*        with NO `<` upper bound, and DEFAULT_DB_ENGINE == node-sqlite;*/
/*    (c) the CI Node-major matrix drops Node < 22, keeps an           */
/*        auto-tracking `latest` leg, and the required Gate stays wired.*/
/* ------------------------------------------------------------------ */

const CORE_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(CORE_ROOT, '..', '..');
const IS_INTERNAL_REPO = existsSync(resolve(REPO_ROOT, 'website', 'vitest.config.ts'));

describe('DB-engine compatibility (Layer 2 — node:sqlite default, incident 2026-07-05)', () => {
  it('(a) node:sqlite (default engine) loads, round-trips + FTS5 MATCH under the current Node', () => {
    // The default engine is native-free; this confirms the running Node ships SQLite
    // with FTS5 and that a MATCH round-trips — the exact capability the migration needs.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec(s: string): void;
        prepare(s: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
      expect((db.prepare('SELECT x FROM t').get() as { x: number }).x).toBe(42);
      db.exec("CREATE VIRTUAL TABLE f USING fts5(body)");
      db.exec("INSERT INTO f (body) VALUES ('hello world')");
      expect(db.prepare('SELECT body FROM f WHERE f MATCH ?').all('hello').length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('(a2) better-sqlite3 (opt-in fallback) still loads + round-trips under the current Node', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
      expect((db.prepare('SELECT x FROM t').get() as { x: number }).x).toBe(42);
    } finally {
      db.close();
    }
  });

  it('(b) engines.node is locked to the node:sqlite floor (>=22.16.0), no ceiling; default engine is node:sqlite', () => {
    const pkg = JSON.parse(readFileSync(resolve(CORE_ROOT, 'package.json'), 'utf-8')) as {
      engines?: { node?: string };
    };
    const range = pkg.engines?.node ?? '';
    // EXACT floor — node:sqlite is FTS5-capable + isTransaction-capable only from v22.16.0
    // (flag-free from 22.13, but FTS5/isTransaction land in 22.16 — see lib/node-floor.ts). A
    // mutation that lowers this (re-admitting 22.13–22.15, where the default engine is
    // non-functional, or Node 20/21 where node:sqlite is absent/flagged) fails here.
    expect(range).toBe('>=22.16.0');
    // A `<` upper bound is what locked Node 26 out in 2026-07-05 — never reintroduce one.
    expect(
      range.includes('<'),
      `engines.node = "${range}" must not impose a "<" upper bound (the 2026-07-05 bug class).`,
    ).toBe(false);
    // The engine-default invariant: the drift-guarded constant IS node:sqlite.
    expect(DEFAULT_DB_ENGINE).toBe('node-sqlite');
  });

  it.skipIf(!IS_INTERNAL_REPO)('(c) the CI Node-major matrix drops < 22, keeps latest + the required Gate', () => {
    const ci = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');
    expect(ci, 'ci.yml must define the native-module matrix job').toMatch(
      /name:\s*Native Module \(Node \$\{\{ matrix\.node \}\}\)/,
    );
    // The matrix `node:` list must include an auto-tracking 'latest' leg and must NOT
    // include any Node major below the 22.16 floor (20 / 21).
    const nodeList = /\n\s*node:\s*(\[[^\]]*\])/.exec(ci)?.[1] ?? '';
    expect(nodeList, 'matrix node: list must be present').not.toBe('');
    expect(nodeList).toMatch(/'latest'/);
    expect(nodeList).not.toMatch(/'2[01]'/); // no Node 20 or 21 legs
    expect(ci, 'ci.yml must define the static Native Module Gate required job').toMatch(
      /name:\s*Native Module Gate/,
    );

    const ruleset = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.github', 'rulesets', 'main-branch.json'), 'utf-8'),
    ) as { rules: Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }> };
    const checks =
      ruleset.rules.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks ?? [];
    expect(
      checks.map((c) => c.context),
      'main-branch.json must require the Native Module Gate status check',
    ).toContain('Native Module Gate');
  });
});

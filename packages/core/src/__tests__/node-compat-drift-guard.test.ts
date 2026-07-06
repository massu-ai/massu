import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

/* ------------------------------------------------------------------ */
/*  Node-major compatibility drift-guard.                             */
/*                                                                    */
/*  Incident 2026-07-05 (Node 26 native-module ABI mismatch):         */
/*  @massu/core shipped a prebuilt better-sqlite3 binary compiled     */
/*  for an older NODE_MODULE_VERSION (ABI) and capped                 */
/*  `engines.node` at `<26.0.0`. When Node 26 (ABI 147) became the    */
/*  machine default, the native module failed to load — the license   */
/*  check + memory DB were non-functional in every consumer repo.     */
/*                                                                    */
/*  This test makes that class of regression structurally hard to     */
/*  reintroduce:                                                      */
/*    (a) the native module actually loads under whatever Node runs   */
/*        the suite (in CI that is the 20/22/24/26/latest matrix);    */
/*    (b) `engines.node` carries NO artificial upper bound (`<`);     */
/*    (c) the CI structural guard (matrix + required gate) stays      */
/*        wired — matrix includes an auto-tracking `latest` leg and   */
/*        the ruleset requires the `Native Module Gate`.              */
/* ------------------------------------------------------------------ */

const CORE_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(CORE_ROOT, '..', '..');

// The CI-structure assertions (c) reference the INTERNAL repo's ci.yml matrix +
// main-branch.json ruleset. The public mirror (github.com/massu-ai/massu) has a
// separate core-only ci.public.yml + main-branch.public.json and no website/, so
// (c) must not run there. Same IS_INTERNAL_REPO signal as
// coverage-floor-monotonic.test.ts / ci-prepush-parity.test.ts. Parts (a)+(b)
// (native-module load + engines-no-ceiling) are universal and run everywhere.
const IS_INTERNAL_REPO = existsSync(resolve(REPO_ROOT, 'website', 'vitest.config.ts'));

describe('Node-major native-module compatibility (incident 2026-07-05)', () => {
  it('(a) better-sqlite3 loads + round-trips under the current Node ABI', () => {
    // Fails immediately if the installed prebuilt binary does not match the
    // running Node's NODE_MODULE_VERSION — the exact 2026-07-05 symptom.
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
      const row = db.prepare('SELECT x FROM t').get() as { x: number };
      expect(row.x).toBe(42);
    } finally {
      db.close();
    }
  });

  it('(b) engines.node declares NO artificial upper bound', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(CORE_ROOT, 'package.json'), 'utf-8'),
    ) as { engines?: { node?: string } };
    const range = pkg.engines?.node ?? '';
    expect(range, 'engines.node must be declared').not.toBe('');
    // A `<` upper bound is what locked Node 26 out. Re-adding one (e.g.
    // `<27.0.0`) would recreate the "new Node major is excluded" bug class,
    // so it must be an intentional, reviewed change that updates this guard.
    expect(
      range.includes('<'),
      `engines.node = "${range}" must not impose a "<" upper bound (that is the ` +
        `bug class from the 2026-07-05 Node-26 incident). Widen the range and ` +
        `rely on the Node-major CI matrix to catch real breakage.`,
    ).toBe(false);
    expect(range).toMatch(/>=\s*20/);
  });

  it.skipIf(!IS_INTERNAL_REPO)('(c) the CI Node-major structural guard stays wired', () => {
    const ci = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');
    // The matrix job exists and auto-tracks the newest Node release so a
    // FUTURE major that breaks the native module is caught without a manual
    // matrix edit.
    expect(ci, 'ci.yml must define the native-module matrix job').toMatch(
      /name:\s*Native Module \(Node \$\{\{ matrix\.node \}\}\)/,
    );
    expect(ci, "the native-module matrix must include an auto-tracking 'latest' leg").toMatch(
      /matrix:\s*\n\s*node:\s*\[[^\]]*'latest'[^\]]*\]/,
    );
    expect(ci, 'ci.yml must define the static Native Module Gate required job').toMatch(
      /name:\s*Native Module Gate/,
    );

    const ruleset = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.github', 'rulesets', 'main-branch.json'), 'utf-8'),
    ) as { rules: Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }> };
    const checks =
      ruleset.rules.find((r) => r.type === 'required_status_checks')?.parameters
        ?.required_status_checks ?? [];
    expect(
      checks.map((c) => c.context),
      'main-branch.json must require the Native Module Gate status check',
    ).toContain('Native Module Gate');
  });
});

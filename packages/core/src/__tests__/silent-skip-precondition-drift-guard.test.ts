// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * G-1 / plan-2026-07-26-anti-vacuity-9-unproven-gates — THE SILENT-SKIP CLASS.
 *
 * A bare `return;` inside an `it()`/`test()` callback body exits the test having
 * asserted nothing, and vitest reports that as PASSED. "The precondition was
 * missing" and "the assertions all held" render identically — the blind-gate law
 * (CR-65) aimed at the test suite itself. `core-bundled-files-presence.test.ts`
 * shipped that way and was scored as a proven can-fail gate while it could not
 * observe anything at all.
 *
 * THE INVARIANT: no `it()`/`test()` callback body may contain a `return` statement.
 * There are exactly three correct destinations for what used to be a silent skip:
 *
 *   1. A build in the same job satisfies it  -> a FAILING assertion carrying the
 *      remedy. The artifact's absence is a defect, not a reason to go quiet.
 *   2. Known at collection time              -> `it.skipIf(cond)(...)`, which
 *      vitest reports as SKIPPED — a state distinguishable from PASSED.
 *   3. Only knowable at run time             -> `ctx.skip()` (take the context
 *      parameter), likewise reported as SKIPPED.
 *
 * A two-branch test that asserts on both paths uses `if/else`, not an early
 * `return` — the return buys nothing and is indistinguishable from a skip.
 *
 * Denominators are REPORTED and ASSERTED (M1): "scanned 0, found 0" must be a loud
 * error, never a pass. The recursive file count is taken from `find(1)` — a source
 * this sweep does NOT own — and compared against the sweep's own walk, because a
 * check that derives both sides from one glob compares a number to itself. Two
 * earlier regex attempts at this census used a NON-recursive `__tests__/*.test.ts`
 * glob and were structurally blind to the 18 files in `lsp/`, `security/` and
 * `watch/` — one of which carries five hits of this exact shape.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = __dirname_;
const REPO_ROOT = join(TESTS_DIR, '..', '..', '..', '..');

/** A `return` statement whose nearest enclosing function is an it()/test() callback. */
export interface SilentSkipHit {
  file: string;
  line: number;
  text: string;
}

export interface SweepReport {
  scanned: number;
  parsed: number;
  unparseable: string[];
  hits: SilentSkipHit[];
  filesWithHits: string[];
  unboundSkips: SilentSkipHit[];
}

const RUNNERS = new Set(['it', 'test']);

/**
 * Resolve the callback of an it()/test() registration, covering every call shape
 * vitest accepts: `it(...)`, `it.only/skip/todo/concurrent(...)`,
 * `it.each(table)(...)`, `it.skipIf(cond)(...)`, `it.runIf(cond)(...)`.
 * Returns null for anything that is not a test registration.
 */
function testCallbackOf(node: ts.Node): ts.FunctionExpression | ts.ArrowFunction | null {
  if (!ts.isCallExpression(node)) return null;
  let head: ts.Expression = node.expression;
  // it.each(table)(name, fn) / it.skipIf(cond)(name, fn): unwrap the outer call.
  if (ts.isCallExpression(head)) head = head.expression;
  let base: ts.Expression = head;
  while (ts.isPropertyAccessExpression(base)) base = base.expression;
  if (!ts.isIdentifier(base) || !RUNNERS.has(base.text)) return null;
  for (const arg of node.arguments) {
    if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)) return arg;
  }
  return null;
}

/**
 * SECOND DETECTOR — `ctx.skip()` called in a test callback that never bound `ctx`.
 *
 * This is the defect the FIRST detector's own remedy text creates. Option (3) of the
 * guidance below says "take (ctx) and call ctx.skip()"; applying it while forgetting the
 * parameter yields `ReferenceError: ctx is not defined` — and only on the skip branch,
 * which is precisely the branch that used to be the silent `return`. So the repair is
 * invisible locally (the branch is not taken) and explodes wherever the precondition is
 * genuinely absent. On 2026-07-28 it shipped to CI and reddened the Tarball E2E job;
 * a repo-wide AST sweep then found THREE candidate sites where CI had surfaced ONE
 * (G6/CR-74 — a fix is a set of sites, and CI only shows you the branch it took).
 *
 * Scope-correct by construction: it compares against the enclosing test callback's own
 * parameter names rather than grepping for the literal token `ctx`, so a callback that
 * names it `t` or destructures `{ skip }` is judged on what it actually bound. It also
 * walks the AST rather than the text, so the `ctx.skip` inside this file's own guidance
 * STRING is not a hit — a detector that reads prose as code is one people learn to
 * ignore (G18/CR-83), and this file contains exactly that prose.
 */
export function findUnboundSkips(fileName: string, source: string): SilentSkipHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const lines = source.split('\n');
  const hits: SilentSkipHit[] = [];

  /** Parameter identifiers bound by this callback (handles `(ctx)` and `({ skip })`). */
  const boundNames = (cb: ts.FunctionExpression | ts.ArrowFunction): Set<string> => {
    const names = new Set<string>();
    for (const p of cb.parameters) {
      if (ts.isIdentifier(p.name)) names.add(p.name.text);
      else p.name.forEachChild((c) => {
        if (ts.isBindingElement(c) && ts.isIdentifier(c.name)) names.add(c.name.text);
      });
    }
    return names;
  };

  const visit = (node: ts.Node): void => {
    const cb = testCallbackOf(node);
    if (cb && cb.body) {
      const bound = boundNames(cb);
      const inner = (n: ts.Node): void => {
        // A nested function may legitimately close over an outer binding; restart there.
        if (isFunctionLike(n) && n !== cb) {
          visit(n);
          return;
        }
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'skip' &&
          ts.isIdentifier(n.expression.expression) &&
          !bound.has(n.expression.expression.text)
        ) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          hits.push({ file: fileName, line, text: (lines[line - 1] ?? '').trim() });
        }
        ts.forEachChild(n, inner);
      };
      ts.forEachChild(cb.body, inner);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n)
  );
}

/**
 * The detector. Exported so each detection path can be pinned by a fixture below
 * (G18: a rule with N detection paths and fewer fixtures is decoration).
 *
 * It is an AST walk, not a line scan: the guard and its `return` may be any
 * distance apart, the predicate may be hoisted into a `const`, and the shape may
 * be a brace block or a single line. Three independent regex detectors disagreed
 * on this corpus and no one of them was a superset of the others.
 */
export function findSilentSkips(fileName: string, source: string): SilentSkipHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const lines = source.split('\n');
  const hits: SilentSkipHit[] = [];

  const visitInTest = (node: ts.Node): void => {
    // A nested function owns its own returns — descend as if outside a test body.
    if (isFunctionLike(node)) {
      visitTop(node);
      return;
    }
    if (ts.isReturnStatement(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      hits.push({ file: fileName, line, text: (lines[line - 1] ?? '').trim() });
    }
    ts.forEachChild(node, visitInTest);
  };

  const visitTop = (node: ts.Node): void => {
    const cb = testCallbackOf(node);
    if (cb && cb.body) {
      ts.forEachChild(cb.body, visitInTest);
      // The registration's other arguments are ordinary code.
      if (ts.isCallExpression(node)) {
        for (const arg of node.arguments) if (arg !== cb) visitTop(arg);
      }
      return;
    }
    ts.forEachChild(node, visitTop);
  };

  ts.forEachChild(sf, visitTop);
  return hits;
}

/** Does TypeScript's parser accept this source outright? */
export function isParseable(fileName: string, source: string): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is not on the public type but is present on every SourceFile.
  const diags = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  return diags.length === 0;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * The independent enumeration (VR-G-1 (c)). `find(1)` is not this module's walker,
 * so a walker that silently lost a subdirectory disagrees with it instead of
 * agreeing with itself. Fails LOUD rather than returning a number nobody produced.
 */
function findRecursiveCount(): number {
  const out = execFileSync('find', [TESTS_DIR, '-name', '*.test.ts', '-type', 'f'], {
    encoding: 'utf-8',
  });
  const n = out.split('\n').filter((l) => l.trim() !== '').length;
  if (n === 0) throw new Error(`find(1) enumerated 0 test files under ${TESTS_DIR} — refusing to report clean`);
  return n;
}

function sweep(): SweepReport {
  const files = walk(TESTS_DIR).sort();
  const unparseable: string[] = [];
  const unboundSkips: SilentSkipHit[] = [];
  const hits: SilentSkipHit[] = [];
  let parsed = 0;

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const source = readFileSync(file, 'utf-8');
    if (!isParseable(file, source)) {
      // A file the AST cannot parse is a HARD ERROR, not a zero-hit file. A
      // per-file try/catch here keeps `scanned` at the full count while the hits
      // silently vanish — exactly how the five hits in watch/ disappeared before.
      unparseable.push(rel);
      continue;
    }
    parsed++;
    for (const h of findSilentSkips(file, source)) hits.push({ ...h, file: rel });
    for (const h of findUnboundSkips(file, source)) unboundSkips.push({ ...h, file: rel });
  }

  const filesWithHits = [...new Set(hits.map((h) => h.file))].sort();
  return { scanned: files.length, parsed, unparseable, hits, filesWithHits, unboundSkips };
}

describe('silent-skip precondition drift-guard (G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates)', () => {
  const report = sweep();
  const findCount = findRecursiveCount();

  const DENOMINATOR =
    `find(1) recursive: ${findCount}  scanned: ${report.scanned}  ` +
    `parsed: ${report.parsed}  unparseable: ${report.unparseable.length}  ` +
    `hits: ${report.hits.length} across ${report.filesWithHits.length} file(s)`;

  // M1 — PROVE IT LOOKED. The denominator is carried in this test's NAME, not only in
  // a console.log: vitest suppresses collection-phase stdout on a passing run, so a
  // log line here would be visible only when the guard is already failing — which is
  // the one moment a denominator is not what you need. A name is always in the report.
  it(`sweep denominator — ${DENOMINATOR}`, () => {
    expect(
      report.scanned,
      'the sweep walked ZERO test files — it cannot have found anything, so it must not report clean',
    ).toBeGreaterThan(0);
  });

  it("the sweep's own walk agrees with find(1), an enumeration it does not own", () => {
    expect(
      report.scanned,
      `sweep walked ${report.scanned} *.test.ts, find(1) sees ${findCount} under ${TESTS_DIR}. ` +
        'A non-recursive glob reproduces the exact denominator defect this guard exists to close.',
    ).toBe(findCount);
  });

  it('every test file parses (an unparseable file is a hard error, not a zero-hit file)', () => {
    expect(
      report.unparseable,
      `TypeScript could not parse: ${report.unparseable.join(', ')}. Hits in an unparseable file ` +
        'vanish while the scanned count stays whole — the failure mode is a silent under-count.',
    ).toEqual([]);
  });

  it(`no it()/test() body calls ctx.skip() without binding it (unbound: ${report.unboundSkips.length})`, () => {
    const detail = report.unboundSkips.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
    expect(
      report.unboundSkips,
      `${report.unboundSkips.length} unbound skip-call site(s):\n${detail}\n\n` +
        'This throws `ReferenceError: <name> is not defined` — but ONLY on the branch that ' +
        'takes the skip, which is the branch that used to be the silent `return`. So it ' +
        'passes locally, where the precondition is present, and explodes wherever it is not ' +
        '(2026-07-28: reddened the Tarball E2E CI job; a repo-wide sweep then found more ' +
        'sites than CI had surfaced).\n' +
        'Fix: give the callback the parameter — `it("...", (ctx) => { ... ctx.skip() })`.',
    ).toEqual([]);
  });

  // FIXTURES — one per detection path, each demanded to FIRE. A rule with N paths and
  // fewer fixtures is decoration (G18); these also pin the two shapes that must NOT fire.
  it('findUnboundSkips fixtures: fires on unbound, silent on bound and on prose', () => {
    const fire = (src: string) => findUnboundSkips('f.ts', src).length;

    // FIRES: the real 2026-07-28 shape — no parameter at all.
    expect(fire(`it('x', () => { if (!ok) ctx.skip(); });`), 'arrow, no params').toBe(1);
    // FIRES: async variant (rule-candidate-applier.test.ts's shape).
    expect(fire(`it('x', async () => { ctx.skip(); });`), 'async arrow, no params').toBe(1);
    // FIRES: a parameter exists but is not the identifier being called.
    expect(fire(`it('x', (other) => { ctx.skip(); });`), 'wrong param name').toBe(1);

    // SILENT: correctly bound.
    expect(fire(`it('x', (ctx) => { ctx.skip(); });`), 'bound ctx').toBe(0);
    // SILENT: bound under a different name — the rule must judge the binding, not the token.
    expect(fire(`it('x', (t) => { t.skip(); });`), 'bound as t').toBe(0);
    // SILENT: `ctx.skip` inside a STRING is documentation, not an execution surface. This
    // very file's remedy text contains that sequence; a text scanner flags its own guidance.
    expect(fire(`it('x', () => { expect(1).toBe(1, 'take (ctx) and call ctx.skip()'); });`),
      'prose in a message string').toBe(0);
    // SILENT: not a test registration at all.
    expect(fire(`function helper() { ctx.skip(); }`), 'outside any test').toBe(0);
  });

  it('no it()/test() body contains a `return` statement', () => {
    const detail = report.hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
    expect(
      report.hits,
      `${report.hits.length} silent-skip site(s) across ${report.filesWithHits.length} file(s):\n${detail}\n\n` +
        'A bare `return` in an it() body makes the test PASS having asserted nothing. Choose one:\n' +
        '  (1) precondition a build satisfies -> a FAILING assertion carrying the build command;\n' +
        '  (2) condition known at collection time -> it.skipIf(cond)(...)  [reports SKIPPED];\n' +
        '  (3) condition only knowable at run time -> take (ctx) and call ctx.skip()  [reports SKIPPED];\n' +
        '  (4) a genuine two-branch test that asserts on both paths -> if/else, no return.\n' +
        'Do NOT re-add the skip: a skipped it() is reported as PASSED, which is how this class shipped.',
    ).toEqual([]);
  });
});

/**
 * ONE FIXTURE PER DETECTION PATH (G18/CR-72). Each must FIRE. A detector built as
 * a union of the three regex scans that preceded it would satisfy the corpus
 * assertion above and still miss the long-distance and hoisted-predicate forms —
 * "a number that looks like a measurement and is a guess".
 */
describe('silent-skip detector — every detection path has a fixture that FIRES', () => {
  const cases: Array<{ name: string; src: string; expected: number }> = [
    {
      name: 'single-line form',
      src: `it('x', () => { if (!existsSync(P)) return; expect(1).toBe(1); });`,
      expected: 1,
    },
    {
      name: 'brace-block form',
      src: [
        `it('x', () => {`,
        `  if (!existsSync(P)) {`,
        `    console.warn('skip');`,
        `    return;`,
        `  }`,
        `  expect(1).toBe(1);`,
        `});`,
      ].join('\n'),
      expected: 1,
    },
    {
      name: 'long-distance hoisted predicate (defeats every fixed-lookahead scan)',
      src: [
        `it('x', () => {`,
        `  const ready = existsSync(P);`,
        `  const a = 1;`,
        `  const b = 2;`,
        `  const c = 3;`,
        `  const d = 4;`,
        `  const e = 5;`,
        `  const f = 6;`,
        `  const g = 7;`,
        `  if (!ready) { console.warn('nope'); return; }`,
        `  expect(a + b + c + d + e + f + g).toBeGreaterThan(0);`,
        `});`,
      ].join('\n'),
      expected: 1,
    },
    {
      name: 'try/catch form (no existsSync predicate at all)',
      src: [
        `it('x', () => {`,
        `  let v;`,
        `  try { v = JSON.parse(readFileSync(P, 'utf-8')); } catch { return; }`,
        `  expect(v).toBeDefined();`,
        `});`,
      ].join('\n'),
      expected: 1,
    },
    {
      name: 'test() alias, not just it()',
      src: `test('x', function () { if (!ok) return; expect(1).toBe(1); });`,
      expected: 1,
    },
    {
      name: 'it.each(table)(name, fn) — the callback is behind an outer call',
      src: `it.each([[1]])('x %i', (n) => { if (!n) return; expect(n).toBe(1); });`,
      expected: 1,
    },
    {
      name: 'nested-file-scope registration inside describe()',
      src: [
        `describe('d', () => {`,
        `  for (const id of IDS) {`,
        `    it(\`\${id}\`, () => {`,
        `      if (!existsSync(P)) return;`,
        `      expect(id).toBeTruthy();`,
        `    });`,
        `  }`,
        `});`,
      ].join('\n'),
      expected: 1,
    },
    // Negative controls — a detector that flags these is a detector people disable.
    {
      name: 'NEGATIVE: return inside a nested callback belongs to that callback',
      src: [
        `it('x', () => {`,
        `  const out = items.filter((i) => { if (!i) return false; return true; });`,
        `  expect(out).toEqual([]);`,
        `});`,
      ].join('\n'),
      expected: 0,
    },
    {
      name: 'NEGATIVE: ctx.skip() is the sanctioned runtime skip, not a return',
      src: `it('x', (ctx) => { if (!ready) { ctx.skip(); } expect(1).toBe(1); });`,
      expected: 0,
    },
    {
      name: 'NEGATIVE: it.skipIf() with no return in the body',
      src: `it.skipIf(!ready)('x', () => { expect(1).toBe(1); });`,
      expected: 0,
    },
    {
      name: 'NEGATIVE: a return in a plain top-level helper is not a test body',
      src: `function helper() { if (!ok) return; doThing(); }`,
      expected: 0,
    },
  ];

  for (const c of cases) {
    it(`detects: ${c.name}`, () => {
      const found = findSilentSkips('fixture.test.ts', c.src);
      expect(
        found.length,
        `fixture "${c.name}" expected ${c.expected} hit(s), detector found ${found.length}: ` +
          JSON.stringify(found),
      ).toBe(c.expected);
    });
  }

  it('the parseability check can itself go RED (M2 — fail closed, never empty)', () => {
    expect(isParseable('ok.test.ts', `it('x', () => { expect(1).toBe(1); });`)).toBe(true);
    expect(isParseable('broken.test.ts', `it('x', () => { expect(1).toBe(`)).toBe(false);
  });
});

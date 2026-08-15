// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Detector for WALL-CLOCK BUDGET ASSERTIONS in the correctness test suite.
 *
 * THE DEFECT CLASS
 * ----------------
 * `expect(elapsedMs).toBeLessThan(2000)` asserts a property of the MACHINE, not
 * of the code. On a host running concurrent work it fails for reasons unrelated
 * to the change under test, and on a fast host it passes a genuinely regressed
 * implementation. Both directions were observed here:
 *
 *   2026-07-23  template-engine.test.ts   RED at 117.8ms against a 100ms bound,
 *                                         implementation still perfectly linear
 *   2026-07-28  codebase-introspector     RED at 126,715ms against a 15s bound,
 *                                         1.32s in isolation on the same commit
 *
 * Each was "repaired" by widening the bound (100 -> 2000, 5s -> 15s + retry:2),
 * which only moves the machine speed at which it misfires — and `retry: 2` makes
 * the assertion best-of-3, systematically HIDING the regressions it exists to
 * catch. A brick gate teaches `--no-verify`, so this is not a cosmetic concern.
 *
 * THE REPLACEMENT
 * ---------------
 * State the property directly and deterministically:
 *   - bounded work      -> count operations (see `recordReads` in
 *                          codebase-introspector.test.ts)
 *   - no-retry / single-shot -> assert the call count
 *   - a configured timeout   -> assert the value reached the API
 *   - a COMPLEXITY class     -> assert a SCALING RATIO (see ./scaling.ts); a
 *                              ratio is a property of the algorithm, and the two
 *                              measurements share ambient load so it cancels
 *
 * WHAT COUNTS AS A HIT
 * --------------------
 * `expect(<v>).toBeLessThan|toBeGreaterThan[OrEqual](<numeric literal>)` where
 * `<v>` is an identifier holding a measured DURATION — assigned from a time
 * source, or from arithmetic over one.
 *
 * Deliberately NOT a hit: a property access such as `m.ratio` or
 * `blocked.retryAfter`. An early revision resolved those transitively and
 * flagged `website/src/__tests__/rate-limit.test.ts:33`, where `blocked` merely
 * descends from a `Date.now()`-seeded id — prose-level reasoning, not a
 * duration. A gate that cries wolf is one people learn to ignore, so the rule is
 * narrowed to what it can actually justify.
 */
import ts from 'typescript';

const TIME_SOURCE = /\bprocess\.hrtime\b|\bDate\.now\s*\(\s*\)|\bperformance\.now\s*\(\s*\)/;

const COMPARISONS = new Set([
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
]);

export interface WallClockHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Collect identifiers bound to a measured duration.
 *
 * Two admission rules, both narrow on purpose:
 *   1. the initializer mentions a time source directly, or
 *   2. the initializer is ARITHMETIC (`-`, `/`, `*`, `+`) that references an
 *      already-known duration identifier.
 *
 * Rule 2 is what makes `const elapsed = Number(end - start) / 1e6` resolve while
 * `const blocked = await rateLimit(id, ...)` does not: a call whose ARGUMENT
 * merely mentions a duration does not itself yield one.
 */
function collectDurationIdents(sf: ts.SourceFile): Set<string> {
  const idents = new Set<string>();

  const hasArithmeticOver = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        const arithmetic =
          op === ts.SyntaxKind.MinusToken ||
          op === ts.SyntaxKind.SlashToken ||
          op === ts.SyntaxKind.AsteriskToken ||
          op === ts.SyntaxKind.PlusToken;
        if (arithmetic) {
          const text = n.getText(sf);
          for (const known of idents) {
            if (new RegExp(`\\b${known}\\b`).test(text)) { found = true; return; }
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };

  // Repeat to a fixpoint: `start` -> `elapsedNs` -> `elapsedMs`.
  for (let pass = 0; pass < 4; pass++) {
    const before = idents.size;
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        n.name &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        !idents.has(n.name.text)
      ) {
        const init = n.initializer.getText(sf);
        if (TIME_SOURCE.test(init) || hasArithmeticOver(n.initializer)) {
          idents.add(n.name.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (idents.size === before) break;
  }
  return idents;
}

/**
 * Find wall-clock budget assertions in one source file.
 *
 * Throws on a source TypeScript cannot parse — an unparseable file must never
 * be reported as a zero-hit file (M2, fail closed).
 */
export function findWallClockBudgets(fileName: string, source: string): WallClockHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const durations = collectDurationIdents(sf);
  const hits: WallClockHit[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (COMPARISONS.has(method)) {
        const receiver = n.expression.expression;
        if (
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'expect' &&
          receiver.arguments.length > 0
        ) {
          const subject = receiver.arguments[0];
          // A bare identifier, or arithmetic over one. NOT a property access.
          const isDuration =
            (ts.isIdentifier(subject) && durations.has(subject.text)) ||
            (ts.isBinaryExpression(subject) &&
              [...durations].some((d) => new RegExp(`\\b${d}\\b`).test(subject.getText(sf))));
          if (isDuration) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            hits.push({
              file: fileName,
              line: line + 1,
              text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/**
 * SECOND DETECTION PATH — SLEEP-THEN-ASSERT.
 *
 * The path above binds a measured DURATION under comparison. That predicate could not see
 * the shape which took `real-chokidar.test.ts` RED in the 2026-08-11 pre-push battery:
 *
 *     await new Promise<void>((r) => setTimeout(r, 1_000));
 *     expect(fired).toBeGreaterThanOrEqual(1);        // expected 0 to be >= 1
 *
 * No duration is ever bound, so nothing matched — yet it is the same defect and fails in the
 * same two directions: RED on a loaded host (that run packed 502s of test time into 38s of
 * wall clock), GREEN on a fast idle box with a genuinely broken watcher. The class had TWO
 * prior incidents and three prior memories and still recurred, because the guard's CANDIDATE
 * SET did not include this form (G18 — the candidate set IS the gate).
 *
 * THE PREDICATE IS DELIBERATELY THRESHOLD-FREE. "Sleeps longer than N ms" would smuggle in an
 * unmeasured constant about the outside world (CR-68). The defect is not that a sleep is LONG;
 * it is that an assertion is allowed to depend on a fixed span elapsing. So: a fixed-duration
 * sleep is a hit when an `expect(...)` follows it IN THE SAME BLOCK with no intervening loop.
 *
 * An intervening loop is what a POLL looks like, and a poll is the correct repair — it waits
 * for the CONDITION and cannot flake on a busy host. That single exception is what keeps the
 * rule from crying wolf on the two legitimate bootstrap waits in that same file: one has no
 * assertion after it at all, and the other is followed by the poll loop that replaced this bug.
 */
const SLEEP_CALLEES = new Set(['setTimeout', 'setInterval', 'sleep', 'delay']);

/**
 * A BLOCK-BODIED function is a new scope, and crossing into one is how this rule first
 * cried wolf: it descended into a `describe(... () => { ... })` to find a sleep and paired
 * it with an `expect` in a DIFFERENT `describe`. An EXPRESSION-bodied arrow is not a scope
 * boundary in the same sense — `new Promise((r) => setTimeout(r, N))` IS the sleep idiom, so
 * the walk must reach through it. That asymmetry is the whole rule.
 */
const crossesScope = (n: ts.Node): boolean =>
  ts.isFunctionLike(n) && !!(n as ts.SignatureDeclaration).body && ts.isBlock((n as ts.SignatureDeclaration).body as ts.Node);

function fixedSleepIn(stmt: ts.Node, sf: ts.SourceFile): string | null {
  let hit: string | null = null;
  const walk = (n: ts.Node): void => {
    if (hit) return;
    if (n !== stmt && crossesScope(n)) return;
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name.text
          : '';
      // A ZERO delay is a macrotask yield ('let the event loop turn'), not a span. It
      // encodes no expectation about how long anything takes, so it is not this defect.
      const fixedSpan = n.arguments.some(
        (a) => ts.isNumericLiteral(a) && Number(a.getText(sf).replace(/_/g, '')) > 0,
      );
      if (SLEEP_CALLEES.has(callee) && fixedSpan) {
        hit = n.getText(sf).replace(/\s+/g, ' ').slice(0, 100);
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(stmt);
  return hit;
}

function containsExpect(stmt: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (n !== stmt && crossesScope(n)) return; // an assertion in a nested scope is not "after" the sleep
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'expect') {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(stmt);
  return found;
}

const isLoop = (s: ts.Statement): boolean =>
  ts.isWhileStatement(s) || ts.isDoStatement(s) || ts.isForStatement(s) ||
  ts.isForOfStatement(s) || ts.isForInStatement(s);

/** Find `sleep a fixed span, then assert` in one source file. Throws on unparseable input (M2). */
export function findSleepThenAssert(fileName: string, source: string): WallClockHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const hits: WallClockHit[] = [];

  const scan = (statements: readonly ts.Statement[]): void => {
    for (let i = 0; i < statements.length; i++) {
      // A sleep carried BY a loop statement is the poll itself, not a fixed wait before an
      // assertion. Without this the rule flagged its own sanctioned repair: the `while`
      // enclosing `setTimeout(r, 25)` matched as a sleep-carrier and the `expect` after the
      // loop matched as the dependent assertion — the guard condemning the fix it prescribes.
      if (isLoop(statements[i])) continue;
      const sleep = fixedSleepIn(statements[i], sf);
      if (!sleep) continue;
      for (let j = i + 1; j < statements.length; j++) {
        if (isLoop(statements[j])) break; // a poll — the correct shape
        if (containsExpect(statements[j])) {
          const { line } = sf.getLineAndCharacterOfPosition(statements[i].getStart(sf));
          hits.push({ file: fileName, line: line + 1, text: sleep });
          break;
        }
      }
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isBlock(n) || ts.isSourceFile(n)) scan(n.statements);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/**
 * THIRD PATH — two competing timeouts in one test, where the SMALLER silently wins.
 *
 * The first two paths bind a MEASURED duration (`elapsedMs`) or a fixed SLEEP. A test
 * timeout binds neither: it is a wall-clock budget on the whole test, and — for the global
 * `testTimeout` — it is declared in ANOTHER FILE (`vitest.config.ts`). So the class recurred
 * a fourth time on 2026-08-12 with this guard green, because the shape was never in its
 * candidate set (G18 — the candidate set IS the gate).
 *
 * WHAT THIS DOES **NOT** FLAG, on purpose: an ordinary explicit timeout. G27 is explicit that
 * "keep an explicit test timeout as the second detection path" is CORRECT — a long test
 * SHOULD declare a generous bound, and flagging that would cry wolf on every legitimate case
 * and get the rule ignored (CR-83).
 *
 * What it flags is the ARITHMETIC CONTRADICTION: a test that grants an inner operation more
 * time than the test itself is allowed to live. `reality-gate-r3-liveness-drift-guard`
 * granted `spawnSync` 300_000 ms while `vitest.config.ts` set `testTimeout: 20000`, so vitest
 * killed the test at 20s no matter what the subprocess budget said. The declared intent was
 * unreachable, and the effective bound was a number the author never chose — which is a
 * machine assertion wearing a config's clothes.
 *
 * `effectiveDefault` is the config's `testTimeout` (vitest's own default is 5000).
 */
const INNER_BUDGET_KEYS = new Set(['timeout', 'timeoutMs']);

function innerBudgetsIn(node: ts.Node, sf: ts.SourceFile): { ms: number; text: string }[] {
  const found: { ms: number; text: string }[] = [];
  const walk = (n: ts.Node): void => {
    // `timeout: <number>` in an options object — spawnSync/execFileSync/execSync/got/fetch.
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      INNER_BUDGET_KEYS.has(ts.isIdentifier(n.name) ? n.name.text : n.name.text) &&
      ts.isNumericLiteral(n.initializer)
    ) {
      const ms = Number(n.initializer.getText(sf).replace(/_/g, ''));
      if (Number.isFinite(ms) && ms > 0) found.push({ ms, text: n.getText(sf).replace(/\s+/g, ' ') });
    }
    // `AbortSignal.timeout(<number>)`.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'timeout' &&
      n.arguments.length === 1 &&
      ts.isNumericLiteral(n.arguments[0])
    ) {
      const ms = Number(n.arguments[0].getText(sf).replace(/_/g, ''));
      if (Number.isFinite(ms) && ms > 0) found.push({ ms, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80) });
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

const TEST_CALLEES = new Set(['it', 'test']);

export function findCompetingTimeouts(
  fileName: string,
  source: string,
  effectiveDefault: number,
): WallClockHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: WallClockHit[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      // `it(...)`, `test(...)`, and the modifier forms `it.each(...)` / `test.skip(...)`.
      const base = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
          ? n.expression.expression.text
          : '';
      if (TEST_CALLEES.has(base) && n.arguments.length >= 2) {
        // VITEST HAS TWO OVERRIDE FORMS AND THE BODY IS NOT ALWAYS ARGUMENT 1:
        //   it(name, fn, 30000)                 <- trailing numeric
        //   it(name, { timeout: 180_000 }, fn)  <- options object
        // Reading argument 1 as the body flagged `plan-status-drift-guard.test.ts:261`,
        // whose options object IS its override — the rule would have reported a correctly
        // bounded test as the defect, which is how a gate earns being ignored (CR-83).
        const body = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (!body) return ts.forEachChild(n, visit);

        const trailingNumeric = n.arguments.find((a, i) => i >= 2 && ts.isNumericLiteral(a));
        let explicit: number | null = trailingNumeric
          ? Number((trailingNumeric as ts.NumericLiteral).getText(sf).replace(/_/g, ''))
          : null;
        if (explicit === null) {
          for (const a of n.arguments) {
            if (a === body || !ts.isObjectLiteralExpression(a)) continue;
            for (const p of a.properties) {
              if (
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.name) &&
                p.name.text === 'timeout' &&
                ts.isNumericLiteral(p.initializer)
              ) {
                explicit = Number(p.initializer.getText(sf).replace(/_/g, ''));
              }
            }
          }
        }
        const effective = explicit ?? effectiveDefault;
        for (const b of innerBudgetsIn(body, sf)) {
          if (b.ms > effective) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            hits.push({
              file: fileName,
              line,
              text:
                `inner budget ${b.ms}ms exceeds the test's effective timeout ${effective}ms ` +
                `(${explicit === null ? 'config testTimeout' : 'explicit'}) — ` +
                `the smaller silently wins: ${b.text}`,
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

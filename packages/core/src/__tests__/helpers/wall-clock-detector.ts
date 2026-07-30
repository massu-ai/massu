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

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Find POSITIVE per-test / per-hook wall-clock ceilings in a test file, by AST.
 *
 * A run root that declares `testTimeout: 0` has removed the wall-clock ceiling on purpose: a
 * hang is decided by the progress-silence detector (scripts/lib/hang_watch.mjs), because a
 * fixed duration fails a healthy test whenever the host is busy (plan-2026-09-24-a-hang-is-the-
 * absence-of-events). A positive timeout written on an individual `it`, hook or `vi.setConfig`
 * reinstates exactly that ceiling for one test, and it is invisible to a check that reads only
 * the config. Measured 2026-11-08: 38 such sites across 20 files of packages/core, and one of them
 * (knowledge-e2e, 30 s) failed two full-suite runs at host load average ~24 while passing alone.
 *
 * Parsed, never regexed: a regex census of the same tree missed sites (`git grep -E` has no
 * `\s`) and also matched arguments that are not timeouts (`longText.slice(0, 5000)`).
 */

import ts from 'typescript';

/** vitest entry points whose trailing numeric/options argument is a timeout. */
const RUNNERS = new Set(['it', 'test', 'describe', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach', 'bench']);

export interface Ceiling {
  line: number;
  /** The call as written, e.g. `it` or `it.skipIf(cond)` or `vi.setConfig`. */
  call: string;
  form: 'positional' | 'options.timeout' | 'vi.setConfig';
  value: number;
}

function numeric(n: ts.Node): number | null {
  return ts.isNumericLiteral(n) ? Number(n.text.replace(/_/g, '')) : null;
}

export function findPositiveCeilings(fileName: string, text: string): Ceiling[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: Ceiling[] = [];
  const lineOf = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      let callee: ts.Expression = n.expression;
      while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression;
      const root = ts.isIdentifier(callee) ? callee.text : null;
      const call = n.expression.getText(src);

      if (root && RUNNERS.has(root)) {
        n.arguments.forEach((arg, i) => {
          if (i === 0) return; // the name
          const v = numeric(arg);
          if (v !== null && v > 0) out.push({ line: lineOf(arg), call, form: 'positional', value: v });
          if (ts.isObjectLiteralExpression(arg)) {
            for (const p of arg.properties) {
              if (!ts.isPropertyAssignment(p) || p.name.getText(src) !== 'timeout') continue;
              const pv = numeric(p.initializer);
              if (pv !== null && pv > 0) out.push({ line: lineOf(p), call, form: 'options.timeout', value: pv });
            }
          }
        });
      }

      if (call === 'vi.setConfig' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        for (const p of n.arguments[0].properties) {
          if (!ts.isPropertyAssignment(p) || !/^(testTimeout|hookTimeout)$/.test(p.name.getText(src))) continue;
          const pv = numeric(p.initializer);
          if (pv !== null && pv > 0) out.push({ line: lineOf(p), call, form: 'vi.setConfig', value: pv });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** The `testTimeout` a vitest config declares, or `null` when it declares none. */
export function declaredTestTimeout(configText: string): number | null {
  const m = /\btestTimeout\s*:\s*([0-9_]+)/.exec(configText);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: no wall-clock BUDGET assertion may re-enter the correctness suite.
 *
 * Closes the class documented in `./helpers/wall-clock-detector.ts`. Nine such
 * assertions across six files were converted on 2026-07-28 after one of them
 * (`codebase-introspector.test.ts`) blocked a push at 126,715ms against a 15s
 * budget while passing in 1.32s in isolation on the same commit.
 *
 * If this regresses tomorrow, THIS goes red.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { findWallClockBudgets, type WallClockHit } from './helpers/wall-clock-detector.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Legitimate wall-clock budgets, each with a cited reason.
 *
 * EMPTY, and that is the intended steady state. A complexity claim belongs in
 * `helpers/scaling.ts` (a ratio), a work bound belongs in operation counting.
 * Adding an entry here is a RULING that neither form can express the property —
 * write the reason, not just the path.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

/** Every tracked test file, from git — the authoritative population. */
function trackedTestFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '*.test.ts', '*.test.tsx'],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  );
  const files = out.split('\n').filter(Boolean);
  // M1 — PROVE IT LOOKED. "Scanned 0, found 0" must be a loud error, never a pass.
  if (files.length === 0) {
    throw new Error('git ls-files enumerated 0 test files — refusing to report clean');
  }
  return files.sort();
}

/**
 * This guard's own path. It MUST appear in the swept population.
 *
 * This is the "prove it looked" check (M1), and it is deliberately NOT a
 * minimum file count: the pre-push `[14/22] Sync Check` runs the suite in a
 * PARTIAL scratch copy of the repo, where `git ls-files` legitimately returns
 * 339 test files instead of the full tree's 518. An absolute floor of 400
 * passed locally and failed there — an environment-dependent count masquerading
 * as an invariant. A file that must be present in every environment the suite
 * runs in is the honest form.
 */
const SELF = 'packages/core/src/__tests__/wall-clock-assertion-drift-guard.test.ts';

interface Sweep {
  listed: number;
  parsed: number;
  unreadable: string[];
  hits: WallClockHit[];
  files: string[];
}

function sweep(): Sweep {
  const files = trackedTestFiles();
  const hits: WallClockHit[] = [];
  const unreadable: string[] = [];
  let parsed = 0;

  for (const rel of files) {
    let source: string;
    try {
      source = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    } catch (e) {
      // M2 — FAIL CLOSED. An unreadable input is an ERROR, never an empty one.
      unreadable.push(`${rel}: ${(e as Error).message}`);
      continue;
    }
    parsed++;
    for (const h of findWallClockBudgets(rel, source)) hits.push(h);
  }
  return { listed: files.length, parsed, unreadable, hits, files };
}

describe('wall-clock assertion drift-guard', () => {
  const report = sweep();
  const DENOMINATOR =
    `listed: ${report.listed}  parsed: ${report.parsed}  ` +
    `unreadable: ${report.unreadable.length}  hits: ${report.hits.length}`;

  it(`reports its denominator and reads every tracked test file [${DENOMINATOR}]`, () => {
    expect(report.unreadable, `unreadable files:\n${report.unreadable.join('\n')}`).toEqual([]);
    expect(report.parsed).toBe(report.listed);
    // A sweep that enumerated almost nothing reports "clean" just as loudly as a
    // healthy one. Positive control: the sweep must have seen ITSELF.
    expect(report.files, `sweep did not include its own file (${SELF})`).toContain(SELF);
  });

  it('no test asserts a wall-clock duration against a fixed budget', () => {
    const offending = report.hits.filter((h) => !(h.file in ALLOWLIST));
    const detail = offending.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
    expect(
      offending,
      `${offending.length} wall-clock budget assertion(s):\n${detail}\n\n` +
        'A wall-clock budget asserts a property of the MACHINE, not of the code: it goes RED\n' +
        'when the host is busy (126,715ms vs a 15s bound, 2026-07-28) and GREEN on a fast host\n' +
        'even when the implementation regressed. Widening the bound does not fix it — that was\n' +
        'tried twice (100->2000ms, 5s->15s+retry:2) and `retry: 2` additionally makes the\n' +
        'assertion best-of-3, hiding the regressions it exists to catch.\n\n' +
        'State the property directly instead:\n' +
        '  bounded work        -> count operations (recordReads in codebase-introspector.test.ts)\n' +
        '  no-retry            -> expect(spy).toHaveBeenCalledTimes(1)\n' +
        '  configured timeout  -> assert the value reached the API\n' +
        '  a COMPLEXITY class  -> measureScalingRatio() in ./helpers/scaling.ts\n\n' +
        'If none of those can express it, add the path to ALLOWLIST here WITH a cited reason.',
    ).toEqual([]);
  });

  // FIXTURES — one per detection path, each demanded to FIRE, plus the shapes
  // that must stay SILENT. A rule with N paths and fewer fixtures is decoration.
  it('detector fixtures: fires on real budgets, silent on non-durations', () => {
    const fire = (src: string): number => findWallClockBudgets('f.test.ts', src).length;

    // FIRES: the Date.now() shape (cloud-sync, auto-learning).
    expect(
      fire('const start = Date.now(); const elapsedMs = Date.now() - start; expect(elapsedMs).toBeLessThan(500);'),
      'Date.now() difference',
    ).toBe(1);
    // FIRES: the hrtime shape via a derived variable (introspector, template-engine).
    expect(
      fire('const s = process.hrtime.bigint(); const ms = Number(process.hrtime.bigint() - s) / 1e6; expect(ms).toBeLessThan(2000);'),
      'hrtime derived',
    ).toBe(1);
    // FIRES: performance.now().
    expect(
      fire('const t0 = performance.now(); const d = performance.now() - t0; expect(d).toBeGreaterThan(1);'),
      'performance.now()',
    ).toBe(1);
    // FIRES: arithmetic inline in the expect() argument.
    expect(
      fire('const start = Date.now(); expect(Date.now() - start).toBeLessThan(100);'),
      'inline arithmetic',
    ).toBe(1);

    // SILENT: a PROPERTY of a returned object is not a duration. This is the
    // real website/src/__tests__/rate-limit.test.ts:33 shape that an earlier
    // revision false-flagged.
    expect(
      fire('const id = `x-${Date.now()}`; const blocked = await rateLimit(id); expect(blocked.retryAfter).toBeGreaterThan(0);'),
      'property of a returned object',
    ).toBe(0);
    // SILENT: the sanctioned replacement — a scaling RATIO, read off a result object.
    expect(
      fire('const m = measureScalingRatio(a, b); expect(m.ratio).toBeLessThan(8);'),
      'scaling ratio',
    ).toBe(0);
    // SILENT: a timestamp compared to a timestamp is ordering, not a budget.
    expect(
      fire('const before = Date.now(); const row = read(); expect(row.count).toBe(3);'),
      'timestamp with no budget assertion',
    ).toBe(0);
    // SILENT: no time source anywhere.
    expect(
      fire('const n = list.length; expect(n).toBeLessThan(10);'),
      'plain numeric assertion',
    ).toBe(0);
  });
});

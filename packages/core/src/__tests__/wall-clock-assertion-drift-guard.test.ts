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
import {
  findWallClockBudgets,
  findSleepThenAssert,
  findCompetingTimeouts,
  type WallClockHit,
} from './helpers/wall-clock-detector.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * The effective per-test wall-clock budget, read from the CONFIG rather than assumed.
 *
 * This number lives in a different file from every test it governs, which is precisely why
 * the class recurred with this guard green: auditing a test file alone can never surface it.
 * Fail closed — if the config cannot be read or states no `testTimeout`, use vitest's own
 * documented default (5000) rather than guessing something permissive, because a too-large
 * assumption here makes the third path silently stop firing (M2).
 */
function configuredTestTimeout(): number {
  const VITEST_DEFAULT = 5000;
  try {
    const cfg = readFileSync(join(REPO_ROOT, 'packages/core/vitest.config.ts'), 'utf-8');
    const m = /\btestTimeout\s*:\s*([0-9_]+)/.exec(cfg);
    return m ? Number(m[1].replace(/_/g, '')) : VITEST_DEFAULT;
  } catch {
    return VITEST_DEFAULT;
  }
}
const TEST_TIMEOUT = configuredTestTimeout();

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
    // Second path: sleep-a-fixed-span-then-assert. Same defect class, different shape —
    // it binds no duration, so the path above is structurally blind to it.
    for (const h of findSleepThenAssert(rel, source)) hits.push(h);
    // Third path: two competing timeouts, where the smaller silently wins. Binds no
    // duration AND does not sleep, so both paths above are blind to it — which is how the
    // class reached occurrence #4 with this guard green.
    for (const h of findCompetingTimeouts(rel, source, TEST_TIMEOUT)) hits.push(h);
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

  // ── THIRD PATH: two competing timeouts, smaller silently wins ───────────────────────
  //
  // The must-fire case is the 2026-08-12 defect VERBATIM: `reality-gate-r3-liveness-drift-
  // guard` granted spawnSync 300_000ms while vitest.config.ts capped the test at 20000ms, so
  // the test died at 20s under coverage load and the declared intent was unreachable.
  //
  // The must-stay-SILENT cases matter more than usual here, because the obvious over-broad
  // rule ("flag test timeouts") would fire on every legitimate long test and get this guard
  // ignored (CR-83). G27 explicitly SANCTIONS an explicit timeout as the second detection
  // path — so a generous bound that actually governs is correct, not a defect.
  it('detector fixtures: fires only when an inner budget outlives its test', () => {
    const fire = (src: string, dflt = 20000): number =>
      findCompetingTimeouts('f.test.ts', src, dflt).length;

    // FIRES: the defect verbatim — subprocess budget > config testTimeout, no override.
    expect(
      fire("it('x', () => { const p = spawnSync(c, a, { encoding: 'utf-8', timeout: 300_000 }); });"),
      'spawnSync 300s under a 20s testTimeout',
    ).toBe(1);
    // FIRES: AbortSignal.timeout() outliving the test.
    expect(
      fire("it('x', async () => { await fetch(u, { signal: AbortSignal.timeout(60000) }); });"),
      'AbortSignal.timeout beyond the test budget',
    ).toBe(1);
    // FIRES: an explicit per-test override that is STILL smaller than the inner budget.
    expect(
      fire("it('x', () => { run(c, { timeout: 90000 }); }, 30000);"),
      'explicit override still exceeded',
    ).toBe(1);

    // SILENT: an explicit override that genuinely covers the inner budget. This is the
    // SANCTIONED form (G27) and the shape the 2026-08-12 fix produced — flagging it would
    // punish the repair.
    expect(
      fire("it('x', () => { const p = spawnSync(c, a, { timeout: 300_000 }); }, 300_000);"),
      'override that actually covers the inner budget',
    ).toBe(0);
    // SILENT: an inner budget well under the test's bound — no contradiction to report.
    expect(
      fire("it('x', () => { run(c, { timeout: 50 }); });"),
      'inner budget below the test budget',
    ).toBe(0);
    // SILENT: a timeout with no enclosing test — config/helper code is not this rule's job.
    expect(
      fire('export const opts = { timeout: 600000 };'),
      'timeout outside any test',
    ).toBe(0);
    // SILENT: `timeout` that is not a duration literal cannot be compared, and guessing is
    // how a rule starts crying wolf.
    expect(
      fire("it('x', () => { run(c, { timeout: SOME_CONST }); });"),
      'non-literal timeout',
    ).toBe(0);
  });

  // ── SECOND PATH: sleep-then-assert ──────────────────────────────────────────────────
  //
  // One fixture per branch of the predicate, each demanded to FIRE or to STAY SILENT for
  // its own reason. The must-fire case is the EXACT shape that escaped this guard and took
  // real-chokidar.test.ts red in the 2026-08-11 battery — a regression test cannot find a
  // false negative, so the fixture is the defect verbatim, not a paraphrase of it.
  it('detector fixtures: fires on sleep-then-assert, silent on polls and bare waits', () => {
    const fire = (src: string): number => findSleepThenAssert('f.test.ts', src).length;

    // FIRES: the real defect. A flat sleep, then an assertion that depends on it having
    // been long enough.
    expect(
      fire('await new Promise((r) => setTimeout(r, 1_000)); expect(fired).toBeGreaterThanOrEqual(1);'),
      'the verbatim real-chokidar defect',
    ).toBe(1);

    // FIRES: a named sleep helper is the same defect wearing a nicer API.
    expect(fire('await sleep(500); expect(rows.length).toBe(2);'), 'named sleep helper').toBe(1);

    // SILENT: a POLL. The loop is what makes it wait for the CONDITION rather than the
    // clock, so the assertion no longer depends on a fixed span elapsing.
    expect(
      fire(
        'const deadline = Date.now() + 6000;' +
          'while (fired < 1 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 25)); }' +
          'expect(fired).toBeGreaterThanOrEqual(1);',
      ),
      'bounded poll — the sanctioned repair',
    ).toBe(0);

    // SILENT: a bootstrap wait with no assertion after it. Its failure mode is a retry,
    // not a false verdict.
    expect(
      fire('await new Promise((r) => setTimeout(r, 200)); await handle.stop();'),
      'bare wait, nothing asserted afterwards',
    ).toBe(0);

    // SILENT: a sleep INSIDE a poll body, where the enclosing block asserts nothing.
    expect(
      fire('while (!done) { await new Promise((r) => setTimeout(r, 25)); }'),
      'sleep inside a poll body',
    ).toBe(0);

    // SILENT: no fixed span at all — the delay is computed, so there is no constant to encode
    // an expectation into.
    expect(
      fire('await new Promise((r) => setTimeout(r, backoffMs)); expect(ok).toBe(true);'),
      'computed delay, not a fixed span',
    ).toBe(0);
  });
});

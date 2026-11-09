// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * D-9 of plan-2026-09-24-a-hang-is-the-absence-of-events: a run root that removed the per-test
 * wall-clock ceiling (`testTimeout: 0`) must not have it reinstated one test at a time.
 *
 * The scope is DERIVED: every tracked `vitest.config.ts` is read, and each one declaring
 * `testTimeout: 0` contributes the tracked test files under its directory. A new run root that
 * adopts the silence detector is covered on its first commit. A root that still has a positive
 * or default ceiling (website/) is out of scope on purpose, because there a per-test value RAISES
 * the bound and removing it would tighten it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { findPositiveCeilings, declaredTestTimeout } from './helpers/per-test-ceilings.ts';
import { gitSafeEnv } from './helpers/git-safe-env.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function tracked(...pathspec: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...pathspec], { encoding: 'utf-8', env: gitSafeEnv() })
    .split('\n')
    .filter(Boolean);
}

describe('the detector fires on every form it claims to see (one fixture per path)', () => {
  const cases: Array<[string, string, string]> = [
    ['positional', "it('a', () => {}, 30_000);", 'positional'],
    ['options object', "it('a', { timeout: 30000 }, () => {});", 'options.timeout'],
    ['chained runner', "it.skipIf(x)('a', () => {}, 120_000);", 'positional'],
    ['hook', 'beforeAll(() => {}, 600_000);', 'positional'],
    ['file-level setConfig', 'vi.setConfig({ testTimeout: 60_000 });', 'vi.setConfig'],
  ];
  for (const [name, code, form] of cases) {
    it(`MUST FIRE: ${name}`, () => {
      const found = findPositiveCeilings('fixture.test.ts', code);
      expect(found, code).toHaveLength(1);
      expect(found[0].form).toBe(form);
    });
  }

  it('MUST STAY SILENT on a zero (the removal itself), on no timeout, and on a non-timeout number', () => {
    const code = [
      "it('a', () => {}, 0);",
      "it('b', () => {});",
      "it('c', () => { const s = longText.slice(0, 5000); execFileSync('x', [], { timeout: 30_000 }); });",
      'vi.setConfig({ testTimeout: 0 });',
    ].join('\n');
    expect(findPositiveCeilings('fixture.test.ts', code)).toEqual([]);
  });
});

describe('no positive per-test ceiling in a run root that declares testTimeout: 0', () => {
  const configs = tracked('*vitest.config.ts');
  const zeroRoots = configs
    .filter((c) => declaredTestTimeout(readFileSync(join(REPO_ROOT, c), 'utf-8')) === 0)
    .map((c) => dirname(c));

  it('found at least one such root (M1: a zero-root scope is blind, not clean)', () => {
    expect(configs.length).toBeGreaterThan(0);
    expect(zeroRoots).toContain('packages/core');
  });

  for (const root of zeroRoots) {
    it(`${root}: every tracked test file is free of positive ceilings`, () => {
      const files = tracked(`${root}/**/*.test.ts`);
      expect(files.length, `scanned 0 test files under ${root}: blind, not clean`).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const f of files) {
        for (const c of findPositiveCeilings(f, readFileSync(join(REPO_ROOT, f), 'utf-8'))) {
          offenders.push(`${f}:${c.line}  ${c.call} ${c.form} = ${c.value}`);
        }
      }
      expect(
        offenders,
        `${offenders.length} positive per-test ceiling(s) in ${root}, which runs testTimeout: 0. ` +
          'A hang is decided by scripts/lib/hang_watch.mjs; a fixed duration fails a healthy test ' +
          'on a busy host. Remove the ceiling (or, for a unit that legitimately goes silent for ' +
          'longer than the cadence, emit an explicit beat):\n  ' + offenders.join('\n  '),
      ).toEqual([]);
    });
  }
});

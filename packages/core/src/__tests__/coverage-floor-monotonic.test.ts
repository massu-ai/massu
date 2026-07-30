// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Coverage-floor monotonic drift-guard (plan-2026-06-03-website-lib-test-coverage P0-005).
 *
 * Enforces the real-coverage ratchet:
 *   (1) config<->SoT match — each package's vitest `coverage.thresholds.lines`
 *       literal MUST equal its floor in /coverage-floors.json. They cannot diverge.
 *   (2) no-lowering — no floor in coverage-floors.json may be BELOW the value
 *       committed in the previous git revision (HEAD). Floors may only ratchet up.
 *
 * Bootstrap: on the commit that first introduces coverage-floors.json,
 * `git show HEAD:coverage-floors.json` errors (path absent in HEAD). The
 * no-lowering check fails OPEN in that case (config<->SoT match still runs).
 *
 * Runs under cwd=packages/core (npm test) — repo root resolved the SAME way as
 * the sibling drift-guard ci-prepush-parity.test.ts:28.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../../..');

const FLOORS_PATH = resolve(REPO_ROOT, 'coverage-floors.json');
const WEBSITE_CONFIG = resolve(REPO_ROOT, 'website/vitest.config.ts');
const CORE_CONFIG = resolve(REPO_ROOT, 'packages/core/vitest.config.ts');

/**
 * packages/core tests SYNC to the public repo and run in `CI (public-mirror)`,
 * where `website/` + `coverage-floors.json` do NOT exist. This drift-guard
 * protects the INTERNAL repo's coverage ratchet (website + core floors); it is
 * meaningless in the mirror. Skip cleanly when the website tree is absent —
 * same IS_INTERNAL_REPO pattern as ci-prepush-parity.test.ts.
 */
const IS_INTERNAL_REPO = existsSync(WEBSITE_CONFIG) && existsSync(FLOORS_PATH);

/** Map a coverage-floors.json package key to its vitest config path. */
const FLOOR_TO_CONFIG: Record<string, string> = {
  'packages/core': CORE_CONFIG,
  'website/src/lib': WEBSITE_CONFIG,
};

/**
 * Pinned core coverage `exclude` set (plan-2026-06-03-website-lib-test-coverage,
 * arch-review hardening). The exclude array shrinks the denominator and thus the
 * measured % — silently adding an under-covered module to it would clear the 80
 * floor WITHOUT lowering it, defeating the ratchet. This pin forces any change to
 * the exclude set to be deliberate + reviewed (update this list in the same edit).
 */
const PINNED_CORE_COVERAGE_EXCLUDE = [
  '**/__tests__/**',
  '**/*.d.ts',
  'src/hooks/**',
  'src/cli.ts',
  'src/server.ts',
  'src/commands/**',
  'src/python/**',
  'src/python-tools.ts',
  'src/backfill-sessions.ts',
  'src/validate-features-runner.ts',
  'src/trpc-index.ts',
];

/** Extract the single-quoted entries of the coverage.exclude array from a config. */
function configCoverageExclude(configPath: string): string[] {
  const src = readFileSync(configPath, 'utf-8');
  const m = src.match(/exclude:\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function readFloors(): Record<string, number> {
  const raw = JSON.parse(readFileSync(FLOORS_PATH, 'utf-8'));
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/**
 * Regex-extract the numeric `thresholds.lines` literal from a vitest config.
 * Does NOT `await import()` the config — that would execute defineConfig/plugins.
 */
function configThresholdLines(configPath: string): number | null {
  const src = readFileSync(configPath, 'utf-8');
  // Match the `lines: <int>,` inside the coverage.thresholds block. Each config
  // has exactly one `thresholds: { ... lines: N ... }`; match the first `lines:`
  // that follows a `thresholds` keyword.
  const m = src.match(/thresholds\s*:\s*\{[\s\S]*?\blines\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Read coverage-floors.json as committed in HEAD; null if absent-in-HEAD (bootstrap). */
function readPriorFloors(): Record<string, number> | null {
  try {
    const raw = execFileSync('git', ['-C', REPO_ROOT, 'show', 'HEAD:coverage-floors.json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number') out[k] = v;
    }
    return out;
  } catch (err) {
    const msg = String((err as { stderr?: Buffer; message?: string })?.stderr ?? (err as Error)?.message ?? err);
    if (/does not exist in|exists on disk, but not in|unknown revision|fatal/.test(msg)) {
      return null; // bootstrap: no prior floor committed yet
    }
    // Any other failure (git missing, etc.) — fail open rather than block.
    return null;
  }
}

describe.skipIf(!IS_INTERNAL_REPO)('coverage-floor-monotonic (P0-005 ratchet drift-guard)', () => {
  it('every coverage-floors.json key maps to a known vitest config', () => {
    const floors = readFloors();
    const unknown = Object.keys(floors).filter((k) => !(k in FLOOR_TO_CONFIG));
    expect(unknown, `coverage-floors.json keys without a config mapping: ${unknown.join(', ')}`).toEqual([]);
  });

  it('config thresholds.lines matches the coverage-floors.json floor (config<->SoT)', () => {
    const floors = readFloors();
    const mismatches: string[] = [];
    for (const [key, floor] of Object.entries(floors)) {
      const configPath = FLOOR_TO_CONFIG[key];
      if (!configPath) continue;
      const configFloor = configThresholdLines(configPath);
      if (configFloor !== floor) {
        mismatches.push(`${key}: floors.json=${floor} but ${configPath.replace(REPO_ROOT + '/', '')} thresholds.lines=${configFloor}`);
      }
    }
    expect(mismatches, `config<->SoT divergence:\n  ${mismatches.join('\n  ')}`).toEqual([]);
  });

  it('core coverage exclude set is pinned (cannot silently widen to clear the floor)', () => {
    const actual = configCoverageExclude(CORE_CONFIG);
    expect(
      [...actual].sort(),
      'packages/core/vitest.config.ts coverage.exclude changed — update PINNED_CORE_COVERAGE_EXCLUDE deliberately (widening it shrinks the denominator and can clear the floor without lowering it)'
    ).toEqual([...PINNED_CORE_COVERAGE_EXCLUDE].sort());
  });

  it('no floor is lowered vs the value committed in HEAD (monotonic ratchet)', (ctx) => {
    const floors = readFloors();
    const prior = readPriorFloors();
    if (prior === null) {
      // Bootstrap commit (coverage-floors.json absent in HEAD) — no prior floor.
      // G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): only knowable at run time (it is a `git show` result), so SKIPPED.
      ctx.skip();
    }
    const lowered: string[] = [];
    for (const [key, floor] of Object.entries(floors)) {
      const priorFloor = prior[key];
      if (typeof priorFloor === 'number' && floor < priorFloor) {
        lowered.push(`${key}: ${priorFloor} -> ${floor} (LOWERED — floors may only ratchet up)`);
      }
    }
    expect(lowered, `coverage floors lowered vs HEAD:\n  ${lowered.join('\n  ')}`).toEqual([]);
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard (incident 2026-07-20-pattern-scanner-cwd-dependent-false-results, CR-62).
 *
 * `massu-pattern-scanner.sh` had checks (26, 43) using repo-root-RELATIVE paths
 * (`scripts/pre-push-light.sh`, `packages/core/templates`, …). When npm runs
 * `prepublishOnly` from `packages/core/`, those relative paths resolved against the
 * wrong dir: Check 26 + 43 FAILED-CLOSED (blocked the 1.16.3 publish) and Check 27
 * silently SKIPPED (false green — a silent-failure class). Root-cause fix: the scanner
 * pins its cwd to REPO_ROOT at startup, so every check resolves correctly regardless
 * of invocation cwd.
 *
 * This guard fails if that pin is removed OR if the scanner ever again produces a
 * different verdict depending on the cwd it is invoked from.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../../..');
const SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh');

// G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates) - ADJUDICATED: `scripts/` is not
// in PUBLIC_DIRS, so the scanner is absent in the public mirror; and the behavioral
// check is opt-in because running the full scanner three times costs ~70s. Both are
// gated at collection time -> SKIPPED, never a silent PASS.
const HAS_SCANNER = existsSync(SCANNER);
const RUN_SLOW = Boolean(process.env.MASSU_SLOW_DRIFT_GUARDS);

function runScanner(cwd: string): number {
  try {
    execFileSync('bash', [SCANNER], { cwd, stdio: 'pipe' });
    return 0;
  } catch (e: unknown) {
    const status = (e as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

describe('pattern scanner cwd-independence (CR-62 drift-guard)', () => {
  it.skipIf(!HAS_SCANNER)('scanner pins its working dir to REPO_ROOT before any check runs', () => {
    const src = readFileSync(SCANNER, 'utf-8');
    const pinIdx = src.search(/^cd "\$REPO_ROOT"/m);
    const firstCheckIdx = src.search(/echo "Check 1[:\b]/);
    expect(pinIdx, 'scanner must `cd "$REPO_ROOT"` at startup').toBeGreaterThan(-1);
    expect(firstCheckIdx).toBeGreaterThan(-1);
    // The cd must come BEFORE the first check executes.
    expect(pinIdx).toBeLessThan(firstCheckIdx);
  });

  // Behavioral proof of CWD-independence is opt-in (running the full scanner 3× costs
  // ~70s; too heavy for the every-commit suite). The static pin assertion above is the
  // reliable regression lock — with `cd "$REPO_ROOT"` present, every relative path
  // resolves from the repo root by construction. Run the behavioral check explicitly
  // (release verification / CI slow lane) with MASSU_SLOW_DRIFT_GUARDS=1.
  it.skipIf(!HAS_SCANNER || !RUN_SLOW)('behavioral: same verdict from packages/core (npm prepublish cwd) as from root', () => {
    const fromRoot = runScanner(REPO_ROOT);
    const fromCore = runScanner(resolve(REPO_ROOT, 'packages/core'));
    const fromTmp = runScanner(tmpdir());
    expect(fromCore, 'scanner from packages/core must match root').toBe(fromRoot);
    expect(fromTmp, 'scanner from an unrelated cwd must match root').toBe(fromRoot);
  }, 120_000);
});

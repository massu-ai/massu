// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CR-62 DRIFT-GUARD — a RED claim-ledger (Check 41) must not be committable.
 *
 * A CR-63 detector false-negative once let a RED claim-ledger (Check 41) get
 * committed and PUSHED to main: the detector matched the "only" inside a
 * "host-only" compound (a nearby code-noun within 80 chars), and Check 41 lived
 * ONLY at pre-push [21/22] — bypassable (MASSU_SKIP_* / a path that skips
 * pre-push-light), and nowhere in `npm test`.
 *
 * This guard shells the REAL gate script — the same `scripts/massu-claim-ledger.mjs`
 * that runs at pre-push — and asserts it exits 0. `npm test` is executed by the
 * pre-commit gate, so a RED claim-ledger now blocks the COMMIT, not just the push.
 * It attacks the real gate (CR-72), not a reimplementation that could drift.
 *
 * Regression origin: a 2026-07-21 claim-ledger gate incident.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const GATE = resolve(REPO_ROOT, 'scripts/massu-claim-ledger.mjs');

// Meaningful only in the internal repo — public/consumer installs have no
// docs/plans and no gate script; there is nothing to enforce there.
const IS_INTERNAL = existsSync(resolve(REPO_ROOT, 'docs/plans')) && existsSync(GATE);

describe.runIf(IS_INTERNAL)('CR-62 — claim-ledger gate is green at commit time', () => {
  it('scripts/massu-claim-ledger.mjs exits 0 (no non-grandfathered plan has an uncovered claim)', () => {
    const r = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: 'utf-8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    // Anti-vacuity (M1): a broken gate that scans zero plans must not read as green.
    const scanned = out.match(/Plans scanned:\s*(\d+)/);
    expect(scanned, `gate reported no scan count — cannot trust the result:\n${out}`).not.toBeNull();
    expect(Number(scanned![1]), `gate scanned zero plans (vacuous pass):\n${out}`).toBeGreaterThan(0);

    // The gate itself: RED here means a plan carries an uncovered universal/capability
    // claim. Precisify the incidental quantifier or add a `## CLAIM LEDGER` row with an
    // executed command + pasted output — never inflate the shrink-only baseline.
    expect(r.status, `claim-ledger gate is RED — fix the plan, do not skip:\n${out}`).toBe(0);
  });
});

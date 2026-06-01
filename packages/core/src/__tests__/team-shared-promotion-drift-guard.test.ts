// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-007 (plan-2026-05-28-team-shared-rule-promotion / CR-55): structural
 * drift-guard for team-shared rule promotion. Makes the approval-before-apply
 * invariant + the H1 destination allowlist non-regressable.
 *
 * Companion bash mirror: `scripts/massu-pattern-scanner.sh` Check 32 (vitest <->
 * scanner parity, the CR-50 convention). The parity sub-assertion (vi) asserts
 * the scanner carries an equivalent Check 32.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TEAM_SHAREABLE_DESTINATIONS,
} from '../rule-candidate-applier.ts';
import { TEAM_SHARED_PROMOTION_MIN_TIER } from '../auto-learning-entitlement.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_SRC = resolve(REPO_ROOT, 'packages/core/src/auto-learning-entitlement.ts');
const APPLIER_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-candidate-applier.ts');
const SYNC_SRC = resolve(REPO_ROOT, 'packages/core/src/team-rule-sync.ts');
const PATTERN_SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh');

const FORBIDDEN_APPLY_SYMBOLS = [
  'applyRuleCandidate',
  'writeDestination',
  'appendMemoryIndexLine',
  'writeCorrectionsMd',
  'writePatternScanner',
  'writeClaudeMdCr',
  'writeCustomDestination',
];

describe('team-shared-promotion drift-guard (PB-007 / CR-55)', () => {
  // (i)
  it('TEAM_SHARED_PROMOTION_MIN_TIER is pinned to "team"', () => {
    expect(TEAM_SHARED_PROMOTION_MIN_TIER).toBe('team');
    const src = readFileSync(ENTITLEMENT_SRC, 'utf-8');
    expect(src).toMatch(/TEAM_SHARED_PROMOTION_MIN_TIER[^=]*=[^']*'team'/);
  });

  // (v) — runtime allowlist is EXACTLY the two non-executing destinations.
  it('TEAM_SHAREABLE_DESTINATIONS deep-equals [corrections-md, claude-md-cr]', () => {
    expect([...TEAM_SHAREABLE_DESTINATIONS]).toEqual(['corrections-md', 'claude-md-cr']);
    // pattern-scanner (bash) + custom-destination (file write) must NOT be shareable.
    expect(TEAM_SHAREABLE_DESTINATIONS).not.toContain('pattern-scanner');
    expect(TEAM_SHAREABLE_DESTINATIONS).not.toContain('custom-destination');
  });

  // (ii) + (iii) — the applier carries the publish branch + team-origin gate.
  it('applier references the team publish + apply-gate symbols', () => {
    const src = readFileSync(APPLIER_SRC, 'utf-8');
    expect(src).toContain('entitledForTeamSharedPromotion'); // publish + gate
    expect(src).toContain('teamSharedPromotionUpgradeMessage'); // tier-refused message
    expect(src).toContain('signature_verified'); // team-origin gate
    expect(src).toContain('provenance'); // team-origin gate keys on provenance
    expect(src).toContain('isTeamShareableDestination'); // H1 at publish + apply
  });

  // (iv) — approval-before-apply: the pull module never references an apply/write fn.
  it('team-rule-sync.ts references NO apply/destination-write function (code or comment)', () => {
    const src = readFileSync(SYNC_SRC, 'utf-8');
    for (const sym of FORBIDDEN_APPLY_SYMBOLS) {
      expect(src, `team-rule-sync.ts must not reference ${sym}`).not.toContain(sym);
    }
    // It DOES legitimately use the H1 predicate (pull-side enforcement).
    expect(src).toContain('isTeamShareableDestination');
    expect(src).toContain('verifyPromotionEnvelope');
  });

  // (vi) — vitest <-> scanner parity: the bash mirror carries an equivalent Check 32.
  it('pattern-scanner Check 32 mirrors these invariants (parity)', () => {
    const scanner = readFileSync(PATTERN_SCANNER, 'utf-8');
    expect(scanner).toContain('Check 32');
    expect(scanner).toContain('TEAM_SHARED_PROMOTION_MIN_TIER');
    expect(scanner).toContain('TEAM_SHAREABLE_DESTINATIONS');
    // The scanner enforces the same forbidden-symbol set on the pull module.
    for (const sym of FORBIDDEN_APPLY_SYMBOLS) {
      expect(scanner, `Check 32 must guard against ${sym}`).toContain(sym);
    }
  });
});

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
import { TEAM_SHAREABLE_DESTINATIONS } from '../rule-candidate-applier.ts';
import { TEAM_HARDENED_SHAREABLE_DESTINATIONS } from '../rule-candidate-hardened.ts';
import { TEAM_SHARED_PROMOTION_MIN_TIER } from '../auto-learning-entitlement.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_SRC = resolve(REPO_ROOT, 'packages/core/src/auto-learning-entitlement.ts');
const APPLIER_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-candidate-applier.ts');
const HARDENED_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-candidate-hardened.ts');
const SYNC_SRC = resolve(REPO_ROOT, 'packages/core/src/team-rule-sync.ts');
const PREVIEW_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-candidate-preview.ts');
const SERVER_SYNC_SRC = resolve(REPO_ROOT, 'website/supabase/functions/sync/index.ts');
const SERVER_PROMOTED_SRC = resolve(REPO_ROOT, 'website/supabase/functions/promoted-rules/index.ts');
const MIGRATION_045 = resolve(REPO_ROOT, 'website/supabase/migrations/045_hardened_promotion.sql');
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

  // ====================================================================
  // Phase 3 Stream A (PA3-006 / CR-57): hardened-path drift-guards.
  // ====================================================================
  describe('hardened path (PA3-006 / CR-57)', () => {
    // The hardened allowlist is EXACTLY the two executable destinations...
    it('TEAM_HARDENED_SHAREABLE_DESTINATIONS deep-equals [pattern-scanner, custom-destination]', () => {
      expect([...TEAM_HARDENED_SHAREABLE_DESTINATIONS]).toEqual([
        'pattern-scanner',
        'custom-destination',
      ]);
    });

    // ...and the non-hardened set is UNCHANGED (the Phase-2 guarantee holds).
    it('the non-hardened TEAM_SHAREABLE_DESTINATIONS is UNCHANGED (still exactly the 2 non-executing)', () => {
      expect([...TEAM_SHAREABLE_DESTINATIONS]).toEqual(['corrections-md', 'claude-md-cr']);
      // The two allowlists are disjoint — a destination is never both.
      for (const d of TEAM_HARDENED_SHAREABLE_DESTINATIONS) {
        expect(TEAM_SHAREABLE_DESTINATIONS).not.toContain(d);
      }
    });

    // The hardened apply-gate validator (in rule-candidate-hardened.ts) references
    // the attestation + two-operator + ack symbols...
    it('rule-candidate-hardened.ts carries the apply-gate validator + attestation symbols', () => {
      const src = readFileSync(HARDENED_SRC, 'utf-8');
      expect(src).toContain('TEAM_HARDENED_SHAREABLE_DESTINATIONS');
      expect(src).toContain('isHardenedShareableDestination');
      expect(src).toContain('validateHardenedApplyGate');
      expect(src).toContain('review_attestation');
      expect(src).toContain('second_operator_id');
      expect(src).toContain('dry_run_ack');
    });

    // ...and the applier actually WIRES it into the apply path.
    it('applier wires the hardened gate (isHardenedShareableDestination + validateHardenedApplyGate)', () => {
      const src = readFileSync(APPLIER_SRC, 'utf-8');
      expect(src).toContain('isHardenedShareableDestination');
      expect(src).toContain('validateHardenedApplyGate');
      expect(src).toContain('reviewAttestation'); // publish-side opt
    });

    // RENDER-ONLY invariant: the preview helper NEVER execs untrusted input. Match
    // actual import/require/call syntax (the doc comment legitimately mentions the
    // word "child_process" when explaining the invariant).
    it('rule-candidate-preview.ts imports/uses NO child_process (render-only invariant)', () => {
      const src = readFileSync(PREVIEW_SRC, 'utf-8');
      expect(src).not.toMatch(/from ['"](node:)?child_process['"]/);
      expect(src).not.toMatch(/require\(['"](node:)?child_process/);
      expect(src).not.toMatch(/\bexecSync\(/);
      expect(src).not.toMatch(/\bspawn(Sync)?\(/);
    });

    // Cross-system: client hardened allowlist ⇔ server const ⇔ migration CHECK.
    it('server TEAM_HARDENED_DESTINATIONS + migration 045 CHECK mirror the client hardened allowlist', () => {
      const serverSrc = readFileSync(SERVER_SYNC_SRC, 'utf-8');
      expect(serverSrc).toContain('TEAM_HARDENED_DESTINATIONS');
      for (const d of TEAM_HARDENED_SHAREABLE_DESTINATIONS) {
        expect(serverSrc, `server must list ${d}`).toContain(`'${d}'`);
      }
      const mig = readFileSync(MIGRATION_045, 'utf-8');
      expect(mig).toContain('promoted_rules_destination_hardened_check');
      for (const d of TEAM_HARDENED_SHAREABLE_DESTINATIONS) {
        expect(mig, `migration CHECK must reference ${d}`).toContain(`'${d}'`);
      }
      // The CHECK conditions the executable destinations on hardened + attestation.
      expect(mig).toMatch(/hardened\s*=\s*true/);
      expect(mig).toMatch(/review_attestation IS NOT NULL/);
    });

    // Signed-envelope forgery-hole guard: hardened + review_attestation ride INSIDE
    // each promotion (so they enter the signed promotions_json STRING), NOT as new
    // top-level signed keys (which the sorted-key array replacer would strip).
    it('/promoted-rules carries hardened + review_attestation inside each promotion (not top-level)', () => {
      const src = readFileSync(SERVER_PROMOTED_SRC, 'utf-8');
      // The per-promotion .map projects hardened + review_attestation...
      const mapIdx = src.indexOf('.map((r) => ({');
      const signIdx = src.indexOf('promotions_json: JSON.stringify(promotions)');
      expect(mapIdx).toBeGreaterThan(-1);
      expect(signIdx).toBeGreaterThan(mapIdx);
      const mapBlock = src.slice(mapIdx, signIdx);
      expect(mapBlock).toContain('hardened:');
      expect(mapBlock).toContain('review_attestation:');
    });

    // Scanner parity for the hardened invariants.
    it('pattern-scanner Check 32 mirrors the hardened-path invariants (parity)', () => {
      const scanner = readFileSync(PATTERN_SCANNER, 'utf-8');
      expect(scanner).toContain('TEAM_HARDENED_SHAREABLE_DESTINATIONS');
      expect(scanner).toContain('rule-candidate-preview.ts');
      expect(scanner).toContain('TEAM_HARDENED_DESTINATIONS');
      expect(scanner).toContain('promoted_rules_destination_hardened_check');
    });
  });
});

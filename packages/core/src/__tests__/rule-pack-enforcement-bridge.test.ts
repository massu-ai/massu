// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2-004 (plan-2026-06-01-curated-rule-packs / rule-pack-client-sync lineage):
 * structural drift-guard for the RULE-PACK ENFORCEMENT BRIDGE — the contract that
 * binds an authored pack rule to a known enforcement `destination`, the no-inert
 * invariant, the executable-destination hardened flag, and the
 * materialize-never-apply rule of the client PULL module (`rule-pack-sync.ts`).
 *
 * Companion bash mirror: `scripts/massu-pattern-scanner.sh` Check 36 (vitest <->
 * scanner parity, the CR-50 convention — mirrors how Check 32 / the team-shared
 * drift-guard pair). The final assertion asserts the scanner carries an
 * equivalent Check 36 scanning `rule-pack-sync.ts` for the SAME forbidden
 * applier-write symbols, so the two enforcement layers cannot drift apart.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RULE_DESTINATIONS,
  validateRulePackRule,
  isExecutableDestination,
  type RulePackRule,
} from '../rule-pack-schema.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SYNC_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-pack-sync.ts');
const SCHEMA_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-pack-schema.ts');
const EDGE_FN_SRC = resolve(
  REPO_ROOT,
  'website/supabase/functions/installed-rules/index.ts',
);
const PATTERN_SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh');

/**
 * The seven applier promotion-apply / destination-write identifiers the PULL
 * path must NEVER reference (materialize-never-apply). Identical set to the
 * team-shared drift-guard's FORBIDDEN_APPLY_SYMBOLS and scanner Check 32/36.
 */
const FORBIDDEN_APPLY_SYMBOLS = [
  'applyRuleCandidate',
  'writeDestination',
  'appendMemoryIndexLine',
  'writeCorrectionsMd',
  'writePatternScanner',
  'writeClaudeMdCr',
  'writeCustomDestination',
];

/**
 * The edge fn (`installed-rules/index.ts`) lives under `website/`, which does
 * NOT sync to the public mirror. The shape-parity assertion reads it, so it
 * MUST skip in the public-mirror CI run (precedent: the public-mirror leak bug
 * class — see ci-prepush-parity / team-shared-promotion drift-guards).
 */
const HAS_EDGE_FN = existsSync(EDGE_FN_SRC);

/** A minimally-valid pack rule body for a given destination. */
function validBodyFor(destination: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: 'No console.log in production',
    description: 'Disallow console.log statements in shipped source code.',
    severity: 'medium',
    rule_type: 'pattern',
    destination,
  };
  if (destination === 'pattern-scanner' || destination === 'custom-destination') {
    base.pattern = 'console\\.log\\(';
  }
  return base;
}

describe('rule-pack enforcement bridge drift-guard (P2-004)', () => {
  // ------------------------------------------------------------------
  // (1) Every known destination is accepted; an unknown one is rejected.
  // ------------------------------------------------------------------
  describe('destination mapping', () => {
    it('every RULE_DESTINATIONS member is accepted with a valid body', () => {
      // Sanity: the SoT set is non-empty (a regression to [] would vacuously pass).
      expect(RULE_DESTINATIONS.length).toBeGreaterThan(0);
      for (const destination of RULE_DESTINATIONS) {
        const res = validateRulePackRule(validBodyFor(destination));
        expect(res.valid, `${destination} should validate: ${res.errors.join('; ')}`).toBe(true);
        expect(res.errors).toEqual([]);
      }
    });

    it('an unknown destination string is rejected', () => {
      const res = validateRulePackRule({
        title: 'Bogus',
        description: 'A rule with a destination that is not a known RuleDestination.',
        severity: 'high',
        destination: 'totally-unknown-destination',
        pattern: 'foo',
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => /invalid destination/i.test(e))).toBe(true);
    });

    it('a missing destination is rejected', () => {
      const res = validateRulePackRule({
        title: 'No destination',
        description: 'A rule that declares no enforcement destination at all.',
        severity: 'low',
      });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => /invalid destination/i.test(e))).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // (2) No inert rule — a valid destination with no enforcement body is rejected.
  // ------------------------------------------------------------------
  describe('no inert rule', () => {
    it('pattern-scanner with neither pattern nor check is rejected as inert', () => {
      const body = validBodyFor('pattern-scanner');
      delete body.pattern;
      delete body.check;
      const res = validateRulePackRule(body);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => /inert rule/i.test(e))).toBe(true);
    });

    it('custom-destination with neither pattern nor check is rejected as inert', () => {
      const body = validBodyFor('custom-destination');
      delete body.pattern;
      delete body.check;
      const res = validateRulePackRule(body);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => /inert rule/i.test(e))).toBe(true);
    });

    it('a text destination with an empty description is rejected as inert', () => {
      const res = validateRulePackRule({
        title: 'Empty body',
        description: '   ',
        severity: 'low',
        destination: 'corrections-md',
      });
      expect(res.valid).toBe(false);
      // Empty description trips BOTH the required-field check and the inert check;
      // either way the rule is invalid (no enforcement body).
      expect(res.errors.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------
  // (3) Executable destinations ride the hardened path (requiresHardened).
  // ------------------------------------------------------------------
  describe('executable destinations require hardened path', () => {
    it('pattern-scanner + custom-destination are flagged requiresHardened', () => {
      for (const destination of ['pattern-scanner', 'custom-destination']) {
        expect(isExecutableDestination(destination)).toBe(true);
        const res = validateRulePackRule(validBodyFor(destination));
        expect(res.valid).toBe(true);
        expect(
          res.requiresHardened,
          `${destination} must be flagged requiresHardened (never auto-enforced)`,
        ).toBe(true);
      }
    });

    it('non-executable (text) destinations are NOT flagged requiresHardened', () => {
      for (const destination of ['corrections-md', 'claude-md-cr']) {
        expect(isExecutableDestination(destination)).toBe(false);
        const res = validateRulePackRule(validBodyFor(destination));
        expect(res.valid).toBe(true);
        expect(res.requiresHardened).toBe(false);
      }
    });
  });

  // ------------------------------------------------------------------
  // (4) Client <-> server pack-rule shape parity. The keys `rule-pack-sync.ts`
  //     consumes, the keys the schema validates, and the keys the edge fn
  //     passes through MUST be a consistent set — pin the shared keys.
  // ------------------------------------------------------------------
  describe('client <-> server pack-rule shape parity', () => {
    // The canonical shared key set of an authored pack rule (RulePackRule).
    const SHARED_RULE_KEYS = [
      'title',
      'description',
      'rule_type',
      'severity',
      'destination',
      'pattern',
      'check',
    ];

    it('schema (rule-pack-schema.ts) declares every shared key on RulePackRule', () => {
      // Compile-time: RulePackRule must structurally admit all shared keys.
      const probe: RulePackRule = {
        title: 't',
        description: 'd',
        destination: 'pattern-scanner',
        severity: 'high',
        rule_type: 'pattern',
        pattern: 'p',
        check: 'c',
      };
      for (const k of SHARED_RULE_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(probe, k)).toBe(true);
      }
      // Runtime: the schema source names each shared key (interface field).
      const schemaSrc = readFileSync(SCHEMA_SRC, 'utf-8');
      for (const k of SHARED_RULE_KEYS) {
        expect(schemaSrc, `rule-pack-schema.ts must reference field "${k}"`).toContain(k);
      }
    });

    it('rule-pack-sync.ts consumes the same rule-shape keys (title/description/destination/pattern/check)', () => {
      const syncSrc = readFileSync(SYNC_SRC, 'utf-8');
      // The materializer reads exactly these load-bearing rule fields. (severity
      // is validated inside validateRulePackRule, not re-read by the materializer.)
      for (const k of ['title', 'description', 'destination', 'pattern', 'check']) {
        expect(syncSrc, `rule-pack-sync.ts must read rule.${k}`).toContain(`rule.${k}`);
      }
    });

    it.skipIf(!HAS_EDGE_FN)(
      'edge fn (installed-rules) passes pack rules through with the destination bridge field',
      () => {
        const edgeSrc = readFileSync(EDGE_FN_SRC, 'utf-8');
        // The edge fn projects `rules` verbatim and documents the `destination`
        // bridge field travels on each rule (migration 048 reseed).
        expect(edgeSrc).toContain('destination');
        expect(edgeSrc).toMatch(/rules/);
        // It enforces the SAME Team-gate posture the client tier-gates on.
        expect(edgeSrc).toContain('cloud_team');
      },
    );
  });

  // ------------------------------------------------------------------
  // (5) No-apply invariant — the PULL module references none of the 7
  //     forbidden applier-write symbols (vitest mirror of scanner Check 36).
  // ------------------------------------------------------------------
  describe('materialize-never-apply invariant', () => {
    it('rule-pack-sync.ts references NO apply/destination-write function (code or comment)', () => {
      const syncSrc = readFileSync(SYNC_SRC, 'utf-8');
      for (const sym of FORBIDDEN_APPLY_SYMBOLS) {
        expect(syncSrc, `rule-pack-sync.ts must not reference ${sym}`).not.toContain(sym);
      }
      // It DOES legitimately use the schema validators + the verifier (pull side).
      expect(syncSrc).toContain('validateRulePackRule');
      expect(syncSrc).toContain('isExecutableDestination');
      expect(syncSrc).toContain('verifyPromotionEnvelope');
    });
  });

  // ------------------------------------------------------------------
  // (6) vitest <-> scanner parity: the bash mirror carries an equivalent
  //     Check 36 scanning rule-pack-sync.ts for the forbidden symbols.
  // ------------------------------------------------------------------
  describe('vitest <-> scanner parity (Check 36)', () => {
    it('pattern-scanner Check 36 mirrors the no-apply invariant on rule-pack-sync.ts', () => {
      const scanner = readFileSync(PATTERN_SCANNER, 'utf-8');
      expect(scanner).toContain('Check 36');
      expect(scanner).toContain('rule-pack-sync.ts');
      for (const sym of FORBIDDEN_APPLY_SYMBOLS) {
        expect(scanner, `Check 36 must guard against ${sym}`).toContain(sym);
      }
    });
  });
});

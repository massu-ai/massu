// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-002 (plan-2026-06-01-curated-rule-packs): unit tests for the pack-rule
 * schema validator.
 *
 * Covers: every RuleDestination member is accepted; an unknown destination is
 * rejected; an executable destination is flagged `requiresHardened:true`; a
 * non-executable destination is NOT flagged; an inert rule (valid destination,
 * no enforcement body) is rejected; missing severity/title is rejected; and the
 * `validateRulePack` aggregate.
 */

import { describe, it, expect } from 'vitest';
import {
  validateRulePackRule,
  validateRulePack,
  isRuleDestination,
  isExecutableDestination,
  RULE_DESTINATIONS,
} from '../rule-pack-schema.ts';

/** A valid rule for a given destination, with the appropriate enforcement body. */
function validRuleFor(destination: string): Record<string, unknown> {
  const base = {
    title: 'No raw fetch in components',
    description: 'Components must call the typed API client, never raw fetch.',
    severity: 'high',
    rule_type: 'pattern',
  };
  if (destination === 'pattern-scanner' || destination === 'custom-destination') {
    return { ...base, destination, pattern: 'fetch\\(' };
  }
  // corrections-md / claude-md-cr — text body (description) is the enforcement body.
  return { ...base, destination };
}

describe('validateRulePackRule', () => {
  it('accepts every RuleDestination member', () => {
    for (const destination of RULE_DESTINATIONS) {
      const result = validateRulePackRule(validRuleFor(destination));
      expect(result.valid, `${destination} should be valid: ${result.errors.join(', ')}`).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it('rejects an unknown destination string', () => {
    const result = validateRulePackRule({
      ...validRuleFor('pattern-scanner'),
      destination: 'send-to-slack',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid destination'))).toBe(true);
    expect(result.requiresHardened).toBe(false);
  });

  it('flags executable destinations (pattern-scanner, custom-destination) requiresHardened:true', () => {
    for (const destination of ['pattern-scanner', 'custom-destination']) {
      const result = validateRulePackRule(validRuleFor(destination));
      expect(result.valid).toBe(true);
      // DECISION (P1-002): executable destinations are FLAGGED, not rejected —
      // they ride the hardened path rather than auto-enforcing.
      expect(result.requiresHardened, `${destination} must be flagged hardened`).toBe(true);
    }
  });

  it('does NOT flag non-executable destinations (corrections-md, claude-md-cr)', () => {
    for (const destination of ['corrections-md', 'claude-md-cr']) {
      const result = validateRulePackRule(validRuleFor(destination));
      expect(result.valid).toBe(true);
      expect(result.requiresHardened, `${destination} must NOT be flagged hardened`).toBe(false);
    }
  });

  it('rejects an inert rule (valid destination but no enforcement body)', () => {
    // pattern-scanner with neither pattern nor check → inert.
    const inertScanner = {
      title: 'Inert scanner rule',
      description: '', // also empty text body
      severity: 'medium',
      destination: 'pattern-scanner',
    };
    const r1 = validateRulePackRule(inertScanner);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes('inert rule'))).toBe(true);

    // corrections-md with empty description → inert.
    const inertCorrection = {
      title: 'Inert correction',
      description: '',
      severity: 'medium',
      destination: 'corrections-md',
    };
    const r2 = validateRulePackRule(inertCorrection);
    expect(r2.valid).toBe(false);
    // empty description triggers both the required-field check AND the inert check.
    expect(r2.errors.some((e) => e.includes('inert rule'))).toBe(true);
  });

  it('rejects a rule missing severity', () => {
    const rule = validRuleFor('corrections-md');
    delete rule.severity;
    const result = validateRulePackRule(rule);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('severity'))).toBe(true);
  });

  it('rejects a rule missing title', () => {
    const rule = validRuleFor('corrections-md');
    delete rule.title;
    const result = validateRulePackRule(rule);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('title'))).toBe(true);
  });

  it('rejects a non-object rule', () => {
    expect(validateRulePackRule(null).valid).toBe(false);
    expect(validateRulePackRule('a string').valid).toBe(false);
    expect(validateRulePackRule([]).valid).toBe(false);
  });
});

describe('isRuleDestination / isExecutableDestination', () => {
  it('isRuleDestination recognizes all members and rejects unknowns', () => {
    for (const d of RULE_DESTINATIONS) {
      expect(isRuleDestination(d)).toBe(true);
    }
    expect(isRuleDestination('nope')).toBe(false);
    expect(isRuleDestination(42)).toBe(false);
    expect(isRuleDestination(undefined)).toBe(false);
  });

  it('isExecutableDestination flags exactly the hardened destinations', () => {
    expect(isExecutableDestination('pattern-scanner')).toBe(true);
    expect(isExecutableDestination('custom-destination')).toBe(true);
    expect(isExecutableDestination('corrections-md')).toBe(false);
    expect(isExecutableDestination('claude-md-cr')).toBe(false);
  });
});

describe('validateRulePack', () => {
  it('validates a whole pack and returns index-aligned per-rule results', () => {
    const pack = {
      name: 'security-pack',
      rules: [
        validRuleFor('corrections-md'),
        validRuleFor('pattern-scanner'),
      ],
    };
    const result = validateRulePack(pack);
    expect(result.valid).toBe(true);
    expect(result.ruleResults).toHaveLength(2);
    expect(result.ruleResults[0].requiresHardened).toBe(false);
    expect(result.ruleResults[1].requiresHardened).toBe(true);
  });

  it('marks the pack invalid when any rule is invalid, surfacing the index', () => {
    const pack = {
      rules: [validRuleFor('corrections-md'), { destination: 'nope' }],
    };
    const result = validateRulePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('rules[1]'))).toBe(true);
  });

  it('rejects a pack with no rules array', () => {
    expect(validateRulePack({}).valid).toBe(false);
    expect(validateRulePack(null).valid).toBe(false);
  });
});

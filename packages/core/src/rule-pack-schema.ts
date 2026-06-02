// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-002 (plan-2026-06-01-curated-rule-packs): typed validator for a
 * rule-pack `rules[]` item.
 *
 * The existing pack rule shape (seeded in migration 016) is
 * `{title, description, rule_type, severity, pattern, check}`. This validator
 * ADDS the enforcement-bridge contract: each rule MUST declare a target
 * enforcement `destination` (one of the canonical `RuleDestination` members).
 *
 * The `RuleDestination` union is the SINGLE source of truth in
 * `./rule-candidate-applier.ts`; it is imported here (NEVER re-declared) so the
 * pack contract stays in lockstep with the applier's destination set.
 *
 * Pure module: no DB, no process exit, no filesystem, no side effects. Every
 * exported function is a pure function of its input.
 */

import type { RuleDestination } from './rule-candidate-applier.ts';
import { TEAM_HARDENED_SHAREABLE_DESTINATIONS } from './rule-candidate-hardened.ts';

/**
 * The canonical set of enforcement destinations, derived from the imported
 * `RuleDestination` SoT. Used as the runtime membership check (a `type` union
 * is erased at runtime, so we need a concrete array). Adding a member to the
 * `RuleDestination` union without adding it here is a `tsc` error: the
 * `satisfies` clause forces every union member to appear.
 */
export const RULE_DESTINATIONS = [
  'corrections-md',
  'pattern-scanner',
  'claude-md-cr',
  'custom-destination',
] as const satisfies readonly RuleDestination[];

/** Runtime membership test for the `RuleDestination` union. */
export function isRuleDestination(value: unknown): value is RuleDestination {
  return typeof value === 'string' && (RULE_DESTINATIONS as readonly string[]).includes(value);
}

/**
 * Is `destination` an EXECUTABLE destination — i.e. one of the hardened
 * (arbitrary bash / arbitrary file-write) classes? Such a rule must ride the
 * hardened cross-seat path and is NEVER auto-enforced.
 */
export function isExecutableDestination(destination: string): boolean {
  return (TEAM_HARDENED_SHAREABLE_DESTINATIONS as readonly string[]).includes(destination);
}

/**
 * A rule-pack rule as authored in a pack manifest, post-validation. Extends the
 * migration-016 shape with the mandatory enforcement `destination`. Optional
 * fields are absent when not applicable to the destination (e.g. a
 * `corrections-md` rule carries no scanner `pattern`).
 */
export interface RulePackRule {
  title: string;
  description: string;
  destination: RuleDestination;
  severity: string;
  rule_type?: string;
  /** Scanner regex/grep body — REQUIRED when destination is `pattern-scanner`. */
  pattern?: string;
  /** Shell check command — an alternative deterministic enforcement body. */
  check?: string;
}

/** A whole rule-pack: a named collection of `rules[]`. */
export interface RulePack {
  rules: unknown[];
  [key: string]: unknown;
}

/** Result of validating a single pack rule. */
export interface RulePackRuleValidationResult {
  valid: boolean;
  errors: string[];
  /**
   * True when the rule targets an EXECUTABLE destination
   * (`pattern-scanner` / `custom-destination`).
   *
   * DECISION (P1-002, curated-only plan): we FLAG `requiresHardened:true`
   * rather than REJECT executable destinations outright. Flagging is the more
   * robust, enterprise-grade handling — the rule is structurally valid, it
   * simply MUST be routed through the hardened cross-seat path (render-only
   * preview + two-operator review + per-org opt-in) instead of being
   * auto-enforced. Rejecting would discard otherwise-correct rules; flagging
   * preserves them while making the required handling explicit to the caller.
   */
  requiresHardened: boolean;
}

/** Result of validating a whole pack. */
export interface RulePackValidationResult {
  valid: boolean;
  errors: string[];
  /** Per-rule results, index-aligned with `pack.rules`. */
  ruleResults: RulePackRuleValidationResult[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a single rule-pack `rules[]` item.
 *
 * Validation contract:
 *  (a) `destination` MUST be a member of `RuleDestination` — unknown → invalid.
 *  (b) the rule MUST NOT be INERT: it needs a deterministic enforcement body.
 *      - for `pattern-scanner`: a non-empty `pattern` is required (the scanner
 *        regex/grep). A `check` command is also accepted.
 *      - for `corrections-md` / `claude-md-cr`: a non-empty text body
 *        (`description`) is required (the correction / CR text).
 *      - for `custom-destination`: a `pattern` or `check` body is required.
 *  (c) `severity` is required.
 *  (d) `title` + `description` are required.
 */
export function validateRulePackRule(rule: unknown): RulePackRuleValidationResult {
  const errors: string[] = [];

  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return { valid: false, errors: ['rule must be a non-null object'], requiresHardened: false };
  }

  const r = rule as Record<string, unknown>;

  // (d) title + description
  if (!isNonEmptyString(r.title)) {
    errors.push('missing required field: title');
  }
  if (!isNonEmptyString(r.description)) {
    errors.push('missing required field: description');
  }

  // (c) severity
  if (!isNonEmptyString(r.severity)) {
    errors.push('missing required field: severity');
  }

  // (a) destination must be a known RuleDestination member
  const destinationKnown = isRuleDestination(r.destination);
  if (!destinationKnown) {
    errors.push(
      `invalid destination: ${JSON.stringify(r.destination)} is not a known RuleDestination (one of ${RULE_DESTINATIONS.join(', ')})`,
    );
  }

  // (b) inert-rule rejection — only meaningful once the destination is known.
  if (destinationKnown) {
    const destination = r.destination as RuleDestination;
    const hasPattern = isNonEmptyString(r.pattern);
    const hasCheck = isNonEmptyString(r.check);
    const hasTextBody = isNonEmptyString(r.description);

    switch (destination) {
      case 'pattern-scanner':
        if (!hasPattern && !hasCheck) {
          errors.push(
            'inert rule: pattern-scanner destination requires a non-empty `pattern` (or a `check` command)',
          );
        }
        break;
      case 'custom-destination':
        if (!hasPattern && !hasCheck) {
          errors.push(
            'inert rule: custom-destination requires a deterministic enforcement body (`pattern` or `check`)',
          );
        }
        break;
      case 'corrections-md':
      case 'claude-md-cr':
        if (!hasTextBody && !hasPattern && !hasCheck) {
          errors.push(
            `inert rule: ${destination} requires a non-empty text body (description)`,
          );
        }
        break;
    }
  }

  // requiresHardened reflects the EXECUTABLE-destination flag. Computed only
  // for a known destination; an unknown destination is never "hardened".
  const requiresHardened = destinationKnown && isExecutableDestination(r.destination as string);

  return { valid: errors.length === 0, errors, requiresHardened };
}

/**
 * Validate a whole rule-pack. The pack is valid iff it carries a `rules` array
 * and every rule in it is valid. Per-rule results are returned index-aligned so
 * callers can surface the `requiresHardened` flag per rule.
 */
export function validateRulePack(pack: unknown): RulePackValidationResult {
  if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) {
    return { valid: false, errors: ['pack must be a non-null object'], ruleResults: [] };
  }

  const p = pack as Record<string, unknown>;
  if (!Array.isArray(p.rules)) {
    return { valid: false, errors: ['pack must have a `rules` array'], ruleResults: [] };
  }

  const ruleResults = p.rules.map((rule) => validateRulePackRule(rule));
  const errors: string[] = [];
  ruleResults.forEach((res, i) => {
    if (!res.valid) {
      errors.push(`rules[${i}]: ${res.errors.join('; ')}`);
    }
  });

  return { valid: errors.length === 0, errors, ruleResults };
}

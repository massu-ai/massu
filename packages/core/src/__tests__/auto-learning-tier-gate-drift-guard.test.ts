// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-008 drift-guard (plan-2026-05-27-tier-gate-auto-learning / CR-54).
 *
 * Structural source/AST guard that the auto-learning Pro gate stays wired:
 *   1. `rule-candidate-applier.ts` references `assertAutoLearningEntitled`
 *      AND `applyRuleCandidate` is declared `async`.
 *   2. `hooks/user-prompt.ts` references both `entitledForAutoLearning`
 *      and `getCachedTierReadOnly`.
 *   3. `auto-learning-entitlement.ts` exports `AUTO_LEARNING_MIN_TIER` and
 *      its value is `'pro'`.
 *   4. Mirror sub-assertion: pattern-scanner Check 30 exists for the same
 *      invariant (vitest <-> scanner parity, the CR-50/CR-52 convention).
 *
 * A silent regression that drops the gate fails this guard.
 *
 * Precedent: `loop-multi-perspective-enforcement.test.ts` (in-package
 * source-grep + scanner-mirror drift-guard).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUTO_LEARNING_MIN_TIER } from '../auto-learning-entitlement.ts';

const SRC_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '../../../..');

// Reads are performed INSIDE each `it()` (not at module top-level) so a file
// that is ever absent in a mirror fails the assertion cleanly rather than
// crashing test collection (pattern-review fix, mirrors the loop-multi-
// perspective precedent).
const readSrc = (rel: string): string => readFileSync(resolve(SRC_DIR, rel), 'utf-8');
const readRepo = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

describe('ALTG auto-learning-tier-gate drift-guard (CR-54)', () => {
  it('ALTG-01: applier references assertAutoLearningEntitled AND applyRuleCandidate is async', () => {
    const APPLIER_SRC = readSrc('rule-candidate-applier.ts');
    expect(
      APPLIER_SRC.includes('assertAutoLearningEntitled'),
      'rule-candidate-applier.ts must reference assertAutoLearningEntitled (the promotion gate)',
    ).toBe(true);
    expect(
      /export\s+async\s+function\s+applyRuleCandidate/.test(APPLIER_SRC),
      'applyRuleCandidate must be declared `async` (entitlement is async-resolved inside it)',
    ).toBe(true);
  });

  it('ALTG-02: emission hook references the gate predicate, the cache reader, AND the message SoT', () => {
    const HOOK_SRC = readSrc('hooks/user-prompt.ts');
    expect(
      HOOK_SRC.includes('entitledForAutoLearning'),
      'hooks/user-prompt.ts must reference entitledForAutoLearning (the emission gate predicate)',
    ).toBe(true);
    expect(
      HOOK_SRC.includes('getCachedTierReadOnly'),
      'hooks/user-prompt.ts must reference getCachedTierReadOnly (the cache-only, no-network tier reader)',
    ).toBe(true);
    // Single-SoT guard (CR-46 #3): the sub-Pro upgrade text MUST come from
    // autoLearningUpgradeMessage(), never be re-hardcoded in the hook.
    expect(
      HOOK_SRC.includes('autoLearningUpgradeMessage'),
      'hooks/user-prompt.ts must derive the upgrade nudge from autoLearningUpgradeMessage() (single SoT)',
    ).toBe(true);
  });

  it('ALTG-03: entitlement SoT exports AUTO_LEARNING_MIN_TIER and its value is "pro"', () => {
    const ENTITLEMENT_SRC = readSrc('auto-learning-entitlement.ts');
    // Runtime value (single source of truth).
    expect(AUTO_LEARNING_MIN_TIER).toBe('pro');
    // Source-level pin so a hand-edit of the constant is caught structurally.
    expect(
      /AUTO_LEARNING_MIN_TIER:\s*ToolTier\s*=\s*'pro'/.test(ENTITLEMENT_SRC),
      "auto-learning-entitlement.ts must pin AUTO_LEARNING_MIN_TIER to 'pro'",
    ).toBe(true);
  });

  it('ALTG-04: pattern-scanner Check 30 mirror exists (vitest <-> scanner parity)', () => {
    const PATTERN_SCANNER = readRepo('scripts/massu-pattern-scanner.sh');
    expect(
      PATTERN_SCANNER.includes('Check 30: Auto-learning tier-gate wiring'),
      'pattern-scanner Check 30 must mirror this drift-guard (CR-50/CR-52 convention)',
    ).toBe(true);
    // The scanner must assert the same invariant tokens (incl. the message SoT).
    expect(PATTERN_SCANNER).toContain('assertAutoLearningEntitled');
    expect(PATTERN_SCANNER).toContain('getCachedTierReadOnly');
    expect(PATTERN_SCANNER).toContain('entitledForAutoLearning');
    expect(PATTERN_SCANNER).toContain('autoLearningUpgradeMessage');
    expect(PATTERN_SCANNER).toMatch(/AUTO_LEARNING_MIN_TIER: ToolTier = 'pro'/);
  });
});

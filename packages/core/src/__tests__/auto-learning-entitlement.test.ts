// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-011 (plan-2026-05-27-tier-gate-auto-learning / CR-54): unit tests for
 * the auto-learning entitlement SoT.
 *
 * Covers: the predicate (free=false; pro/team/enterprise=true), the min-tier
 * constant, the upgrade message (names the feature + pricing URL), and the
 * fail-closed behavior of `assertAutoLearningEntitled` when the tier resolver
 * throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock license.ts so we control getCurrentTier without a live license server.
// tierLevel + the ToolTier type must remain real, so we re-export the genuine
// implementations and only override getCurrentTier.
let mockTier: 'free' | 'pro' | 'team' | 'enterprise' | (() => never) = 'free';

vi.mock('../license.ts', async () => {
  const actual = await vi.importActual<typeof import('../license.ts')>('../license.ts');
  return {
    ...actual,
    getCurrentTier: vi.fn(async () => {
      if (typeof mockTier === 'function') return (mockTier as () => never)();
      return mockTier;
    }),
  };
});

import {
  AUTO_LEARNING_MIN_TIER,
  entitledForAutoLearning,
  autoLearningUpgradeMessage,
  assertAutoLearningEntitled,
} from '../auto-learning-entitlement.ts';

beforeEach(() => {
  mockTier = 'free';
  vi.clearAllMocks();
});

describe('AUTO_LEARNING_MIN_TIER', () => {
  it('is pinned to "pro"', () => {
    expect(AUTO_LEARNING_MIN_TIER).toBe('pro');
  });
});

describe('entitledForAutoLearning()', () => {
  it('free is NOT entitled', () => {
    expect(entitledForAutoLearning('free')).toBe(false);
  });

  it('pro / team / enterprise ARE entitled', () => {
    expect(entitledForAutoLearning('pro')).toBe(true);
    expect(entitledForAutoLearning('team')).toBe(true);
    expect(entitledForAutoLearning('enterprise')).toBe(true);
  });
});

describe('autoLearningUpgradeMessage()', () => {
  it('names the feature and includes the pricing URL', () => {
    const msg = autoLearningUpgradeMessage('free');
    expect(msg).toMatch(/auto-learning/i);
    expect(msg).toContain('Pro');
    expect(msg).toContain('https://massu.ai/pricing');
  });

  it('includes the caller\'s current tier (uppercased)', () => {
    expect(autoLearningUpgradeMessage('free')).toContain('FREE');
    expect(autoLearningUpgradeMessage('team')).toContain('TEAM');
  });
});

describe('assertAutoLearningEntitled()', () => {
  it('returns entitled:true with the resolved tier when tier >= pro', async () => {
    mockTier = 'pro';
    const res = await assertAutoLearningEntitled();
    expect(res.entitled).toBe(true);
    expect(res.currentTier).toBe('pro');
    expect(res.message).toBeUndefined();
  });

  it('returns entitled:false + upgrade message when tier is free', async () => {
    mockTier = 'free';
    const res = await assertAutoLearningEntitled();
    expect(res.entitled).toBe(false);
    expect(res.currentTier).toBe('free');
    expect(res.message).toMatch(/Pro feature/);
    expect(res.message).toContain('https://massu.ai/pricing');
  });

  it('is fail-closed: a throwing resolver yields entitled:false / free', async () => {
    mockTier = () => { throw new Error('resolver blew up'); };
    const res = await assertAutoLearningEntitled();
    expect(res.entitled).toBe(false);
    expect(res.currentTier).toBe('free');
    expect(res.message).toContain('https://massu.ai/pricing');
  });
});

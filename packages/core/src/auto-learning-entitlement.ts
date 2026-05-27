// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Auto-learning entitlement — the SINGLE source of truth for "auto-learning
 * requires Pro" (plan-2026-05-27-tier-gate-auto-learning, CR-54).
 *
 * Auto-learning (rule-candidate detection + `/massu-rule` promotion) is a
 * freemium Pro+ feature. The command and its docs stay public (adoption
 * funnel); candidate emission and rule promotion require a Pro (or higher)
 * license.
 *
 * Every layer that gates auto-learning reads from THIS module — there is no
 * parallel tier scheme. The applier promotion gate, the hook emission gate,
 * the `massu license check` CLI, and the docs all reference the constant
 * + message functions exported here. A drift-guard test + pattern-scanner
 * Check 30 assert the chokepoints reference this SoT.
 *
 * Fail-closed: any error resolving the current tier yields `{ entitled: false }`.
 */

import { type ToolTier, tierLevel, getCurrentTier } from './license.ts';

/**
 * The minimum tier entitled to auto-learning. SINGLE source of truth — every
 * gate reads this constant. Changing it changes the gate everywhere.
 */
export const AUTO_LEARNING_MIN_TIER: ToolTier = 'pro';

/**
 * Pure, synchronous predicate: is `tier` entitled to auto-learning?
 * `true` iff `tier` is at or above {@link AUTO_LEARNING_MIN_TIER}.
 */
export function entitledForAutoLearning(tier: ToolTier): boolean {
  return tierLevel(tier) >= tierLevel(AUTO_LEARNING_MIN_TIER);
}

/**
 * Single generic upgrade message surfaced everywhere auto-learning is
 * refused. Names the feature, the caller's current tier, and the pricing
 * URL. No operator literals, no absolute paths — this string ships publicly.
 */
export function autoLearningUpgradeMessage(currentTier: ToolTier): string {
  return (
    'Auto-learning (rule-candidate detection + /massu-rule promotion) is a Pro feature. ' +
    `Your tier: ${currentTier.toUpperCase()}. Upgrade at https://massu.ai/pricing`
  );
}

/**
 * Result of an entitlement check. `message` is populated only when the
 * caller is NOT entitled (so the refusal can be surfaced verbatim).
 */
export interface AutoLearningEntitlement {
  entitled: boolean;
  currentTier: ToolTier;
  message?: string;
}

/**
 * Resolve auto-learning entitlement for the current session. Calls
 * {@link getCurrentTier} (which is itself fail-closed: no API key → 'free',
 * network failure beyond the 7-day grace window → 'free'). Any throw while
 * resolving the tier is caught and treated as un-entitled `'free'` —
 * default-deny.
 *
 * The entitlement is resolved INSIDE this function rather than passed in by
 * the caller, so a programmatic caller cannot inject a forged tier.
 */
export async function assertAutoLearningEntitled(): Promise<AutoLearningEntitlement> {
  try {
    const currentTier = await getCurrentTier();
    if (entitledForAutoLearning(currentTier)) {
      return { entitled: true, currentTier };
    }
    return {
      entitled: false,
      currentTier,
      message: autoLearningUpgradeMessage(currentTier),
    };
  } catch {
    // Fail-closed: any error resolving the tier → un-entitled free.
    return {
      entitled: false,
      currentTier: 'free',
      message: autoLearningUpgradeMessage('free'),
    };
  }
}

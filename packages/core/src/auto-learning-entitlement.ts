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

// ============================================================================
// Phase 2 (CR-55, plan-2026-05-28-team-shared-rule-promotion): Team-Shared
// Promotion entitlement. The tier ladder is Free=off · Pro=LOCAL auto-learning
// · Team=SHARED auto-learning. Cross-seat propagation of a promoted rule (the
// publish branch in the applier, the pull path in team-rule-sync) requires
// Team (or higher). Pro stays local-only. This reuses the SAME `tierLevel()`
// ladder as auto-learning above — no parallel tier scheme.
// ============================================================================

/**
 * Minimum tier entitled to TEAM-SHARED rule promotion (publish + pull). SINGLE
 * source of truth — the applier publish branch, the applier team-origin apply
 * gate, and the pull path all read this constant. A drift-guard test +
 * pattern-scanner Check 32 assert the chokepoints reference this SoT.
 */
export const TEAM_SHARED_PROMOTION_MIN_TIER: ToolTier = 'team';

/**
 * Pure, synchronous predicate: is `tier` entitled to team-shared promotion?
 * `true` iff `tier` is at or above {@link TEAM_SHARED_PROMOTION_MIN_TIER}
 * (i.e. Team or Enterprise). Free/Pro → `false`.
 */
export function entitledForTeamSharedPromotion(tier: ToolTier): boolean {
  return tierLevel(tier) >= tierLevel(TEAM_SHARED_PROMOTION_MIN_TIER);
}

/**
 * Single generic upgrade message surfaced everywhere team-shared promotion is
 * refused (publish gate, team-origin apply gate). Names the feature, the
 * caller's current tier, and the pricing URL. No operator literals, no
 * absolute paths — this string ships publicly.
 */
export function teamSharedPromotionUpgradeMessage(currentTier: ToolTier): string {
  return (
    'Team-shared rule promotion (your team learns as one — a promoted rule ' +
    'propagates to your org as a reviewable proposal) is a Team feature. ' +
    `Your tier: ${currentTier.toUpperCase()}. Upgrade at https://massu.ai/pricing`
  );
}

// ============================================================================
// Phase A1 (CR-55 generalized, plan-2026-06-01-enterprise-governance-audit-export):
// Enterprise auto-learning GOVERNANCE entitlement. The org-level N-of-M
// promotion policy + signed audit export are an Enterprise-tier feature. This
// REUSES the existing `tierLevel()` ladder + the existing
// `PLAN_TO_TIER_MAP['cloud_enterprise'] = 'enterprise'` resolution (license.ts)
// — there is NO parallel plan→tier mapping. Net-new code is ONLY the constant +
// the predicate, mirroring the AUTO_LEARNING_MIN_TIER / TEAM_SHARED_PROMOTION_
// MIN_TIER precedents above.
// ============================================================================

/**
 * Minimum tier entitled to Enterprise auto-learning governance (org promotion
 * policy + signed audit export). SINGLE source of truth — the dashboard gate,
 * the audit-export edge fn, and any client surface read this constant.
 */
export const ENTERPRISE_GOVERNANCE_MIN_TIER: ToolTier = 'enterprise';

/**
 * Pure, synchronous predicate: is `tier` entitled to Enterprise governance?
 * `true` iff `tier` is at or above {@link ENTERPRISE_GOVERNANCE_MIN_TIER}
 * (i.e. Enterprise). Free/Pro/Team → `false`.
 */
export function entitledForEnterpriseGovernance(tier: ToolTier): boolean {
  return tierLevel(tier) >= tierLevel(ENTERPRISE_GOVERNANCE_MIN_TIER);
}

/**
 * Single generic upgrade message surfaced everywhere Enterprise governance is
 * refused. Names the feature, the caller's current tier, and the pricing URL.
 * No operator literals, no absolute paths — this string ships publicly.
 */
export function enterpriseGovernanceUpgradeMessage(currentTier: ToolTier): string {
  return (
    'Auto-learning governance (org promotion policy with N-of-M approvals + ' +
    'signed audit export) is an Enterprise feature. ' +
    `Your tier: ${currentTier.toUpperCase()}. Upgrade at https://massu.ai/pricing`
  );
}

// ============================================================================
// Slice 5 (plan-living-memory-slice-5-cross-repo-surfacing, A-08): CROSS-REPO
// memory surfacing entitlement. A decision made in one of the operator's repos
// can surface in another on the SAME machine, via a signed local-filesystem
// transport — ZERO network, ZERO LLM, ZERO license. Per the universality LAW
// (`feedback_universal_product_never_one_off`) the local transport MUST work for
// every download, so its floor is FREE. The OPTIONAL cloud/Team transport (Stage
// 5D) reuses TEAM_SHARED_PROMOTION_MIN_TIER above — it does NOT get its own
// constant. This constant lives in the SAME SoT module as the other three tier
// floors — one ladder, one module, a fourth constant, no parallel scheme.
// ============================================================================

/**
 * Minimum tier entitled to CROSS-REPO memory surfacing (the local, zero-network
 * transport). SINGLE source of truth — the cross-repo gate reads THIS constant
 * and no other. FREE by design (the universality LAW). A drift-guard test +
 * pattern-scanner assert the chokepoint references this SoT.
 */
export const CROSS_REPO_SURFACING_MIN_TIER: ToolTier = 'free';

/**
 * Pure, synchronous predicate: is `tier` entitled to cross-repo surfacing?
 * `true` iff `tier` is at or above {@link CROSS_REPO_SURFACING_MIN_TIER} — i.e.
 * ALWAYS, since the floor is Free and Free is the lowest tier. The predicate
 * exists (rather than a bare `true`) so the gate reads the SAME ladder as every
 * other entitlement and a future floor change is a one-line edit here.
 */
export function entitledForCrossRepoSurfacing(tier: ToolTier): boolean {
  return tierLevel(tier) >= tierLevel(CROSS_REPO_SURFACING_MIN_TIER);
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

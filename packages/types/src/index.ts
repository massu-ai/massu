// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * @massu/types — shared type definitions consumed by BOTH `@massu/core` and
 * the Vercel `website/` package.
 *
 * P-E-025 (plan-stage-e-low-info-sweep, wave2-architecture:F-ARCH-010,
 * closes deferred-idea DUP-001): eliminates the structural drift class
 * where tier names, tool names, billing plan IDs, and marketing counts
 * were duplicated across the two packages. Any future addition (new tier,
 * new plan, etc.) MUST land here first; the consumer packages re-export
 * for backward-compat with existing import paths.
 *
 * NOTE: this package is intentionally type-only at the JS level — no
 * runtime values OTHER than the `MCP_TOOL_COUNT` constant. Adding runtime
 * helpers belongs in the consumer packages.
 */

// ---------------------------------------------------------------
// Tier names (Free / Pro / Team / Enterprise)
// ---------------------------------------------------------------
//
// Mirrors `packages/core/src/license.ts:TOOL_TIER_MAP` value type AND
// `website/src/lib/billing/types.ts` historical local definition. Single
// SoT eliminates per-package divergence.

export type TierName = 'free' | 'pro' | 'team' | 'enterprise';

export const TIER_NAMES: readonly TierName[] = ['free', 'pro', 'team', 'enterprise'] as const;

export function isTierName(v: unknown): v is TierName {
  return typeof v === 'string' && (TIER_NAMES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------
// Billing plan IDs (database-row `plan` column shape)
// ---------------------------------------------------------------
//
// Mirrors `website/src/lib/supabase/types.ts:Plan`. Free tier is
// represented as `'free'` (NOT `'cloud_free'`) to match the actual DB
// column constraint added by migration 011. Paid tiers carry the
// `cloud_` prefix to distinguish DB plan rows from in-code tier names.

export type BillingPlanId = 'free' | 'cloud_pro' | 'cloud_team' | 'cloud_enterprise';

export const BILLING_PLAN_IDS: readonly BillingPlanId[] = [
  'free',
  'cloud_pro',
  'cloud_team',
  'cloud_enterprise',
] as const;

export function isBillingPlanId(v: unknown): v is BillingPlanId {
  return typeof v === 'string' && (BILLING_PLAN_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------
// Plan status (from Stripe + Lemon Squeezy subscription lifecycle)
// ---------------------------------------------------------------

export type PlanStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused';

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'paused',
] as const;

// ---------------------------------------------------------------
// Marketing constants — single source of truth for numeric claims
// ---------------------------------------------------------------
//
// Updated whenever tools are added/removed from TOOL_TIER_MAP. The
// drift-guard `marketing-tool-count-against-source-truth.test.ts` (Stage B
// P-019) reads this constant and asserts marketing surfaces in
// website/src + website/content do not contain literals other than it.

export const MCP_TOOL_COUNT = 73 as const;
export type MCPToolCount = typeof MCP_TOOL_COUNT;

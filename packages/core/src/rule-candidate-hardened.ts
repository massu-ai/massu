// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PA3-003/004 (plan-2026-06-01-team-shared-promotion-phase-3, Stream A): the
 * hardened cross-seat promotion primitives — the SECOND (executable) destination
 * allowlist, the review-attestation shape, and the apply-gate validator. Extracted
 * from `rule-candidate-applier.ts` as a cohesive concern (keeps that module under
 * the 1000-LOC cap, CR-46). The applier IMPORTS what it uses (the gate validator +
 * predicate); other sites (team-rule-sync, drift-guard, preview) import directly
 * from THIS canonical module.
 *
 * Type-only imports of `RuleDestination` / `RuleCandidateProvenance` from the
 * applier are erased at runtime, so there is NO runtime import cycle (applier →
 * hardened is the only runtime edge).
 */

import type { RuleDestination, RuleCandidateProvenance } from './rule-candidate-applier.ts';

/**
 * The HARDENED cross-seat-propagatable destinations — the executable classes
 * (`pattern-scanner` = arbitrary bash, `custom-destination` = arbitrary file
 * write) that v1 deliberately excluded. They propagate cross-seat ONLY behind the
 * hardened-review path: per-org server opt-in (default OFF) + two-operator review
 * + render-only preview + verified provenance. A SEPARATE allowlist — the
 * non-hardened `TEAM_SHAREABLE_DESTINATIONS` is NOT widened (Phase-2 guarantee).
 */
export const TEAM_HARDENED_SHAREABLE_DESTINATIONS: readonly RuleDestination[] = [
  'pattern-scanner',
  'custom-destination',
];

/** Is `destination` one of the hardened (executable) cross-seat destinations? */
export function isHardenedShareableDestination(destination: string): destination is RuleDestination {
  return (TEAM_HARDENED_SHAREABLE_DESTINATIONS as readonly string[]).includes(destination);
}

/**
 * PA3-004: the hardened-row review attestation recorded on a `hardened-pending`
 * team candidate before it may be applied. The `dry_run_ack` is the operator's
 * confirmation that they read the RENDER-ONLY preview (operator decision
 * 2026-06-01: the previewed bash/file-write is displayed + statically scanned but
 * NEVER executed — so there is no `exit_code` for the render-only path; the field
 * is kept optional for forward-compat only). `second_operator_id` MUST differ from
 * the materializing/first operator (the two-operator invariant).
 */
export interface ReviewAttestation {
  /** The SECOND distinct operator who approved (≠ the materializing/own operator). */
  second_operator_id: string;
  /** Render-only preview acknowledgement. */
  dry_run_ack: {
    /** ISO timestamp the preview was rendered + acked. */
    ran_at: string;
    /** Forward-compat only — unset for the render-only path (nothing executes). */
    exit_code?: number;
    /** Always true once the operator confirms they reviewed the rendered preview. */
    ack: true;
  };
}

// ============================================================================
// PA1-001/003 (plan-2026-06-01-enterprise-governance-audit-export): the
// GENERALIZED org-level N-of-M governance gate. Phase-3's per-rule two-operator
// review (validateHardenedApplyGate) is the N=2 special case — it now DELEGATES
// the distinct-approver count to validateGovernanceGate (CR-10: the symbol +
// all 4 existing references are preserved; only the internal distinctness check
// is expressed through the generalized primitive).
//
// The SERVER (promoted_rule_upsert + role-aware RLS, migration 049) is the REAL
// boundary; this client gate is the honor-system backstop (CR-54/55 disclosure).
// ============================================================================

/** The promoter-role enum, mirroring user_profiles.role (migration 001:40). */
export type PromoterRole = 'owner' | 'admin' | 'developer' | 'auditor';

/**
 * Privilege ordinal — the CLIENT mirror of the SQL `role_rank()` in migration
 * 049 (owner=4, admin=3, developer=2, auditor=1, else 0). A bare lexicographic
 * TEXT comparison is WRONG for these values ('auditor' >= 'admin' lexically, but
 * an auditor must NOT satisfy an admin-minimum gate), so role comparison ALWAYS
 * goes through this rank — never `>=` on the raw strings.
 */
export function roleRank(role: string): number {
  switch (role) {
    case 'owner':
      return 4;
    case 'admin':
      return 3;
    case 'developer':
      return 2;
    case 'auditor':
      return 1;
    default:
      return 0;
  }
}

/** The org governance policy as the client sees it (mirrors org_promotion_policy). */
export interface GovernancePolicy {
  /** Minimum promoter role (rank-compared); null/undefined = no role gate. */
  min_promoter_role?: PromoterRole | null;
  /** N-of-M: distinct non-promoter approvals required before apply (>= 1). */
  approvals_required: number;
  /** Destinations this org permits (subset of the 4-value vocabulary). */
  allowed_destinations: readonly string[];
  /** When true, executable destinations MUST go through the hardened path. */
  require_hardened_review?: boolean;
}

/** The approval state for a single promotion (the N-of-M ledger, client view). */
export interface GovernanceApprovals {
  /** Distinct approver user ids recorded for this promotion. */
  approver_user_ids: readonly string[];
  /** The promoter — EXCLUDED from the count (no self-approval). */
  promoted_by: string;
}

/** Optional promotion context for the role / destination / hardened sub-gates. */
export interface GovernanceContext {
  promoterRole?: string;
  destination?: string;
  hardened?: boolean;
  hasAttestation?: boolean;
}

/**
 * The generalized N-of-M governance gate. Returns an error string to REFUSE, or
 * `null` to ALLOW apply. Mirrors the server `promoted_rule_upsert` branch
 * (migration 049 PA1-002): role-rank gate, destination ∈ allowed_destinations,
 * require_hardened_review tightening, and ≥ approvals_required DISTINCT approvers
 * each ≠ the promoter. The SERVER is authoritative; this is the client backstop.
 */
export function validateGovernanceGate(
  policy: GovernancePolicy,
  approvals: GovernanceApprovals,
  ctx?: GovernanceContext,
): string | null {
  // (a) role rank — never a lexicographic TEXT comparison.
  if (policy.min_promoter_role != null && ctx?.promoterRole !== undefined) {
    if (roleRank(ctx.promoterRole) < roleRank(policy.min_promoter_role)) {
      return `promoter role '${ctx.promoterRole}' is below the org minimum '${policy.min_promoter_role}' — refusing to apply`;
    }
  }
  // (b) destination ∈ allowed_destinations.
  if (ctx?.destination !== undefined && !policy.allowed_destinations.includes(ctx.destination)) {
    return `destination '${ctx.destination}' is not in the org's allowed destinations — refusing to apply`;
  }
  // (c) require_hardened_review TIGHTENS executable destinations.
  if (
    policy.require_hardened_review === true &&
    (ctx?.destination === 'pattern-scanner' || ctx?.destination === 'custom-destination')
  ) {
    if (!(ctx.hardened === true && ctx.hasAttestation === true)) {
      return 'org policy requires hardened review for executable destinations — refusing to apply';
    }
  }
  // (d) N-of-M: count DISTINCT approvers EXCLUDING the promoter.
  const distinct = new Set(
    approvals.approver_user_ids.filter((id) => typeof id === 'string' && id.length > 0 && id !== approvals.promoted_by),
  );
  if (distinct.size < policy.approvals_required) {
    return `needs ${policy.approvals_required} approval(s); ${distinct.size} recorded — refusing to apply`;
  }
  return null;
}

/**
 * PA3-004: validate a HARDENED team-origin candidate's review attestation at the
 * apply gate. Returns an error string to refuse, or `null` to allow. Enforces the
 * structural invariants (the honor-system client backstop, CR-55 disclosure):
 *   - provenance.hardened === true (the row was materialized as hardened);
 *   - a well-formed {@link ReviewAttestation} is present;
 *   - the SECOND operator differs from the original promoter (`promoted_by`) — the
 *     two-operator invariant prevents a promoter self-approving their own
 *     executable rule;
 *   - a render-only dry_run_ack is present (the operator confirmed they reviewed
 *     the rendered preview — nothing was executed).
 *
 * PA1-003 (CR-10): the two-operator distinctness check now DELEGATES to
 * {@link validateGovernanceGate} as the N=2 special case (one distinct approver
 * — the second operator — who is not the promoter). The symbol + signature +
 * exact refusal messages are preserved for the 4 existing call/test references.
 */
export function validateHardenedApplyGate(prov: RuleCandidateProvenance): string | null {
  if (prov.hardened !== true) {
    return 'team-origin hardened-destination candidate missing hardened provenance flag — refusing to apply';
  }
  const att = prov.review_attestation;
  if (!att || typeof att !== 'object') {
    return 'team-origin hardened candidate missing review_attestation — refusing to apply';
  }
  if (typeof att.second_operator_id !== 'string' || att.second_operator_id.length === 0) {
    return 'team-origin hardened candidate review_attestation missing second_operator_id — refusing to apply';
  }
  // Two-operator invariant as the N=2 governance special case: exactly one
  // distinct approver (the second operator) who is NOT the promoter. Delegates
  // the distinct-approver count to the generalized validateGovernanceGate.
  const govErr = validateGovernanceGate(
    { approvals_required: 1, allowed_destinations: [] },
    { approver_user_ids: [att.second_operator_id], promoted_by: prov.promoted_by },
  );
  if (govErr) {
    return 'team-origin hardened candidate second_operator_id equals the promoter — two-operator review not satisfied';
  }
  const ack = att.dry_run_ack;
  if (!ack || typeof ack !== 'object' || ack.ack !== true || typeof ack.ran_at !== 'string') {
    return 'team-origin hardened candidate missing render-only dry_run_ack — refusing to apply';
  }
  return null;
}

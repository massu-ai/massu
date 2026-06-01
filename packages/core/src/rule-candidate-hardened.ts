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
  // Two-operator invariant: the approving operator MUST differ from the promoter.
  if (att.second_operator_id === prov.promoted_by) {
    return 'team-origin hardened candidate second_operator_id equals the promoter — two-operator review not satisfied';
  }
  const ack = att.dry_run_ack;
  if (!ack || typeof ack !== 'object' || ack.ack !== true || typeof ack.ran_at !== 'string') {
    return 'team-origin hardened candidate missing render-only dry_run_ack — refusing to apply';
  }
  return null;
}

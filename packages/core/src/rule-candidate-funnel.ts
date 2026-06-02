// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Promotion-funnel event capture (P1-002,
 * plan-2026-06-01-auto-learning-analytics-dashboard). Extracted from the applier
 * so rule-candidate-applier.ts stays ≤999 LOC (pattern-scanner Check 21; the
 * Phase-3 extraction discipline — a real helper module, not a @scanner-allow).
 *
 * These capture the `approved` / `dismissed` funnel transitions for the
 * org-scoped analytics dashboard. Team-gated (org analytics is a Team feature;
 * CR-54/CR-55 ladder). Best-effort + metadata-only by construction — a funnel
 * capture failure NEVER affects the local promotion/dismissal.
 */

import type Database from 'better-sqlite3';
import { enqueueRulePromotionEvent } from './memory-db.ts';
import { getCachedTierReadOnly } from './license.ts';
import { entitledForTeamSharedPromotion } from './auto-learning-entitlement.ts';

/**
 * Capture an `approved` funnel event after a successful local promotion. The
 * caller passes the already-resolved Team entitlement (`entitledTeam`) — no new
 * tier resolution (a caller cannot inject a forged tier). Fires for ANY approved
 * candidate at Team+, independent of whether the destination is cross-seat
 * shareable (the funnel tracks the approval ACTION).
 */
export function recordApprovalFunnelEvent(
  db: Database.Database,
  promptHash: string,
  destination: string,
  score: number | undefined,
  entitledTeam: boolean,
): void {
  if (!entitledTeam) return;
  enqueueRulePromotionEvent(db, {
    prompt_hash: promptHash,
    event_type: 'approved',
    created_at: new Date().toISOString(),
    metadata: { destination, score },
  });
}

/**
 * Capture a `dismissed` funnel event. dismiss() itself stays UNGATED (CR-54:
 * cleanup after a downgrade must remain possible), so resolve the tier with a
 * synchronous CACHE-ONLY read (never a network hit) and gate ONLY the analytics
 * capture on Team+. Operator free-text reasons are deliberately NOT included
 * (privacy). Never throws.
 */
export function recordDismissalFunnelEvent(
  db: Database.Database,
  promptHash: string,
  score: number | undefined,
): void {
  try {
    if (entitledForTeamSharedPromotion(getCachedTierReadOnly(db))) {
      enqueueRulePromotionEvent(db, {
        prompt_hash: promptHash,
        event_type: 'dismissed',
        created_at: new Date().toISOString(),
        metadata: { score },
      });
    }
  } catch {
    // best-effort funnel capture — never fail the dismiss
  }
}

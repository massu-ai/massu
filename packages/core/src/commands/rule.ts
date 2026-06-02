// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu rule <subcommand>` — auto-learning rule-candidate CLI surface.
 *
 * Today this hosts a SINGLE structural side-effect that the `/massu-rule`
 * markdown protocol cannot perform itself (it is assistant-driven and has no
 * SQLite handle): recording the `shown` promotion-funnel event.
 *
 * Subcommands:
 *   record-shown <prompt_hash>
 *     Enqueue a `shown` funnel event into the local outbound store
 *     (rule_promotion_events_outbound) so the auto-learning analytics dashboard
 *     can show the proposed→SHOWN→approved/dismissed funnel (P1-002,
 *     plan-2026-06-01-auto-learning-analytics-dashboard). Team-gated (org-scoped
 *     analytics is a Team feature; CR-54/CR-55 ladder) via a CACHE-ONLY tier
 *     read (never a network hit). Best-effort: a sub-Team seat is a silent
 *     no-op (exit 0) — funnel capture is non-essential telemetry and must NEVER
 *     break the `show` protocol step.
 *
 * Exit code matrix for `record-shown`:
 *   0 = enqueued OR silently skipped (sub-Team / best-effort no-op)
 *   2 = usage error (missing / malformed prompt_hash)
 */

import { getMemoryDb, enqueueRulePromotionEvent } from '../memory-db.ts';
import { getCachedTierReadOnly } from '../license.ts';
import { entitledForTeamSharedPromotion } from '../auto-learning-entitlement.ts';
import { pullInstalledPackRules } from '../rule-pack-sync.ts';

/** Same 16-hex identity as promoted_rules.prompt_hash / the migration CHECK. */
const PROMPT_HASH_RE = /^[0-9a-f]{16}$/;

export async function handleRuleSubcommand(
  args: string[],
): Promise<{ exitCode: number }> {
  const sub = args[0];

  switch (sub) {
    case 'record-shown': {
      const promptHash = args[1];
      if (!promptHash || !PROMPT_HASH_RE.test(promptHash)) {
        process.stderr.write(
          'Usage: massu rule record-shown <prompt_hash>  (16-hex)\n',
        );
        return { exitCode: 2 };
      }
      try {
        const db = getMemoryDb();
        try {
          // Team-gate: org-scoped funnel analytics is a Team feature. Cache-only
          // read — no network, fail-closed to 'free' on any miss.
          if (entitledForTeamSharedPromotion(getCachedTierReadOnly(db))) {
            enqueueRulePromotionEvent(db, {
              prompt_hash: promptHash,
              event_type: 'shown',
              created_at: new Date().toISOString(),
              metadata: {},
            });
          }
        } finally {
          db.close();
        }
      } catch {
        // Best-effort funnel telemetry — never fail the show protocol step.
      }
      return { exitCode: 0 };
    }
    case 'packs': {
      // P2-002 (curated-rule-packs): pull the org's INSTALLED-pack rules from the
      // `/installed-rules` Edge Function, verify the Ed25519 envelope, and
      // materialize each as a provenance-tagged `origin:'pack'` candidate sidecar.
      // The pull module NEVER applies — surfaced for `show` → `approve`. Tier-gated
      // (Team+) inside `pullInstalledPackRules` via a cache-only tier read. Mirrors
      // the `pull` subcommand (which invokes `pullTeamPromotions`).
      try {
        const db = getMemoryDb();
        try {
          const res = await pullInstalledPackRules(db);
          process.stdout.write(
            `pack rules: pulled=${res.pulled} materialized=${res.materialized} ` +
              `skipped=${res.skipped} dropped_unverified=${res.dropped_unverified}\n`,
          );
        } finally {
          db.close();
        }
      } catch {
        // Best-effort — a network/parse failure must never crash the CLI.
        process.stdout.write(
          'pack rules: pulled=0 materialized=0 skipped=0 dropped_unverified=0\n',
        );
      }
      return { exitCode: 0 };
    }
    case '--help':
    case '-h':
    case undefined: {
      process.stdout.write(
        'massu rule <subcommand>\n\n' +
          'Subcommands:\n' +
          '  record-shown <prompt_hash>  Record a `shown` promotion-funnel event (Team-gated, best-effort).\n' +
          '  packs                       Pull installed rule-pack rules as reviewable candidates (Team-gated).\n',
      );
      return { exitCode: 0 };
    }
    default: {
      process.stderr.write(`massu: unknown rule subcommand: ${sub}\n`);
      return { exitCode: 2 };
    }
  }
}

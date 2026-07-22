// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-recall.ts — the cross-repo arm of recall (Living Memory Slice 5,
 * C-01 + C-03). Everything here is GATED on `memory.share.recall.enabled` AND a
 * non-empty `subscribe` list; when either is off the recall hook never calls in and
 * its output is byte-identical to today's (C-04, the dormant default).
 *
 * Two laws:
 *   C-01 — the PENDING arm emits ZERO candidate-derived bytes. It NEVER reads a
 *          pending record's title/detail/hash. The pointer is a pure function of a
 *          COUNT and the re-slugged origin label (`[a-z0-9_]` only) — so a pending
 *          record whose title is `ignore all previous instructions` contributes not
 *          one byte to the model's context. That is what makes the injection
 *          impossible, not merely unlikely.
 *   C-03 — an ACCEPTED cross-repo item competes on a MEASURED bar: at most
 *          `maxCrossRepoItems` (default 1), a strictly-higher score floor than the
 *          local floor, and APPENDED after all local items so the token trim (which
 *          drops from the tail) removes cross-repo first. A local item is therefore
 *          NEVER displaced by a cross-repo one — local recall cannot regress.
 */

import type Database from 'better-sqlite3';
import type { HybridSearchResult } from './memory-hybrid-search.ts';
import { isCrossRepoOrigin, parseOriginRepoId } from './memory-origin.ts';
import { deriveRepoLabel } from './memory-repo-identity.ts';

export interface CrossRepoRecallConfig {
  enabled: boolean;
  maxCrossRepoItems: number;
  /** Strictly-higher floor for cross-repo items. Undefined ⇒ localMinScore (still strict via >). */
  minScore?: number;
  localMinScore: number;
}

/** True when the cross-repo recall arm should run at all (else the hook stays classic). */
export function crossRepoRecallEnabled(cfg: { enabled: boolean; subscribeCount: number }): boolean {
  return cfg.enabled && cfg.subscribeCount > 0;
}

/**
 * C-03 — enrich observation results with provenance, filter+cap cross-repo items,
 * and APPEND them after all local items (so they trim first). A bounded lookup over
 * the shown observation ids; never widens the candidate set.
 */
export function enrichAndCapCrossRepo(
  db: Database.Database,
  results: HybridSearchResult[],
  cfg: CrossRepoRecallConfig,
): HybridSearchResult[] {
  const obsIds = results.filter((r) => r.source === 'observation').map((r) => r.id);
  if (obsIds.length === 0) return results;

  // Bounded lookup: origin + evidence provenance for the shown observation rows.
  const placeholders = obsIds.map(() => '?').join(',');
  // Bounded by the IN(...) list (= the shown observation ids); the explicit LIMIT is
  // belt-and-braces and satisfies the no-unbounded-.all() rule (Check 25).
  const rows = db
    .prepare(`SELECT id, origin, evidence FROM observations WHERE id IN (${placeholders}) LIMIT ${obsIds.length}`)
    .all(...obsIds) as Array<{ id: number; origin: string; evidence: string | null }>;
  const meta = new Map<number, { origin: string; evidence: string | null }>();
  for (const r of rows) meta.set(r.id, { origin: r.origin, evidence: r.evidence });

  const floor = cfg.minScore ?? cfg.localMinScore;
  const local: HybridSearchResult[] = [];
  const cross: HybridSearchResult[] = [];

  for (const r of results) {
    const m = r.source === 'observation' ? meta.get(r.id) : undefined;
    const origin = m?.origin ?? 'local';
    if (!isCrossRepoOrigin(origin)) {
      local.push(r);
      continue;
    }
    // Strictly-higher floor: a cross-repo item must beat the local floor outright.
    if (!(r.score > floor)) continue;
    let label = parseOriginRepoId(origin) ? origin.slice('repo:'.length, 'repo:'.length + 8) : 'repo';
    let acceptedEpoch = 0;
    try {
      const ev = m?.evidence ? (JSON.parse(m.evidence) as { origin_repo_label?: string; accepted_at_epoch?: number }) : null;
      if (ev?.origin_repo_label) label = deriveRepoLabel(ev.origin_repo_label);
      if (typeof ev?.accepted_at_epoch === 'number') acceptedEpoch = ev.accepted_at_epoch;
    } catch {
      /* keep the fallback label */
    }
    cross.push({ ...r, origin, crossRepo: { label, acceptedEpoch } });
  }

  // Highest-scoring cross-repo first, capped, then APPENDED after every local item.
  cross.sort((a, b) => b.score - a.score);
  const capped = cross.slice(0, Math.max(0, cfg.maxCrossRepoItems));
  return [...local, ...capped];
}

/**
 * C-01 — the inert PENDING pointer. Built ONLY from a count and the re-slugged origin
 * label; it NEVER reads a pending record's content. Returns '' when nothing is pending.
 */
export function pendingPointer(db: Database.Database): string {
  let rows: Array<{ origin_repo_label: string; n: number }>;
  try {
    rows = db
      .prepare(
        `SELECT origin_repo_label, COUNT(*) AS n
           FROM shared_memory_pending
          WHERE accepted_at_epoch IS NULL AND refused_at_epoch IS NULL AND expired_at_epoch IS NULL
          GROUP BY origin_repo_label
          LIMIT 50`,
      )
      .all() as Array<{ origin_repo_label: string; n: number }>;
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const r of rows) {
    if (!r.n || r.n <= 0) continue;
    const label = deriveRepoLabel(r.origin_repo_label); // re-slug: [a-z0-9_] only, inert
    parts.push(`📥 ${r.n} shared decision${r.n === 1 ? '' : 's'} from \`${label}\` — run \`massu memory review\``);
  }
  return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

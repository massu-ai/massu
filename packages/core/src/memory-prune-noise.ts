// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * D-C (plan-memory-ingestion-decision-noise-fix): expire the observation noise the two
 * now-fixed ingestion bugs left in the corpus, so the 4B render candidate set is clean.
 *
 *   - D-A noise: tool-response "decisions" — titled `Architecture decision: <first line of
 *     whatever tool output tripped a substring match>` (`/**`, `---`, `// Copyright…`, a
 *     file path). Genuine decisions come from the assistant-reasoning path and are titled
 *     with the decision sentence, NOT this prefix — so the prefix is an exact identifier.
 *   - D-B noise: same-instant duplicate rows (same session_id + title + created_at_epoch)
 *     minted by the hook double-fire. The earliest id in each group is KEPT; the rest are
 *     the duplicates.
 *
 * ⛔ CR-61 Law 2: Massu NEVER hard-deletes a memory. Noise is EXPIRED (expired_at_epoch +
 * valid_to_epoch set) via a set-based UPDATE — it drops out of recall and out of
 * `loadRenderCandidates` (which filters `expired_at_epoch = 0`) but stays asOf-queryable.
 * No `DELETE` runs. A human-authored memory FILE is never touched: this operates on the
 * `observations` telemetry table, which the file corpus is not part of.
 */
import type Database from 'better-sqlite3';

/** LIVE tool-response false-positive decision (D-A). */
const DA_PREDICATE =
  `type = 'decision' AND title LIKE 'Architecture decision:%' AND COALESCE(expired_at_epoch, 0) = 0`;

// LIVE free-text decision (D-E, REVERTED): a bare 'decision' observation whose title is
// neither a D-A "Architecture decision:" row nor a `[memory-file]` re-ingest. These are
// regex auto-extractions from assistant prose (session-end extractDecisions / backfill) —
// e.g. "Now I'm at the D-B decision point…". Genuine decisions are STRUCTURED
// `architecture_decisions` rows via `massu_adr_create`, never a free-text observation, so a
// bare free-text 'decision' is an extraction artifact, not a curated memory.
const FT_DECISION_PREDICATE =
  `type = 'decision' AND title NOT LIKE 'Architecture decision:%' AND title NOT LIKE '[memory-file]%' AND COALESCE(expired_at_epoch, 0) = 0`;

/** A LIVE row that has an earlier LIVE row with the same (session, title, epoch) (D-B). */
const DB_PREDICATE =
  `COALESCE(expired_at_epoch, 0) = 0 AND EXISTS (
     SELECT 1 FROM observations d
      WHERE d.session_id = observations.session_id
        AND d.title = observations.title
        AND d.created_at_epoch = observations.created_at_epoch
        AND COALESCE(d.expired_at_epoch, 0) = 0
        AND d.id < observations.id
   )`;

export interface NoiseCounts {
  toolResponseDecision: number;
  freeTextDecision: number;
  sameInstantDuplicate: number;
  total: number;
}

export interface NoiseSample {
  id: number;
  type: string;
  title: string;
  reason: 'tool-response-decision' | 'free-text-decision' | 'same-instant-duplicate';
}

/**
 * Count the LIVE noise. The three classes are made MUTUALLY EXCLUSIVE so no row is
 * double-counted: FT excludes D-A (via its NOT LIKE); D-B (same-instant dup) excludes both.
 */
export function countNoise(db: Database.Database): NoiseCounts {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const da = one(`SELECT COUNT(*) n FROM observations WHERE ${DA_PREDICATE}`);
  const ft = one(`SELECT COUNT(*) n FROM observations WHERE ${FT_DECISION_PREDICATE}`);
  const dup = one(
    `SELECT COUNT(*) n FROM observations WHERE (${DB_PREDICATE}) AND NOT (${DA_PREDICATE}) AND NOT (${FT_DECISION_PREDICATE})`,
  );
  return { toolResponseDecision: da, freeTextDecision: ft, sameInstantDuplicate: dup, total: da + ft + dup };
}

/** A bounded sample of the noise, for the CLI report only (never the full set). */
export function sampleNoise(db: Database.Database, limit = 10): NoiseSample[] {
  return db
    .prepare(
      `SELECT id, type, title, reason FROM (
         SELECT id, type, title, 'tool-response-decision' AS reason, 0 AS ord
           FROM observations WHERE ${DA_PREDICATE}
         UNION ALL
         SELECT id, type, title, 'free-text-decision' AS reason, 1 AS ord
           FROM observations WHERE ${FT_DECISION_PREDICATE}
         UNION ALL
         SELECT id, type, title, 'same-instant-duplicate' AS reason, 2 AS ord
           FROM observations WHERE (${DB_PREDICATE}) AND NOT (${DA_PREDICATE}) AND NOT (${FT_DECISION_PREDICATE})
       ) ORDER BY ord, id LIMIT ?`,
    )
    .all(limit) as NoiseSample[];
}

export interface PruneResult {
  counts: NoiseCounts;
  expired: number;
  dryRun: boolean;
}

/**
 * Expire the noise. `dryRun` (default true at the CLI) writes 0. One set-based UPDATE —
 * no rows are loaded into memory, and CR-61 forbids `DELETE`, so none runs.
 *
 * The earliest row in every duplicate group is never matched by DB_PREDICATE (it has no
 * earlier live row), so it stays live throughout the statement — the expiry is correct
 * regardless of the engine's row-visibility order.
 */
export function pruneNoiseObservations(
  db: Database.Database,
  opts: { dryRun?: boolean; now?: number } = {},
): PruneResult {
  const dryRun = opts.dryRun !== false;
  const counts = countNoise(db);
  if (dryRun || counts.total === 0) return { counts, expired: 0, dryRun };

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowSec * 1000).toISOString();
  const res = db
    .prepare(
      `UPDATE observations
          SET expired_at = ?, expired_at_epoch = ?, valid_to = ?, valid_to_epoch = ?
        WHERE COALESCE(expired_at_epoch, 0) = 0
          AND ((${DA_PREDICATE}) OR (${FT_DECISION_PREDICATE}) OR (${DB_PREDICATE}))`,
    )
    .run(nowIso, nowSec, nowIso, nowSec);
  return { counts, expired: res.changes, dryRun: false };
}

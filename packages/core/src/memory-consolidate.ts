// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// The consolidation ("sleep-time") pass
// (Phase 2, plan-living-memory-slice-3-consolidation).
//
// Keeps the memory store sharp over YEARS without bloat. Five stages:
//
//   A dedupe    — collapse near-duplicates via the Slice-2 supersede gate
//   B summarize — distill a session's raw turns into ONE durable lesson,
//                 BEFORE server.ts hard-prunes those turns at 7 days
//   C promote   — cluster corrections the operator keeps repeating and propose
//                 a rule candidate (feeds the EXISTING auto-learning machinery)
//   D expire    — retire old, low-value, never-retrieved rows (an UPDATE, not
//                 a delete — history stays answerable)
//   E reweight  — promote what keeps proving useful; demote dead weight
//
// ZERO LLM, ZERO NETWORK by default: every stage is arithmetic plus the
// embedding model Massu already bundles. Only stage B may touch the OPTIONAL
// model (memory-llm.ts), and only to improve the PROSE of the lesson.
//
// STAGE ORDER IS LOAD-BEARING — this is not stylistic:
//
//   * C reads rows REGARDLESS of expired_at, and scores clusters by
//     recurrence_count. If it only looked at live rows, stage A would already
//     have superseded the duplicates it needs to count — and
//     deduplicateFailedAttempt() collapses repeat failures into a single row's
//     COUNTER rather than duplicate rows anyway. So "find the mistakes you keep
//     repeating" would never fire.
//
//   * D (expire) runs BEFORE E (reweight), so expiry can only ever act on an
//     importance value written by a PREVIOUS pass. If reweight ran first, the
//     pass would demote a row (3 -> 2) and then expire it at the floor in the
//     same breath — manufacturing its own expiry condition. Ordering it this
//     way gives every demoted row a full cadence window in which a retrieval
//     can rescue it.
//
// SAFETY: fail-open (a failing stage does zero work, never damage), idempotent
// (a second run is a near no-op), resumable (cursors in memory_meta), and
// single-writer (a lease — two concurrent passes would advance each other's
// cursors past unprocessed rows AND fight over SQLite's single write slot).
//
// NO LONG-HELD WRITE TRANSACTION: the memory DB is WAL (one writer) and
// better-sqlite3 defaults busy_timeout to 5s, so a transaction held across an
// await would block a live session's hooks and then throw SQLITE_BUSY — the
// user-visible symptom being a silently blank recall block. All slow work
// (embedding, the optional model) happens OUTSIDE any transaction; writes are
// short and batched.
// ============================================================

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  addObservation,
  expireOldLowValueObservations,
  armUsageCounter,
  usageWarmupElapsed,
  getMemoryMeta,
  setMemoryMeta,
  CONSOLIDATION_LESSON_EVIDENCE,
  MEMORY_FILE_TITLE_LIKE,
} from './memory-db.ts';
import { supersedeIfContradicted } from './memory-supersede.ts';
import { summarizeText, redactSecrets, type SummarySource, type SummaryTier } from './memory-llm.ts';
import { embed } from './memory-embedder.ts';
import { cosineSim } from './memory-vector.ts';
import { getCachedTierReadOnly } from './license.ts';
import { entitledForAutoLearning } from './auto-learning-entitlement.ts';
import {
  resolveConsolidationConfig,
  type ConsolidationConfig,
} from './consolidation-config.ts';

export interface ConsolidationResult {
  deduped: number;
  summarized: number;
  promoted: number;
  reweighted: number;
  expired: number;
  /**
   * Sessions whose raw turns were ALREADY hard-pruned before we could distill
   * them — the lesson is gone. Counted (not swallowed) so a scheduler can raise
   * a warning instead of posting a green heartbeat over a lossy pass.
   */
  sessionsMissed: number;
  /** Rule candidates NOT emitted because the tier is below Pro. */
  candidatesRefusedByTier: number;
  /** True when no embedder was available (dedupe + promote cannot run). */
  embedderUnavailable: boolean;
  /** Which summary tier stage B used (proves we never claim a model ran). */
  summaryTier: SummaryTier | null;
  stagesRun: string[];
  stagesFailed: string[];
  skipped?: 'lease-held' | 'disabled';
  /** True while the retrieval counter is still warming up (expiry disarmed). */
  warmingUp: boolean;
}

export interface ConsolidationOpts {
  config?: ConsolidationConfig;
  /** Overall wall-clock budget. */
  budgetMs?: number;
  /** Report only; write nothing. */
  dryRun?: boolean;
  /** Repo root — where the .massu/rule-candidates sidecars live. */
  projectRoot?: string;
  /** Injectable clock (seconds) for deterministic tests. */
  nowEpochSec?: number;
}

const LEASE_KEY = 'consolidate_lease';
const DEDUPE_CURSOR = 'consolidate_cursor_dedupe';
const SWEEP_BATCH = 16;
const MAX_ROWS_PER_STAGE = 500;

function emptyResult(): ConsolidationResult {
  return {
    deduped: 0, summarized: 0, promoted: 0, reweighted: 0, expired: 0,
    sessionsMissed: 0, candidatesRefusedByTier: 0, embedderUnavailable: false,
    summaryTier: null, stagesRun: [], stagesFailed: [], warmingUp: false,
  };
}

// ------------------------------------------------------------
// Single-writer lease
// ------------------------------------------------------------

/**
 * Try to take the pass lease. Two consolidation passes must never run at once:
 * they share memory_meta cursors (each would advance the other past rows it
 * had not processed — a PERMANENT row skip) and they would contend for
 * SQLite's single writer slot.
 */
function acquireLease(db: Database.Database, now: number, ttlSec: number): boolean {
  const raw = getMemoryMeta(db, LEASE_KEY);
  if (raw) {
    const expiry = Number(raw.split(':')[1]);
    if (Number.isFinite(expiry) && expiry > now) return false; // still held
  }
  setMemoryMeta(db, LEASE_KEY, `${process.pid}:${now + ttlSec}`);
  return true;
}

function releaseLease(db: Database.Database): void {
  try {
    setMemoryMeta(db, LEASE_KEY, '');
  } catch {
    // Best-effort: a stale lease expires on its own TTL.
  }
}

// ------------------------------------------------------------
// Stage A — dedupe (reuses the Slice-2 supersede gate; no new judge)
// ------------------------------------------------------------

async function stageDedupe(
  db: Database.Database,
  cfg: ConsolidationConfig,
  deadline: number,
  now: number,
): Promise<number> {
  const gated = ['decision', 'cr_violation', 'failed_attempt'];
  const cursor = Number(getMemoryMeta(db, DEDUPE_CURSOR) ?? '0') || 0;

  // A-07 — FILE-BACKED ROWS ARE NEVER DEDUPED. This clause MUST exist for as long
  // as A-06 does; shipping the type fix without it is forbidden.
  //
  // A memory file's `feedback` type maps to the observation type `decision`
  // (mapMemoryTypeToObservationType), and `decision` is inside this stage's gate.
  // Before A-06, every nested-type file landed as 'discovery' and was therefore
  // *accidentally* outside the gate — which is the only reason the operator's
  // Laws have been safe. Fixing the type read pulls 36 hand-written Laws into the
  // supersede engine for the first time, and several of them are DELIBERATE
  // near-paraphrases of one another (never-guess vs r011-diagnosis-verification;
  // enterprise-grade-always vs always-recommend-best-option). Similarity-based
  // supersession would start quietly retiring one Law as a "duplicate" of another.
  //
  // The file is the dedupe unit and the human is its judge. A file on disk is the
  // human's standing assertion that this memory is live and distinct.
  const rows = db
    .prepare(
      `SELECT id, title, detail FROM observations
        WHERE expired_at IS NULL AND id > ?
          AND type IN (${gated.map(() => '?').join(',')})
          AND title NOT LIKE ?
        ORDER BY id ASC LIMIT ?`,
    )
    .all(cursor, ...gated, MEMORY_FILE_TITLE_LIKE, MAX_ROWS_PER_STAGE) as Array<{
      id: number; title: string; detail: string | null;
    }>;

  if (rows.length === 0) {
    setMemoryMeta(db, DEDUPE_CURSOR, '0'); // clean pass -> rescan fresh next time
    return 0;
  }

  let deduped = 0;
  for (const r of rows) {
    if (Date.now() > deadline) break;
    // Skip anything superseded earlier in this same sweep.
    const live = db
      .prepare(`SELECT expired_at FROM observations WHERE id = ?`)
      .get(r.id) as { expired_at: string | null } | undefined;
    if (!live || live.expired_at != null) continue;

    const res = await supersedeIfContradicted(db, null, {
      text: `${r.title}\n${r.detail ?? ''}`.trim(),
      source: 'observation',
      newId: r.id,
      nowEpochSec: now,
    });
    if (res.superseded != null) deduped++;
    setMemoryMeta(db, DEDUPE_CURSOR, String(r.id));
  }

  return deduped;
}

// ------------------------------------------------------------
// Stage B — summarize dying sessions into durable lessons
// ------------------------------------------------------------

async function stageSummarize(
  db: Database.Database,
  cfg: ConsolidationConfig,
  deadline: number,
  now: number,
): Promise<{ summarized: number; sessionsMissed: number; tier: SummaryTier | null }> {
  const cutoff = now - cfg.summarizeAfterDays * 86400;

  const sessions = db
    .prepare(
      `SELECT s.session_id AS sid,
              (SELECT MAX(t.created_at_epoch) FROM conversation_turns t
                WHERE t.session_id = s.session_id) AS newest_turn
         FROM sessions s
        WHERE s.consolidated_at IS NULL
        ORDER BY s.session_id ASC
        LIMIT ?`,
    )
    .all(MAX_ROWS_PER_STAGE) as Array<{ sid: string; newest_turn: number | null }>;

  let summarized = 0;
  let sessionsMissed = 0;
  let tier: SummaryTier | null = null;

  const stamp = db.prepare(
    `UPDATE sessions
        SET consolidated_at = ?, consolidated_at_epoch = ?, consolidated_status = ?
      WHERE session_id = ?`,
  );
  const iso = new Date(now * 1000).toISOString();

  for (const s of sessions) {
    if (Date.now() > deadline) break;

    // The turns were already hard-pruned (server.ts prunes at 7 days) before we
    // ever got to distill them. The lesson is unrecoverable — but it must not
    // be SILENT, and the session must not be rescanned forever.
    if (s.newest_turn == null) {
      stamp.run(iso, now, 'no_turns', s.sid);
      sessionsMissed++;
      continue;
    }

    if (s.newest_turn > cutoff) continue; // still fresh — leave it alone

    // The lesson is distilled from the session's OBSERVATIONS — Massu's own
    // curated, structured records (decisions, bugfixes, failed attempts) — and
    // NEVER from raw conversation_turns.
    //
    // This is a SECURITY boundary, not a preference. Raw user prompts are
    // unfiltered pasted text: running the first version of this pass against
    // the real store produced a "durable lesson" containing `<bash-input>`
    // harness noise and a fragment of a live API key. Summarizing raw turns
    // would persist secrets into permanent memory, surface them in recall, and
    // ship them to a summarizing endpoint if one were configured. Observations
    // are the curated layer and carry no raw paste.
    //
    // (The 7-day turn prune is still what sets the CADENCE — a session must be
    // distilled while it is still recent — but the turns are the trigger, never
    // the source text.)
    const obs = db
      .prepare(
        `SELECT type, title, detail, importance FROM observations
          WHERE session_id = ? AND expired_at IS NULL
            AND COALESCE(evidence,'') != ?
          ORDER BY importance DESC LIMIT 40`,
      )
      .all(s.sid, CONSOLIDATION_LESSON_EVIDENCE) as Array<{
        type: string; title: string; detail: string | null; importance: number;
      }>;

    const sources: SummarySource[] = obs.map((o) => ({
      text: redactSecrets(`${o.type}: ${o.title}${o.detail ? ` — ${o.detail}` : ''}`),
      weight: o.importance,
    }));

    // The ONLY place the optional model is used — and only for prose. Runs
    // OUTSIDE any transaction (it may be slow / network-bound).
    const summary = sources.length > 0 ? await summarizeText(sources, { config: cfg }) : null;
    if (summary) tier = summary.tier;

    if (!summary || !summary.text) {
      // The session held nothing worth remembering (e.g. only slash-commands
      // and "ok thanks"). That is NOT a loss — so it is stamped 'no_signal' and
      // is deliberately NOT counted in sessionsMissed, which must mean exactly
      // one thing: "a real lesson was destroyed before we could distill it".
      // Writing a junk lesson here would be worse than writing none.
      stamp.run(iso, now, 'no_signal', s.sid);
      continue;
    }

    // 'discovery' is an existing type in the CHECK enum -> no schema rebuild.
    // The evidence marker makes this lesson PROTECTED from expiry: it would be
    // absurd to distill a dying session and then let the distillation die.
    addObservation(
      db,
      s.sid,
      'discovery',
      `Session lesson: ${s.sid.slice(0, 8)}`,
      redactSecrets(summary.text), // also redact model output — it echoes its input
      { importance: 4, evidence: CONSOLIDATION_LESSON_EVIDENCE },
    );
    stamp.run(iso, now, 'summarized', s.sid);
    summarized++;
  }

  return { summarized, sessionsMissed, tier };
}

// ------------------------------------------------------------
// Stage C — promote recurring corrections into rule candidates
// ------------------------------------------------------------

interface CorrectionRow {
  id: number;
  title: string;
  detail: string | null;
  session_id: string;
  recurrence_count: number;
}

/**
 * Cluster the corrections the operator keeps repeating and propose ONE rule
 * candidate per cluster, in the EXACT sidecar format the existing
 * approve/apply flow already consumes. This FEEDS the auto-learning machinery
 * — it does not rebuild it, and it never auto-applies anything: promotion
 * stays operator-approved via /massu-rule.
 */
async function stagePromote(
  db: Database.Database,
  cfg: ConsolidationConfig,
  projectRoot: string,
  deadline: number,
  now: number,
  dryRun: boolean,
): Promise<{ promoted: number; refusedByTier: number; embedderUnavailable: boolean }> {
  // CR-54 chokepoint: the CACHE-ONLY tier reader. Deliberately NOT
  // assertAutoLearningEntitled(), which resolves the tier over the NETWORK and
  // is fail-closed — in an offline 03:45 pass that would silently emit zero
  // candidates while reporting success.
  const tier = getCachedTierReadOnly(db);
  if (!entitledForAutoLearning(tier)) {
    const wouldHave = db
      .prepare(
        `SELECT COUNT(*) AS n FROM observations
          WHERE type IN ('cr_violation','failed_attempt') AND recurrence_count >= ?`,
      )
      .get(cfg.promoteMinOccurrences) as { n: number };
    return { promoted: 0, refusedByTier: wouldHave.n, embedderUnavailable: false };
  }

  // Read rows REGARDLESS of expired_at: stage A may have just superseded the
  // duplicates, and deduplicateFailedAttempt() collapses repeats into a
  // COUNTER rather than rows. Looking only at live rows would make this stage
  // structurally incapable of ever firing.
  const rows = db
    .prepare(
      `SELECT id, title, detail, session_id, recurrence_count FROM observations
        WHERE type IN ('cr_violation','failed_attempt')
        ORDER BY id DESC LIMIT ?`,
    )
    .all(MAX_ROWS_PER_STAGE) as CorrectionRow[];

  if (rows.length === 0) return { promoted: 0, refusedByTier: 0, embedderUnavailable: false };

  // Embed each correction (outside any transaction).
  const vecs = new Map<number, Float32Array>();
  for (const r of rows) {
    if (Date.now() > deadline) break;
    const v = await embed(`${r.title}\n${r.detail ?? ''}`.trim());
    if (v) vecs.set(r.id, v);
  }
  if (vecs.size === 0) {
    // No embedder (Tier-2 FTS). Clustering needs vectors — fail open.
    return { promoted: 0, refusedByTier: 0, embedderUnavailable: true };
  }

  // Greedy single-link clustering at the Slice-2 near-duplicate threshold.
  const CLUSTER_THRESHOLD = 0.8;
  const used = new Set<number>();
  const clusters: CorrectionRow[][] = [];

  for (const r of rows) {
    if (used.has(r.id) || !vecs.has(r.id)) continue;
    const cluster = [r];
    used.add(r.id);
    for (const other of rows) {
      if (used.has(other.id) || !vecs.has(other.id)) continue;
      if (cosineSim(vecs.get(r.id)!, vecs.get(other.id)!) >= CLUSTER_THRESHOLD) {
        cluster.push(other);
        used.add(other.id);
      }
    }
    clusters.push(cluster);
  }

  const candidateDir = join(projectRoot, '.massu', 'rule-candidates');
  let promoted = 0;

  for (const cluster of clusters) {
    // The store accumulates recurrence in a COUNTER, so occurrences is the SUM
    // of recurrence_count across the cluster — not the number of rows.
    const occurrences = cluster.reduce((n, c) => n + (c.recurrence_count || 1), 0);
    const sessions = new Set(cluster.map((c) => c.session_id));
    if (occurrences < cfg.promoteMinOccurrences || sessions.size < 2) continue;

    const representative = [...cluster].sort(
      (a, b) => (b.recurrence_count || 1) - (a.recurrence_count || 1),
    )[0];
    const promptText = `${representative.title}${representative.detail ? `\n${representative.detail}` : ''}`;

    // Hash a CANONICAL cluster key (sorted, normalized member titles) rather
    // than the representative's text: the same recurring mistake must produce
    // the SAME prompt_hash on every run, or (a) the existsSync check stops
    // being idempotent and we spam a new sidecar every night, and (b)
    // `/massu-rule revoke <hash>` would key off a hash that changes.
    const clusterKey = cluster
      .map((c) => c.title.toLowerCase().replace(/\s+/g, ' ').trim())
      .sort()
      .join('|');
    const promptHash = createHash('sha256').update(clusterKey).digest('hex').slice(0, 16);

    const candidatePath = join(candidateDir, `${promptHash}.json`);
    if (existsSync(candidatePath)) continue; // already proposed — idempotent
    if (dryRun) { promoted++; continue; }

    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(
      candidatePath,
      JSON.stringify(
        {
          prompt: promptText,
          prompt_hash: promptHash,
          score: Math.min(100, 60 + occurrences * 5 + sessions.size * 5),
          signals: [
            {
              type: 'consolidation-cluster',
              occurrences,
              sessions: sessions.size,
              detail: `This correction has recurred ${occurrences}x across ${sessions.size} sessions.`,
            },
          ],
          prior_turn_files: [],
          timestamp: new Date(now * 1000).toISOString(),
          session_id: representative.session_id,
          // Marks this as machine-clustered, so /massu-rule can label it and
          // does not re-classify it as an ordinary per-prompt local candidate.
          provenance: { origin: 'consolidation' },
        },
        null,
        2,
      ),
    );
    promoted++;
  }

  return { promoted, refusedByTier: 0, embedderUnavailable: false };
}

// ------------------------------------------------------------
// Stage E — usage reweighting (runs LAST; see the ordering note above)
// ------------------------------------------------------------

function stageReweight(
  db: Database.Database,
  cfg: ConsolidationConfig,
  now: number,
): number {
  const staleCutoff = now - cfg.retentionDays * 86400;
  const reweightCutoff = now - cfg.reweightIntervalDays * 86400;

  // Decay first: usefulness must be SUSTAINED, not a one-off accident.
  db.prepare(`UPDATE memory_usage SET hits_windowed = hits_windowed * ?`).run(cfg.usageDecay);

  let changed = 0;

  // PROMOTE what keeps earning its place (bounded by the CHECK: 1..5).
  const promote = db
    .prepare(
      `SELECT u.record_id AS id FROM memory_usage u
         JOIN observations o ON o.id = u.record_id
        WHERE u.source = 'observation'
          AND u.hits_windowed >= 2
          AND o.importance < 5
          AND o.expired_at IS NULL
          AND (u.last_reweight_epoch IS NULL OR u.last_reweight_epoch <= ?)
        LIMIT ?`,
    )
    .all(reweightCutoff, MAX_ROWS_PER_STAGE) as Array<{ id: number }>;

  // DEMOTE old rows nothing has ever used.
  //
  // File-backed rows are EXEMPT (MEMORY_FILE_TITLE_LIKE): they project a
  // `memory/*.md` file the human still keeps on disk, and demotion here is what
  // feeds expiry's importance floor. Decaying them would retire a memory the
  // human never withdrew — silently, and unrecoverably, since re-ingest does not
  // clear `expired_at`. The file's existence, not the hit counter, decides.
  const demote = db
    .prepare(
      `SELECT o.id AS id FROM observations o
         LEFT JOIN memory_usage u
           ON u.source = 'observation' AND u.record_id = o.id
        WHERE o.expired_at IS NULL
          AND o.created_at_epoch < ?
          AND o.importance > 1
          AND COALESCE(o.evidence,'') != ?
          AND o.title NOT LIKE ?
          AND COALESCE(u.hit_count, 0) = 0
          AND (u.last_reweight_epoch IS NULL OR u.last_reweight_epoch <= ?)
        LIMIT ?`,
    )
    .all(
      staleCutoff,
      CONSOLIDATION_LESSON_EVIDENCE,
      MEMORY_FILE_TITLE_LIKE,
      reweightCutoff,
      MAX_ROWS_PER_STAGE,
    ) as Array<{
      id: number;
    }>;

  const bump = db.prepare(`UPDATE observations SET importance = importance + 1 WHERE id = ?`);
  const drop = db.prepare(`UPDATE observations SET importance = importance - 1 WHERE id = ?`);
  // The watermark is what makes reweighting IDEMPOTENT: the demotion predicate
  // ("old + never retrieved") is still true after a demotion, so without this a
  // second run a minute later would demote the same row again, 3 -> 2 -> 1.
  // Note the upsert: a never-retrieved row has NO memory_usage row yet, so the
  // watermark needs somewhere to live.
  const mark = db.prepare(
    `INSERT INTO memory_usage (source, record_id, hit_count, hits_windowed, last_reweight_epoch)
     VALUES ('observation', ?, 0, 0, ?)
     ON CONFLICT(source, record_id) DO UPDATE SET last_reweight_epoch = excluded.last_reweight_epoch`,
  );

  const tx = db.transaction(() => {
    for (const r of promote) { bump.run(r.id); mark.run(r.id, now); changed++; }
    for (const r of demote) { drop.run(r.id); mark.run(r.id, now); changed++; }
  });
  tx();

  return changed;
}

// ------------------------------------------------------------
// The pass
// ------------------------------------------------------------

export async function runConsolidation(
  db: Database.Database,
  opts: ConsolidationOpts = {},
): Promise<ConsolidationResult> {
  const cfg = opts.config ?? resolveConsolidationConfig();
  const result = emptyResult();

  if (!cfg.enabled) return { ...result, skipped: 'disabled' };

  const now = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const budgetMs = opts.budgetMs ?? 60_000;
  const deadline = Date.now() + budgetMs;
  const dryRun = opts.dryRun === true;
  const projectRoot = opts.projectRoot ?? process.cwd();

  // Arm the retrieval counter, and remember whether expiry is allowed to run at
  // all yet. On a brand-new counter NOTHING has ever been retrieved, so expiry
  // must stay disarmed or the first pass would gut the store.
  if (!dryRun) armUsageCounter(db, now);
  result.warmingUp = !usageWarmupElapsed(db, cfg.usageWarmupDays, now);

  if (!dryRun && !acquireLease(db, now, Math.ceil((budgetMs * 2) / 1000))) {
    return { ...result, skipped: 'lease-held' };
  }

  try {
    // A — dedupe
    try {
      result.deduped = await stageDedupe(db, cfg, deadline, now);
      result.stagesRun.push('dedupe');
    } catch { result.stagesFailed.push('dedupe'); }

    // B — summarize
    try {
      if (!dryRun) {
        const s = await stageSummarize(db, cfg, deadline, now);
        result.summarized = s.summarized;
        result.sessionsMissed = s.sessionsMissed;
        result.summaryTier = s.tier;
      }
      result.stagesRun.push('summarize');
    } catch { result.stagesFailed.push('summarize'); }

    // C — promote
    try {
      const p = await stagePromote(db, cfg, projectRoot, deadline, now, dryRun);
      result.promoted = p.promoted;
      result.candidatesRefusedByTier = p.refusedByTier;
      result.embedderUnavailable = p.embedderUnavailable;
      result.stagesRun.push('promote');
    } catch { result.stagesFailed.push('promote'); }

    // D — expire (BEFORE reweight, so it can never consume an importance value
    //     this same pass just wrote)
    try {
      if (!dryRun) {
        result.expired = expireOldLowValueObservations(db, {
          retentionDays: cfg.retentionDays,
          importanceFloor: cfg.importanceFloor,
          protectedTypes: cfg.protectedTypes,
          usageWarmupDays: cfg.usageWarmupDays,
          reweightIntervalDays: cfg.reweightIntervalDays,
          nowEpochSec: now,
        });
      }
      result.stagesRun.push('expire');
    } catch { result.stagesFailed.push('expire'); }

    // E — reweight
    try {
      if (!dryRun) result.reweighted = stageReweight(db, cfg, now);
      result.stagesRun.push('reweight');
    } catch { result.stagesFailed.push('reweight'); }
  } finally {
    if (!dryRun) releaseLease(db);
  }

  return result;
}

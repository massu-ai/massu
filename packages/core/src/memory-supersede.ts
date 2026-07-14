// ============================================================
// Supersede-don't-delete contradiction gate
// (plan-living-memory-slice-2-temporal-model, P2-001 + P2-002)
//
// When a new high-value memory (a decision, a correction, a failed-attempt) is
// captured, this module finds semantically-related EXISTING records and decides
// — mem0-style — whether to ADD (new fact), UPDATE (the new record supersedes an
// old, contradicting one), or NOOP (near-duplicate). On UPDATE it calls
// markRecordSuperseded, which sets the old row's valid_to/expired_at/superseded_by
// via an UPDATE — the old row is NEVER deleted (Zep invalidate-don't-delete), so
// "what did we believe on date X" stays answerable and current recall stays clean.
//
// Every path is FAIL-OPEN: no embedder, disabled config, endpoint error, budget
// exceeded, or any thrown error all degrade to ADD (a plain insert, prior
// behavior). This runs from the ASYNC capture hooks AFTER the row is inserted —
// never inside the synchronous addObservation/storeDecision writers — so the hot
// write path and its many callers are unchanged.
// ============================================================

import type Database from 'better-sqlite3';
import { getConfig } from './config.ts';
import { embed, getActiveEmbedModel } from './memory-embedder.ts';
import { blobToFloat32, cosineSim } from './memory-vector.ts';
import { hybridSearch, type HybridSource } from './memory-hybrid-search.ts';
import { markRecordSuperseded } from './memory-db.ts';

/** mem0 op-set MINUS delete — supersede is the only removal, so DELETE ≡ UPDATE-expire. */
export type SupersedeOp = 'ADD' | 'UPDATE' | 'NOOP';

/** The temporal memory sources this gate operates on (the two accumulating stores). */
export type SupersedeSource = 'observation' | 'architecture_decision';

export interface ContradictionVerdict {
  op: SupersedeOp;
  /** For UPDATE: the id of the existing record that the new record supersedes. */
  targetId?: number;
  targetSource?: SupersedeSource;
  reason: string;
}

export interface ScoredCandidate {
  id: number;
  source: SupersedeSource;
  cosine: number;
}

export interface ContradictionConfig {
  enabled: boolean;
  judgeEndpoint?: string;
  similarityThreshold: number;
  dedupThreshold: number;
  gatedTypes: string[];
  annotateSuperseded: boolean;
  budgetMs: number;
}

// Thresholds calibrated empirically against the bundled all-MiniLM-L6-v2 model
// (docs/reports/2026-07-12-living-memory-slice-2-RESULTS.md): same-topic
// contradictions score cos≈0.65–0.86, related-but-complementary ≈0.47, unrelated
// <0.25, near-duplicates ≈0.95. similarityThreshold=0.60 catches contradictions
// while excluding merely-related facts (and a replacement signal is ALSO
// required); dedupThreshold=0.93 routes near-duplicates to NOOP.
const DEFAULT_CONFIG: ContradictionConfig = {
  enabled: true,
  similarityThreshold: 0.6,
  dedupThreshold: 0.93,
  gatedTypes: ['decision', 'cr_violation', 'failed_attempt'],
  annotateSuperseded: false,
  budgetMs: 800,
};

// Replacement/negation lexicon — text that signals the new record RETRACTS a
// prior belief rather than merely relating to it. Kept deliberately small and
// high-precision; a near-duplicate above dedupThreshold is a NOOP regardless.
const REPLACEMENT_SIGNAL =
  /\b(instead of|no longer|not\s+\w+\s+anymore|switch(?:ing|ed)?\s+(?:from|to)|replac(?:e|es|ed|ing)|deprecat(?:e|ed|es)|supersed(?:e|ed|es)|now\s+(?:we|use|using)|actually|correction|revert(?:ed|ing)?|changed?\s+to|moved?\s+(?:from|to)|abandon(?:ed)?|rolled?\s+back)\b/i;

/** Does the new record's text read like it retracts/replaces a prior belief? */
export function hasReplacementSignal(text: string): boolean {
  return REPLACEMENT_SIGNAL.test(text);
}

/**
 * Resolve the effective contradiction config, merging the parsed config block
 * over safe defaults. Fail-open: any missing field falls back to the default.
 */
export function resolveContradictionConfig(): ContradictionConfig {
  try {
    const c = getConfig().memory?.contradiction as Partial<ContradictionConfig> | undefined;
    if (!c) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...c };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * The local heuristic judge (Tier 1). Given the new record's text and the
 * cosine-scored related candidates, pick ADD / UPDATE / NOOP.
 *   - top cosine >= dedupThreshold            → NOOP (near-duplicate, not a contradiction)
 *   - similarityThreshold <= top < dedup AND replacement signal → UPDATE (supersede top)
 *   - otherwise                                → ADD (novel or merely related)
 */
export function judgeContradiction(
  newText: string,
  candidates: ScoredCandidate[],
  cfg: ContradictionConfig,
): ContradictionVerdict {
  if (candidates.length === 0) {
    return { op: 'ADD', reason: 'no related candidates' };
  }
  const top = [...candidates].sort((a, b) => b.cosine - a.cosine)[0];
  if (top.cosine >= cfg.dedupThreshold) {
    return { op: 'NOOP', targetId: top.id, targetSource: top.source, reason: `near-duplicate (cos=${top.cosine.toFixed(3)})` };
  }
  if (top.cosine >= cfg.similarityThreshold && hasReplacementSignal(newText)) {
    return {
      op: 'UPDATE',
      targetId: top.id,
      targetSource: top.source,
      reason: `contradiction: related (cos=${top.cosine.toFixed(3)}) + replacement signal`,
    };
  }
  return { op: 'ADD', reason: `related but no contradiction (top cos=${top.cosine.toFixed(3)})` };
}

/**
 * Optional Tier-0 external judge. POSTs the new text + candidate summaries to an
 * OpenAI-compatible endpoint and expects `{ op, targetId? }`. Returns null on ANY
 * problem (unset endpoint, network error, timeout, malformed response) so the
 * caller falls back to the local heuristic. No memory egresses unless the
 * operator configured judgeEndpoint.
 */
async function judgeViaEndpoint(
  endpoint: string,
  newText: string,
  candidates: ScoredCandidate[],
  budgetMs: number,
): Promise<ContradictionVerdict | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: newText, candidates }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;
    const data = (await resp.json()) as { op?: string; targetId?: number };
    if (data.op !== 'ADD' && data.op !== 'UPDATE' && data.op !== 'NOOP') return null;
    if (data.op === 'UPDATE' && typeof data.targetId !== 'number') return null;
    const match = candidates.find((c) => c.id === data.targetId);
    return {
      op: data.op,
      targetId: data.op === 'UPDATE' ? data.targetId : undefined,
      targetSource: match?.source,
      reason: 'external judge',
    };
  } catch {
    return null;
  }
}

/** Load a candidate's stored/derived embedding vector; null if unavailable. */
async function candidateVec(
  memDb: Database.Database,
  source: SupersedeSource,
  id: number,
): Promise<Float32Array | null> {
  try {
    if (source === 'observation') {
      // Prefer the stored vector; fall back to embedding.
      //
      // A-04 — an observation now has one vector per CHUNK. Contradiction detection
      // compares two memories as wholes, so it takes the FIRST chunk explicitly:
      // `chunk_ix = 0` is the opening passage, which is exactly what the single
      // pre-chunking vector always was. Pinning it keeps this path's semantics
      // IDENTICAL to before; without the ORDER BY it would silently grab whichever
      // chunk SQLite returned first, making supersede decisions non-deterministic.
      const row = memDb
        .prepare(
          `SELECT vec FROM observation_embeddings
            WHERE observation_id = ? ORDER BY chunk_ix ASC LIMIT 1`,
        )
        .get(id) as { vec: Buffer } | undefined;
      if (row?.vec) {
        const v = blobToFloat32(row.vec);
        if (v) return v;
      }
      const obs = memDb
        .prepare(`SELECT title, detail FROM observations WHERE id = ?`)
        .get(id) as { title: string; detail: string | null } | undefined;
      if (!obs) return null;
      return await embed(`${obs.title}\n${obs.detail ?? ''}`.trim());
    }
    // architecture_decision — no stored-vector table; embed on the fly.
    const ad = memDb
      .prepare(`SELECT title, decision FROM architecture_decisions WHERE id = ?`)
      .get(id) as { title: string; decision: string } | undefined;
    if (!ad) return null;
    return await embed(`${ad.title}\n${ad.decision}`.trim());
  } catch {
    return null;
  }
}

export interface SupersedeResult {
  op: SupersedeOp;
  /** The id of the record that was superseded (expired), or null. */
  superseded: number | null;
  reason: string;
}

/**
 * The gate. Embed the new record, find related LIVE candidates (hybridSearch
 * excludes expired rows by default), score them by cosine, judge, and on a
 * contradiction supersede-don't-delete the old record. Fully fail-open + budgeted.
 *
 * Call this from the ASYNC capture hooks AFTER the row is inserted, passing the
 * new row's id so it can't supersede itself.
 */
export async function supersedeIfContradicted(
  memDb: Database.Database,
  knowledgeDb: Database.Database | null,
  args: {
    text: string;
    source: SupersedeSource;
    newId: number;
    config?: ContradictionConfig;
    nowEpochSec?: number;
  },
): Promise<SupersedeResult> {
  const cfg = args.config ?? resolveContradictionConfig();
  if (!cfg.enabled) return { op: 'ADD', superseded: null, reason: 'disabled' };
  const start = Date.now();
  try {
    const queryVec = await embed(args.text);
    if (!queryVec) return { op: 'ADD', superseded: null, reason: 'no embedder (fail-open)' };
    const active = getActiveEmbedModel();
    const results = hybridSearch(memDb, knowledgeDb, {
      queryText: args.text,
      queryVec,
      modelId: active?.modelId ?? null,
      dim: active?.dim ?? null,
      sources: [args.source as HybridSource],
      limit: 5,
      candidatePool: 20,
    });
    const scored: ScoredCandidate[] = [];
    for (const r of results) {
      if (r.id === args.newId) continue;
      if (Date.now() - start > cfg.budgetMs) break;
      const vec = await candidateVec(memDb, args.source, r.id);
      if (vec) scored.push({ id: r.id, source: args.source, cosine: cosineSim(queryVec, vec) });
    }

    let verdict: ContradictionVerdict | null = null;
    if (cfg.judgeEndpoint && Date.now() - start < cfg.budgetMs) {
      verdict = await judgeViaEndpoint(cfg.judgeEndpoint, args.text, scored, cfg.budgetMs);
    }
    if (!verdict) verdict = judgeContradiction(args.text, scored, cfg);

    if (verdict.op === 'UPDATE' && typeof verdict.targetId === 'number') {
      const table = args.source === 'observation' ? 'observations' : 'architecture_decisions';
      const ok = markRecordSuperseded(memDb, table, verdict.targetId, args.newId, args.nowEpochSec);
      return { op: 'UPDATE', superseded: ok ? verdict.targetId : null, reason: verdict.reason };
    }
    return { op: verdict.op, superseded: null, reason: verdict.reason };
  } catch (e) {
    return { op: 'ADD', superseded: null, reason: `fail-open: ${(e as Error).message}` };
  }
}

/**
 * Session-level supersede sweep (P2-003). Runs from the latency-tolerant
 * session-end hook AFTER the embed sweep. For this session's gated-type
 * observations and auto-captured decisions — processed NEWEST-FIRST so a
 * correction supersedes the earlier belief, not the reverse — find contradicted
 * live priors and supersede-don't-delete them. Skips records already expired
 * mid-sweep. Overall-budgeted + fully fail-open (never blocks session end).
 * Returns the count of records superseded.
 */
/** Upper bound on records scanned per store per session sweep (bounded .all()). */
const SWEEP_MAX_RECORDS = 500;

export async function runSessionSupersedeSweep(
  memDb: Database.Database,
  sessionId: string,
  opts?: { config?: ContradictionConfig; budgetMs?: number; nowEpochSec?: number },
): Promise<{ superseded: number }> {
  const cfg = opts?.config ?? resolveContradictionConfig();
  if (!cfg.enabled) return { superseded: 0 };
  const overallBudget = opts?.budgetMs ?? 4000;
  const start = Date.now();
  let count = 0;

  const stillLive = (table: 'observations' | 'architecture_decisions', id: number): boolean => {
    const row = memDb.prepare(`SELECT expired_at FROM ${table} WHERE id = ?`).get(id) as
      | { expired_at: string | null }
      | undefined;
    return !!row && row.expired_at == null;
  };

  try {
    if (cfg.gatedTypes.length > 0) {
      const placeholders = cfg.gatedTypes.map(() => '?').join(',');
      const obs = memDb
        .prepare(
          `SELECT id, title, detail FROM observations
            WHERE session_id = ? AND expired_at IS NULL AND type IN (${placeholders})
            ORDER BY created_at_epoch DESC LIMIT ?`,
        )
        .all(sessionId, ...cfg.gatedTypes, SWEEP_MAX_RECORDS) as Array<{ id: number; title: string; detail: string | null }>;
      for (const o of obs) {
        if (Date.now() - start > overallBudget) break;
        if (!stillLive('observations', o.id)) continue; // superseded earlier this sweep
        const res = await supersedeIfContradicted(memDb, null, {
          text: `${o.title}\n${o.detail ?? ''}`.trim(),
          source: 'observation',
          newId: o.id,
          config: cfg,
          nowEpochSec: opts?.nowEpochSec,
        });
        if (res.superseded != null) count++;
      }
    }

    const decs = memDb
      .prepare(
        `SELECT id, title, decision FROM architecture_decisions
          WHERE session_id = ? AND expired_at IS NULL ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, SWEEP_MAX_RECORDS) as Array<{ id: number; title: string; decision: string }>;
    for (const d of decs) {
      if (Date.now() - start > overallBudget) break;
      if (!stillLive('architecture_decisions', d.id)) continue;
      const res = await supersedeIfContradicted(memDb, null, {
        text: `${d.title}\n${d.decision}`.trim(),
        source: 'architecture_decision',
        newId: d.id,
        config: cfg,
        nowEpochSec: opts?.nowEpochSec,
      });
      if (res.superseded != null) count++;
    }
  } catch {
    // fail-open — never block session end
  }
  return { superseded: count };
}

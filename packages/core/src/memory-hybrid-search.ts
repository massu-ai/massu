// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P1-003 (plan-living-memory-slice-1): hybrid relevance search.
//
// Ranking substrate for the memory-recall hook. Combines, per source:
//   (1) FTS5 BM25 top-M candidates + recency top-M (union) — candidate select;
//   (2) optional cosine over stored embeddings (rows whose (model_id,dim)
//       match the active query embedder; others are skipped);
//   (3) Reciprocal Rank Fusion of the BM25 and cosine channels;
//   (4) final score = RRF × importanceWeight × recencyDecay.
//
// When `queryVec` is null (no embedder available), it degrades gracefully to
// BM25-only ranking (with recency/importance still shaping the final score) —
// the FTS-only mode that ships first.
//
// Design note (deviation from plan literal): the plan lists hybridSearch under
// both memory-db.ts and knowledge-db.ts. Ranking logic (RRF, decay, cosine)
// lives here ONCE (DRY / modular / testable) and reads both DBs, rather than
// being duplicated across two large files. Behavior/contract is unchanged.
// ============================================================

import type Database from 'better-sqlite3';
import { sanitizeFts5QueryOr } from './memory-db.ts';
import { blobToFloat32, cosineSim } from './memory-vector.ts';

export type HybridSource =
  | 'observation'
  | 'architecture_decision'
  | 'knowledge_chunk'
  | 'failure_class';

export interface HybridSearchResult {
  id: number;
  source: HybridSource;
  title: string;
  snippet: string;
  score: number;
  importance: number;
  ageDays: number;
}

export interface HybridSearchOpts {
  queryText: string;
  queryVec?: Float32Array | null;
  /** Which query-embedder produced queryVec (used to skip mismatched rows). */
  modelId?: string | null;
  dim?: number | null;
  sources?: HybridSource[];
  limit?: number;
  minScore?: number;
  /** Candidate pool size per channel per source (default 30). */
  candidatePool?: number;
  /** Injectable clock for deterministic tests (epoch ms). */
  now?: number;
  /**
   * Temporal "as of" point (epoch MS). When set, recall reconstructs the belief
   * state at that instant: a record counts iff it was ingested by then and not
   * yet expired/invalidated at then (bi-temporal, plan-living-memory-slice-2).
   * Distinct from `now` (the recency-weighting clock). Unset → "current".
   */
  asOf?: number;
  /**
   * When true (and `asOf` unset), superseded/expired records are INCLUDED and
   * their snippet annotated "(superseded on <date> by #<id>)". Default false —
   * expired records are excluded so recall never presents a stale fact as live.
   * Only affects the two bi-temporal stores (observations, architecture_decisions).
   */
  includeSuperseded?: boolean;
}

/**
 * Build the bi-temporal WHERE predicate (bare, no leading AND) for the two
 * stores that carry the *_epoch columns. `prefix` qualifies the columns (e.g.
 * 'o.' for a joined alias). Returns '' when no temporal filter applies. The
 * interpolated bound is a floored integer (epoch seconds) — never untrusted text.
 */
function temporalPredicate(
  asOf: number | undefined,
  includeSuperseded: boolean,
  prefix: string,
): string {
  const c = (name: string): string => `${prefix}${name}`;
  if (asOf != null && Number.isFinite(asOf)) {
    const t = Math.floor(Number(asOf) / 1000); // stored *_epoch are SECONDS
    return (
      `${c('ingested_at_epoch')} <= ${t} AND (${c('expired_at_epoch')} IS NULL OR ${c('expired_at_epoch')} > ${t}) ` +
      `AND ${c('valid_from_epoch')} <= ${t} AND (${c('valid_to_epoch')} IS NULL OR ${c('valid_to_epoch')} > ${t})`
    );
  }
  if (!includeSuperseded) {
    return `${c('expired_at_epoch')} IS NULL`;
  }
  return '';
}

// RRF_K controls how sharply rank position matters. The classic value (60) is
// tuned for fusing many long ranked lists; here we fuse a couple of short
// candidate lists and want relevance to be the PRIMARY signal, so a smaller K
// gives rank position real spread (rank0=1/11, rank5=1/16, unmatched≈1/41).
const RRF_K = 10;
// Gentle recency half-life so recency is a mild tiebreak, NOT a dominator that
// can let a fresh-but-irrelevant item outrank an older BM25 match.
const RECENCY_HALF_LIFE_DAYS = 180;
const DEFAULT_LIMIT = 8;
const DEFAULT_POOL = 30;
const ALL_SOURCES: HybridSource[] = [
  'observation',
  'architecture_decision',
  'knowledge_chunk',
  'failure_class',
];

interface Candidate {
  id: number;
  source: HybridSource;
  title: string;
  snippet: string;
  importance: number;
  ageDays: number;
  bm25Order: number | null; // index in BM25 list (0-based), null if not matched
  /**
   * A-04 — ALL of this record's chunk vectors, not one.
   *
   * The embedder clamps at 256 tokens, so a long memory is embedded as several
   * passages. A single `vec` field meant the LAST chunk loaded silently won and the
   * rest were discarded — the record would then score on an arbitrary passage.
   * Relevance is MAX-POOLED: a memory is as relevant as its most relevant passage.
   */
  vecs: Float32Array[];
}

function snippetOf(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function ageDaysFrom(epochMs: number, nowMs: number): number {
  const days = (nowMs - epochMs) / 86_400_000;
  return days < 0 ? 0 : days;
}

/**
 * Bounded recency multiplier in [0.7, 1.0]: fresh → 1.0, ancient → 0.7. Kept
 * mild so recency shapes ties without overriding relevance.
 */
function recencyWeight(ageDays: number): number {
  const freshness = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS); // (0,1]
  return 0.7 + 0.3 * freshness;
}

/**
 * Bounded importance multiplier in [0.76, 1.0] for importance 1..5 (neutral-ish
 * so a high-importance item edges out an equal-relevance low-importance one).
 */
function importanceWeightOf(importance: number): number {
  const clamped = Math.max(1, Math.min(5, importance));
  return 0.7 + 0.3 * (clamped / 5);
}

/** Collect candidates from the memory DB observation source. */
function collectObservations(
  memDb: Database.Database,
  queryText: string,
  pool: number,
  nowMs: number,
  loadVec: boolean,
  modelId: string | null,
  dim: number | null,
  asOf: number | undefined,
  includeSuperseded: boolean,
): Candidate[] {
  const map = new Map<number, Candidate>();
  // Bi-temporal filter: BM25 channel joins observations as `o`, recency channel
  // queries observations unqualified.
  const bm25Temporal = temporalPredicate(asOf, includeSuperseded, 'o.');
  const plainTemporal = temporalPredicate(asOf, includeSuperseded, '');

  // BM25 channel
  try {
    const rows = memDb
      .prepare(
        `SELECT o.id, o.title, o.detail, o.importance, o.created_at_epoch
         FROM observations_fts
         JOIN observations o ON observations_fts.rowid = o.id
         WHERE observations_fts MATCH ?${bm25Temporal ? ` AND ${bm25Temporal}` : ''}
         ORDER BY rank LIMIT ?`,
      )
      .all(sanitizeFts5QueryOr(queryText), pool) as Array<{
      id: number;
      title: string;
      detail: string | null;
      importance: number;
      created_at_epoch: number;
    }>;
    rows.forEach((r, i) => {
      map.set(r.id, {
        id: r.id,
        source: 'observation',
        title: r.title,
        snippet: snippetOf(r.detail ?? r.title),
        importance: r.importance,
        ageDays: ageDaysFrom(r.created_at_epoch * 1000, nowMs),
        bm25Order: i,
        vecs: [],
      });
    });
  } catch {
    // FTS parse/table error — skip BM25 channel for this source.
  }

  // Recency channel (union)
  const recent = memDb
    .prepare(
      `SELECT id, title, detail, importance, created_at_epoch
       FROM observations${plainTemporal ? ` WHERE ${plainTemporal}` : ''} ORDER BY created_at_epoch DESC LIMIT ?`,
    )
    .all(pool) as Array<{
    id: number;
    title: string;
    detail: string | null;
    importance: number;
    created_at_epoch: number;
  }>;
  for (const r of recent) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id,
        source: 'observation',
        title: r.title,
        snippet: snippetOf(r.detail ?? r.title),
        importance: r.importance,
        ageDays: ageDaysFrom(r.created_at_epoch * 1000, nowMs),
        bm25Order: null,
        vecs: [],
      });
    }
  }

  if (loadVec && map.size > 0) {
    loadEmbeddings(
      memDb,
      'observation_embeddings',
      'observation_id',
      [...map.keys()],
      modelId,
      dim,
      (id, vec) => {
        const c = map.get(id);
        if (c) c.vecs.push(vec);
      },
    );
  }

  return [...map.values()];
}

/** Generic candidate collector for non-FTS memory sources via LIKE. */
function collectLikeSource(
  db: Database.Database,
  source: HybridSource,
  cfg: {
    table: string;
    idCol: string;
    titleExpr: string;
    snippetCol: string;
    searchCols: string[];
    createdCol: string;
    createdIsEpoch: boolean;
    /** Bare bi-temporal predicate (no leading AND); set only for temporal stores. */
    temporalClause?: string;
  },
  queryText: string,
  pool: number,
  nowMs: number,
): Candidate[] {
  const map = new Map<number, Candidate>();
  const tokens = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 8);

  const ageExpr = (created: string | number): number => {
    const ms = cfg.createdIsEpoch
      ? Number(created) * 1000
      : Date.parse(String(created));
    return Number.isFinite(ms) ? ageDaysFrom(ms, nowMs) : 0;
  };

  // BM25-substitute channel: LIKE match, ordered by recency as a proxy.
  if (tokens.length > 0) {
    const likeClause = cfg.searchCols
      .map((col) => tokens.map(() => `${col} LIKE ?`).join(' OR '))
      .join(' OR ');
    const params: string[] = [];
    for (const _col of cfg.searchCols) for (const t of tokens) params.push(`%${t}%`);
    try {
      const rows = db
        .prepare(
          `SELECT ${cfg.idCol} AS id, ${cfg.titleExpr} AS title,
                  ${cfg.snippetCol} AS snippet, ${cfg.createdCol} AS created
           FROM ${cfg.table} WHERE (${likeClause})${cfg.temporalClause ? ` AND ${cfg.temporalClause}` : ''}
           ORDER BY ${cfg.createdCol} DESC LIMIT ?`,
        )
        .all(...params, pool) as Array<{
        id: number;
        title: string;
        snippet: string | null;
        created: string | number;
      }>;
      rows.forEach((r, i) => {
        map.set(r.id, {
          id: r.id,
          source,
          title: r.title,
          snippet: snippetOf(r.snippet ?? r.title),
          importance: 3,
          ageDays: ageExpr(r.created),
          bm25Order: i,
          vecs: [],
        });
      });
    } catch {
      // Malformed query — skip channel.
    }
  }

  // Recency channel (union)
  const recent = db
    .prepare(
      `SELECT ${cfg.idCol} AS id, ${cfg.titleExpr} AS title,
              ${cfg.snippetCol} AS snippet, ${cfg.createdCol} AS created
       FROM ${cfg.table}${cfg.temporalClause ? ` WHERE ${cfg.temporalClause}` : ''} ORDER BY ${cfg.createdCol} DESC LIMIT ?`,
    )
    .all(pool) as Array<{
    id: number;
    title: string;
    snippet: string | null;
    created: string | number;
  }>;
  for (const r of recent) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id,
        source,
        title: r.title,
        snippet: snippetOf(r.snippet ?? r.title),
        importance: 3,
        ageDays: ageExpr(r.created),
        bm25Order: null,
        vecs: [],
      });
    }
  }

  return [...map.values()];
}

/** Collect candidates from the knowledge DB chunk source. */
function collectKnowledgeChunks(
  knowledgeDb: Database.Database,
  queryText: string,
  pool: number,
  nowMs: number,
  loadVec: boolean,
  modelId: string | null,
  dim: number | null,
): Candidate[] {
  const map = new Map<number, Candidate>();

  try {
    const rows = knowledgeDb
      .prepare(
        `SELECT kc.id AS id, kc.heading AS heading, kc.content AS content,
                kd.indexed_at_epoch AS epoch
         FROM knowledge_fts
         JOIN knowledge_chunks kc ON knowledge_fts.rowid = kc.id
         JOIN knowledge_documents kd ON kd.id = kc.document_id
         WHERE knowledge_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(sanitizeFts5QueryOr(queryText), pool) as Array<{
      id: number;
      heading: string | null;
      content: string;
      epoch: number;
    }>;
    rows.forEach((r, i) => {
      map.set(r.id, {
        id: r.id,
        source: 'knowledge_chunk',
        title: r.heading || snippetOf(r.content, 60),
        snippet: snippetOf(r.content),
        importance: 3,
        ageDays: ageDaysFrom((r.epoch ?? 0) * 1000, nowMs),
        bm25Order: i,
        vecs: [],
      });
    });
  } catch {
    // knowledge_fts missing/parse error — skip.
  }

  if (loadVec && map.size > 0) {
    loadEmbeddings(
      knowledgeDb,
      'knowledge_chunk_embeddings',
      'chunk_id',
      [...map.keys()],
      modelId,
      dim,
      (id, vec) => {
        const c = map.get(id);
        if (c) c.vecs.push(vec);
      },
    );
  }

  return [...map.values()];
}

/** Load matching embeddings for a set of ids, skipping model/dim mismatches. */
function loadEmbeddings(
  db: Database.Database,
  table: string,
  idCol: string,
  ids: number[],
  modelId: string | null,
  dim: number | null,
  assign: (id: number, vec: Float32Array) => void,
): void {
  if (!modelId || !dim || ids.length === 0) return;
  try {
    const placeholders = ids.map(() => '?').join(',');
    // LIMIT bounds the scan to the candidate id count (P-DG-001 /
    // massu/no-unbounded-sql-all); the IN clause already caps it, LIMIT makes
    // that explicit for the drift-guard.
    const rows = db
      .prepare(
        `SELECT ${idCol} AS id, vec FROM ${table}
         WHERE ${idCol} IN (${placeholders}) AND model_id = ? AND dim = ?
         LIMIT ?`,
      )
      .all(...ids, modelId, dim, ids.length) as Array<{ id: number; vec: Buffer }>;
    for (const r of rows) {
      const v = blobToFloat32(r.vec);
      if (v && v.length === dim) assign(r.id, v);
    }
  } catch {
    // Embedding table absent or query error — proceed BM25-only.
  }
}

/**
 * Run hybrid search across the requested sources.
 *
 * @param memDb Memory DB (observations / architecture_decisions / failure_classes).
 * @param knowledgeDb Knowledge DB (knowledge_chunks), or null to skip that source.
 */
export function hybridSearch(
  memDb: Database.Database,
  knowledgeDb: Database.Database | null,
  opts: HybridSearchOpts,
): HybridSearchResult[] {
  const sources = opts.sources ?? ALL_SOURCES;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const minScore = opts.minScore ?? 0;
  const pool = opts.candidatePool ?? DEFAULT_POOL;
  const nowMs = opts.now ?? Date.now();
  const queryVec = opts.queryVec ?? null;
  const modelId = queryVec ? opts.modelId ?? null : null;
  const dim = queryVec ? opts.dim ?? null : null;
  const loadVec = !!(queryVec && modelId && dim);
  const includeSuperseded = opts.includeSuperseded ?? false;

  let candidates: Candidate[] = [];

  if (sources.includes('observation')) {
    candidates = candidates.concat(
      collectObservations(
        memDb, opts.queryText, pool, nowMs, loadVec, modelId, dim, opts.asOf, includeSuperseded,
      ),
    );
  }
  if (sources.includes('architecture_decision')) {
    candidates = candidates.concat(
      collectLikeSource(
        memDb,
        'architecture_decision',
        {
          table: 'architecture_decisions',
          idCol: 'id',
          titleExpr: 'title',
          snippetCol: 'decision',
          searchCols: ['title', 'decision', 'context'],
          createdCol: 'created_at',
          createdIsEpoch: false,
          temporalClause: temporalPredicate(opts.asOf, includeSuperseded, ''),
        },
        opts.queryText,
        pool,
        nowMs,
      ),
    );
  }
  if (sources.includes('failure_class')) {
    candidates = candidates.concat(
      collectLikeSource(
        memDb,
        'failure_class',
        {
          table: 'failure_classes',
          idCol: 'id',
          titleExpr: 'name',
          snippetCol: 'description',
          searchCols: ['name', 'description', 'known_message'],
          createdCol: 'created_at',
          createdIsEpoch: false,
        },
        opts.queryText,
        pool,
        nowMs,
      ),
    );
  }
  if (sources.includes('knowledge_chunk') && knowledgeDb) {
    candidates = candidates.concat(
      collectKnowledgeChunks(knowledgeDb, opts.queryText, pool, nowMs, loadVec, modelId, dim),
    );
  }

  if (candidates.length === 0) return [];

  // Cosine channel ranking (only when a query vector is present).
  const worstBm25 = pool + 1;
  let cosineOrder: Map<string, number> | null = null;
  if (loadVec && queryVec) {
    const scored = candidates
      .map((c) => ({
        key: `${c.source}:${c.id}`,
        // MAX-POOL: score the record by its BEST-matching passage.
        sim: c.vecs.length
          ? Math.max(...c.vecs.map((v) => cosineSim(queryVec, v)))
          : -Infinity,
      }))
      .filter((s) => s.sim > -Infinity)
      .sort((a, b) => b.sim - a.sim);
    cosineOrder = new Map();
    scored.forEach((s, i) => cosineOrder!.set(s.key, i));
  }
  const worstCosine = candidates.length + 1;

  const ranked = candidates.map((c) => {
    const key = `${c.source}:${c.id}`;
    const bm25Rank = c.bm25Order ?? worstBm25;
    let rrf = 1 / (RRF_K + bm25Rank);
    if (cosineOrder) {
      const cRank = cosineOrder.has(key) ? cosineOrder.get(key)! : worstCosine;
      rrf += 1 / (RRF_K + cRank);
    }
    // Relevance (RRF) is primary; importance + recency are bounded multipliers
    // (~[0.7,1.0]) that shape ties without overriding a strong BM25/cosine match.
    const score = rrf * importanceWeightOf(c.importance) * recencyWeight(c.ageDays);
    return {
      id: c.id,
      source: c.source,
      title: c.title,
      snippet: c.snippet,
      score,
      importance: c.importance,
      ageDays: c.ageDays,
    };
  });

  const top = ranked
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score || a.ageDays - b.ageDays)
    .slice(0, limit);

  // Annotate any superseded record that surfaced (only reachable when
  // includeSuperseded is on; expired rows are otherwise excluded upstream).
  if (includeSuperseded && opts.asOf == null) {
    for (const r of top) {
      const table =
        r.source === 'observation'
          ? 'observations'
          : r.source === 'architecture_decision'
            ? 'architecture_decisions'
            : null;
      if (!table) continue;
      try {
        const row = memDb
          .prepare(`SELECT valid_to, superseded_by, expired_at_epoch FROM ${table} WHERE id = ?`)
          .get(r.id) as { valid_to: string | null; superseded_by: number | null; expired_at_epoch: number | null } | undefined;
        if (row && row.expired_at_epoch != null) {
          const when = row.valid_to ? row.valid_to.slice(0, 10) : 'an earlier date';
          const by = row.superseded_by != null ? ` by #${row.superseded_by}` : '';
          r.snippet = `(superseded on ${when}${by}) ${r.snippet}`;
        }
      } catch {
        // annotation is best-effort; never fail recall over it
      }
    }
  }

  return top;
}

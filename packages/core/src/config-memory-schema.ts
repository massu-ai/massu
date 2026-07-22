// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The `memory:` config schema — recall, the semantic embedder, contradiction
 * detection, background consolidation, and the memory-FILE mirror + renderer.
 *
 * Extracted from `config.ts` (Check 21, the 1000-LOC cap). It is a cohesive unit: every
 * knob here governs the memory subsystem, and `config.ts` is a registry of schemas, not
 * the place to grow one of them. Extracting beats adding a `@scanner-allow:large-file`
 * marker — a marker is an exemption, and an exemption is not a fix.
 */
import { z } from 'zod';

export const MemoryConfigSchema = z.object({
  recall: z.object({
    enabled: z.boolean().default(true),
    maxTokens: z.number().int().positive().default(1200),
    sources: z
      .array(
        z.enum([
          'observation',
          'architecture_decision',
          'knowledge_chunk',
          'failure_class',
        ]),
      )
      .default(['observation', 'architecture_decision', 'knowledge_chunk', 'failure_class']),
    timeoutMs: z.number().int().positive().default(8000),
    limit: z.number().int().positive().default(8),
    minScore: z.number().min(0).default(0),
    // --- Semantic embedder (plan-living-memory-slice-2a-embedder, P3-001) ---
    // embedEnabled: Tier-1 bundled WASM embedder on by default; false forces
    //   Tier-2 (FTS keyword-only) recall.
    // embedEndpoint: optional Tier-0 OpenAI-compatible /v1/embeddings provider
    //   (Ollama, LM Studio, vLLM, or any hosted API). When set, embedding egresses ONLY to this
    //   operator-chosen endpoint; unset means zero egress (bundled model).
    // embedModel: optional Tier-0 model name sent to that endpoint.
    embedEnabled: z.boolean().default(true),
    embedEndpoint: z
      .string()
      .url()
      .refine((s) => /^https?:\/\//i.test(s), {
        message: 'memory.recall.embedEndpoint must be an http(s) URL',
      })
      .optional(),
    embedModel: z.string().min(1).optional(),
  }).default({}),
  // --- Contradiction / supersede gate (plan-living-memory-slice-2-temporal-model, P5-001) ---
  // When a new high-value memory (decision/correction) is written, find
  // semantically-related existing records and, if the new one contradicts an
  // old one, supersede-don't-delete the old row. Fully fail-open + gated to a
  // small set of high-value types so the hot capture path is untouched.
  contradiction: z.object({
    // Master switch. false → every write is a plain insert (prior behavior).
    enabled: z.boolean().default(true),
    // Optional Tier-0 external judge (OpenAI-compatible). null/unset → local
    // heuristic only, ZERO egress. When set, candidate + related records egress
    // ONLY to this operator-chosen endpoint; any error falls back to heuristic.
    judgeEndpoint: z
      .string()
      .url()
      .refine((s) => /^https?:\/\//i.test(s), {
        message: 'memory.contradiction.judgeEndpoint must be an http(s) URL',
      })
      .optional(),
    // Cosine similarity above which a correction-flavored new record is treated
    // as superseding a related existing record. Calibrated to all-MiniLM-L6-v2
    // (same-topic contradictions ≈0.65–0.86; related-but-complementary ≈0.47).
    similarityThreshold: z.number().min(0).max(1).default(0.6),
    // Cosine similarity above which a new record is a near-duplicate (NOOP).
    dedupThreshold: z.number().min(0).max(1).default(0.93),
    // Observation types the gate runs for. High-volume 'file_change' is
    // deliberately excluded so the hot path never triggers a hybridSearch.
    gatedTypes: z
      .array(z.string())
      .default(['decision', 'cr_violation', 'failed_attempt']),
    // When true, superseded rows may still surface in recall with a
    // "(superseded on <date> by #<id>)" annotation instead of being excluded.
    annotateSuperseded: z.boolean().default(false),
    // Time budget (ms) for the contradiction check; exceeded → fail-open (ADD).
    budgetMs: z.number().int().positive().default(800),
  }).default({}),

  // --- Background consolidation, the "sleep-time" pass
  //     (plan-living-memory-slice-3-consolidation) ---
  // Keeps memory sharp over years: dedupes, distills dying sessions into
  // durable lessons, spots corrections you keep repeating, reweights by what
  // actually gets used, and retires dead weight by EXPIRING it (never deleting).
  //
  // Runs with ZERO LLM and ZERO network by default — every stage is arithmetic
  // plus the embedding model Massu already bundles. `llmEndpoint` is OPTIONAL
  // and upgrades the prose of session summaries ONLY.
  consolidation: z.object({
    enabled: z.boolean().default(true),
    // Bounded sweep at session end — the automatic path (no scheduler needed).
    sessionSweepEnabled: z.boolean().default(true),
    // OPTIONAL local/remote OpenAI-compatible chat endpoint. UNSET = zero egress.
    // When set, session text egresses ONLY to this endpoint you chose.
    // NOTE: the API key is NEVER configured here — it is read exclusively from
    // the MASSU_MEMORY_LLM_API_KEY env var, so a key can never be committed.
    llmEndpoint: z
      .string()
      .url()
      .refine((s) => /^https?:\/\//i.test(s), {
        message: 'memory.consolidation.llmEndpoint must be an http(s) URL',
      })
      .optional(),
    // Model NAME/ALIAS sent to llmEndpoint (e.g. "llama3.1:8b").
    llmModel: z.string().optional(),
    // Distill a session once its newest turn is older than this. Must stay
    // INSIDE the 7-day conversation_turns prune window or the raw material is
    // destroyed before it is ever summarized.
    summarizeAfterDays: z.number().int().positive().default(5),
    // Age past which an unprotected, never-retrieved, low-importance row may expire.
    retentionDays: z.number().int().positive().default(90),
    importanceFloor: z.number().int().min(1).max(5).default(2),
    // Types that may NEVER expire, however old.
    protectedTypes: z
      .array(z.string())
      .default(['decision', 'cr_violation', 'incident_near_miss']),
    // Days the retrieval counter must observe usage BEFORE any expiry is armed.
    // The cold-start guard: on a fresh counter nothing has "ever been
    // retrieved", so without this the first pass would gut the store.
    usageWarmupDays: z.number().int().nonnegative().default(30),
    // Per-pass decay on the windowed hit count, so usefulness must be sustained.
    usageDecay: z.number().min(0).max(1).default(0.9),
    // A record is reweighted at most once per this many days (idempotency).
    reweightIntervalDays: z.number().int().positive().default(1),
    // Recurrences (across >= 2 sessions) before a rule candidate is proposed.
    promoteMinOccurrences: z.number().int().positive().default(3),
    budgetMs: z.number().int().positive().default(3000),
    // Surface optional upgrades (e.g. "a local model was detected") in chat.
    suggestUpgrades: z.boolean().default(true),
    suggestIntervalDays: z.number().int().positive().default(30),
  }).default({}),

  // A-20 (Slice 4) — memory FILES: the mirror, and the one switch that decides whether
  // Massu may ever WRITE into the user's memory directory.
  //
  // ⛔ `renderEnabled` DEFAULTS TO FALSE. 4B is the first capability in Massu's history
  // that writes files into the place the user keeps their own hand-written prose. A new
  // write capability that arrives switched-on in an `npm update` is a capability nobody
  // consented to. The path is: the advisor OFFERS it in chat -> the user runs
  // `massu memory render --dry-run` and sees exactly what WOULD be written -> the user
  // turns it on. Three deliberate steps, none implicit. A drift-guard pins this default.
  files: z.object({
    // The lossless file<->store mirror (ingest side). Read-only; it writes nothing.
    enabled: z.boolean().default(true),
    // The ONLY flag here that grants a WRITE. Never auto-enable.
    renderEnabled: z.boolean().default(false),
    // Anti-spam: files Massu may render in ONE session.
    renderMaxFilesPerSession: z.number().int().min(0).default(3),
    // Only memories at/above this importance are worth a durable file.
    renderMinImportance: z.number().int().min(1).max(5).default(4),
    // The clearly-labelled MEMORY.md section Massu's pointers live under.
    indexSection: z.string().default('Learned by Massu'),
    // Hard bound on the managed MEMORY.md region. MEMORY.md is auto-loaded into EVERY
    // turn of EVERY session, so an unbounded index is a permanent context tax — and the
    // per-session cap bounds only the RATE, never the total.
    indexMaxLines: z.number().int().min(1).default(50),
  }).default({}),

  // --- Cross-repo memory surfacing (plan-living-memory-slice-5-cross-repo-surfacing) ---
  // A decision made in one of your repos can surface in another — opt-in per
  // decision AND opt-in per repo, signed, verified, and materialized ONLY on
  // explicit human acceptance. Local transport is FREE and zero-network.
  //
  // ⛔ BOTH switches default OFF, and OFF means NOTHING EXISTS — no registry, no
  // keys, no inbox, no behavioural difference. Two INDEPENDENT opt-ins:
  //   • enabled   — may this repo EXPORT its shareable decisions? (opt-in #1)
  //   • subscribe — which repo LABELS may this repo IMPORT from? (opt-in #2)
  // `subscribe: []` means import NOTHING. There is deliberately NO `subscribe: all`
  // — a repo you never named is a repo Massu never reads from.
  share: z.object({
    enabled: z.boolean().default(false),
    subscribe: z.array(z.string()).default([]),
    // C-04 — recall surfacing of cross-repo memories. `enabled` defaults true but is
    // CONDITIONAL on `subscribe` being non-empty (empty by default), so the effective
    // default is DORMANT: with `subscribe: []` the recall hook output is byte-identical
    // to today's. `maxCrossRepoItems` caps how many accepted cross-repo items may appear
    // per recall block (default 1); `minScore` is an OPTIONAL strictly-higher floor for
    // cross-repo items (they are, by construction, less relevant than local ones).
    recall: z.object({
      enabled: z.boolean().default(true),
      maxCrossRepoItems: z.number().int().min(0).default(1),
      minScore: z.number().optional(),
    }).default({}),
  }).default({}),
}).optional();

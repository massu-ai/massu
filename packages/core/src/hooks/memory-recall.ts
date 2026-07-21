#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-001 (plan-living-memory-slice-1): memory-recall UserPromptSubmit hook.
//
// On every user prompt: embed the prompt (WASM embedder — null → FTS-only),
// run hybrid search across observations + architecture_decisions +
// knowledge_chunks + failure_classes, and inject a compact "🧠 Relevant
// memory" block (≤ maxTokens) to stdout.
//
// FAIL-OPEN EVERYWHERE: on ANY error, timeout, or empty result, write nothing
// and exit 0. Reads the PREBUILT store (no live MCP server dependency).
// ============================================================

import { getMemoryDb, recordRecallHits } from '../memory-db.ts';
import { getResolvedPaths, getConfig } from '../config.ts';
import { hybridSearch, type HybridSource } from '../memory-hybrid-search.ts';
import { formatRecallBlock, selectRecallItems } from '../memory-recall-format.ts';
import { embed, getActiveEmbedModel } from '../memory-embedder.ts';
import { writeHookMessage } from './lib/write-hook-message.ts';
import { existsSync } from 'fs';
import type Database from 'better-sqlite3';
import { openDatabase } from '../lib/sqlite-loader.ts';
import { recordHookFailure } from './lib/hook-failure-signal.ts';

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
}

interface RecallConfig {
  enabled: boolean;
  maxTokens: number;
  sources: HybridSource[];
  timeoutMs: number;
  limit: number;
  minScore: number;
  // Semantic embedder mirror (plan-living-memory-slice-2a-embedder, P3-001).
  // The embedder itself reads these from getConfig(); mirrored here so the
  // hook's config view is complete and non-lossy.
  embedEnabled: boolean;
  embedEndpoint?: string;
  embedModel?: string;
}

const DEFAULTS: RecallConfig = {
  enabled: true,
  maxTokens: 1200,
  sources: ['observation', 'architecture_decision', 'knowledge_chunk', 'failure_class'],
  timeoutMs: 8000,
  limit: 8,
  minScore: 0,
  embedEnabled: true,
};

function loadRecallConfig(): RecallConfig {
  try {
    const r = getConfig().memory?.recall as
      | (Partial<RecallConfig> & { sources?: unknown })
      | undefined;
    if (!r) return DEFAULTS;
    return {
      enabled: r.enabled ?? DEFAULTS.enabled,
      maxTokens: r.maxTokens ?? DEFAULTS.maxTokens,
      sources: (r.sources as HybridSource[]) ?? DEFAULTS.sources,
      timeoutMs: r.timeoutMs ?? DEFAULTS.timeoutMs,
      limit: r.limit ?? DEFAULTS.limit,
      minScore: r.minScore ?? DEFAULTS.minScore,
      embedEnabled: r.embedEnabled ?? DEFAULTS.embedEnabled,
      embedEndpoint: r.embedEndpoint,
      embedModel: r.embedModel,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Race a promise against a timeout; resolves to null on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((res) => setTimeout(() => res(null), ms)),
  ]);
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    if (!input.trim()) return void process.exit(0);

    let hookInput: HookInput;
    try {
      hookInput = JSON.parse(input) as HookInput;
    } catch {
      return void process.exit(0);
    }

    const prompt = (hookInput.prompt ?? '').trim();
    if (!prompt) return void process.exit(0);

    const cfg = loadRecallConfig();
    if (!cfg.enabled) return void process.exit(0);

    // Whole-hook hard budget: never approach the 30s UserPromptSubmit limit.
    const block = await withTimeout(
      computeRecall(prompt, cfg, hookInput.session_id),
      cfg.timeoutMs,
    );
    if (block && block.trim()) {
      // Emit via the standard hook-message helper (P-M-004 stdout convention);
      // session-start is the sole raw-stdout hook.
      writeHookMessage(block);
    }
  } catch {
    // Fail-open: write nothing.
  } finally {
    process.exit(0);
  }
}

async function computeRecall(
  prompt: string,
  cfg: RecallConfig,
  sessionId?: string,
): Promise<string> {
  let memDb: Database.Database | null = null;
  let knowledgeDb: Database.Database | null = null;
  try {
    // Embed the prompt (null → FTS-only ranking). Give the embed its own
    // budget so a slow model never eats the whole hook budget.
    const queryVec = await withTimeout(embed(prompt), Math.min(cfg.timeoutMs - 500, 6000)).catch(
      () => null,
    );

    memDb = getMemoryDb();

    const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
    if (cfg.sources.includes('knowledge_chunk') && existsSync(knowledgeDbPath)) {
      try {
        knowledgeDb = openDatabase(knowledgeDbPath, { readonly: true, selfHeal: false });
      } catch {
        knowledgeDb = null;
      }
    }

    // GAP-001: tag the query with the SAME (model_id, dim) the capture path
    // used to store rows — read from getActiveEmbedModel() (the single source
    // both paths share) rather than static constants, so a Tier-0 endpoint or a
    // model-id change can never make the query filter miss every stored row.
    const active = queryVec ? getActiveEmbedModel() : null;

    // Time-aware recall (plan-living-memory-slice-2-temporal-model): by default
    // superseded/expired records are excluded so recall never presents a stale
    // fact as current. The operator can opt to keep them visible (annotated
    // "(superseded on <date> by #<id>)") via memory.contradiction.annotateSuperseded.
    let annotateSuperseded = false;
    try {
      annotateSuperseded =
        (getConfig().memory?.contradiction as { annotateSuperseded?: boolean } | undefined)
          ?.annotateSuperseded === true;
    } catch {
      annotateSuperseded = false;
    }
    const results = hybridSearch(memDb, knowledgeDb, {
      queryText: prompt,
      queryVec: queryVec ?? null,
      modelId: active?.modelId ?? null,
      dim: active?.dim ?? null,
      sources: cfg.sources,
      limit: cfg.limit,
      minScore: cfg.minScore,
      includeSuperseded: annotateSuperseded,
    });

    // Which records actually fit the budget — i.e. what the model really sees.
    const shown = selectRecallItems(results, { maxTokens: cfg.maxTokens });

    // P4-002 (plan-living-memory-slice-3): record that these memories earned
    // their place in context. This is the signal the consolidation pass uses to
    // promote what keeps proving useful and to expire what never does — so it
    // counts ONLY what was shown, never the full candidate set.
    //
    // In its OWN try/catch, and deliberately last: the hook's contract is
    // fail-open, so a counter failure must degrade to "we lost one hit", never
    // to a blank recall block.
    if (sessionId) {
      try {
        recordRecallHits(
          memDb,
          sessionId,
          shown.map((r) => ({ source: r.source, id: r.id })),
        );
      } catch {
        // Best-effort: never let the counter cost the user their recall.
      }
    }

    return formatRecallBlock(shown, { maxTokens: cfg.maxTokens });
  } catch (err) {
    // G-2: this returned '' on ANY failure — so a broken recall engine rendered
    // EXACTLY like a session with nothing worth recalling. That is the whole bug
    // class (M2: failure silently becomes "no data"). It still returns '' (recall
    // must never block the turn), but it is no longer SILENT about it.
    recordHookFailure('memory-recall', err);
    return '';
  } finally {
    try {
      knowledgeDb?.close();
    } catch {
      /* ignore */
    }
    try {
      memDb?.close();
    } catch {
      /* ignore */
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    // Bounded read: never hang if stdin stays open.
    setTimeout(() => resolve(data), 3000);
  });
}

main();

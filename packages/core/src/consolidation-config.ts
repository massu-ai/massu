// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Consolidation config — the SINGLE source of truth for the retention +
// consolidation policy (P6-002, plan-living-memory-slice-3-consolidation).
//
// This lives in its own tiny module (rather than inside memory-consolidate.ts)
// for two reasons:
//   1. `server.ts` needs the retention policy at STARTUP. If it had to import
//      the engine it would drag in the embedder on every server boot.
//   2. ONE definition of the defaults. The startup prune and the consolidation
//      pass MUST expire on the same policy — two copies of `90` in two files
//      is the dual-source-of-truth bug class (the startup path silently
//      expiring on a different rule than the scheduled pass).
// ============================================================

import { getConfig } from './config.ts';

export interface ConsolidationConfig {
  /** Master switch for the consolidation pass. */
  enabled: boolean;
  /** Run a bounded sweep at session end (the path a downloader gets for free). */
  sessionSweepEnabled: boolean;
  /**
   * OPTIONAL OpenAI-compatible chat endpoint. UNSET BY DEFAULT.
   * It upgrades the prose of session summaries ONLY. Everything else in the
   * pass is arithmetic. Unset / unreachable / 401 => extractive summaries and
   * the pass completes exactly as before. The API key is NEVER read from
   * config — only from the MASSU_MEMORY_LLM_API_KEY env var.
   */
  llmEndpoint?: string;
  /** Model name/alias sent to llmEndpoint (never a physical model id). */
  llmModel?: string;
  /** Summarize a session once its newest turn is older than this (days). */
  summarizeAfterDays: number;
  /** Age past which an unprotected, unused, low-importance row may expire. */
  retentionDays: number;
  /** Only rows at or below this importance may expire. */
  importanceFloor: number;
  /** Observation types that may NEVER expire. */
  protectedTypes: string[];
  /**
   * Days the retrieval counter must have been observing before ANY expiry is
   * permitted. The cold-start guard: without it, the first run after upgrade
   * sees a store where nothing has ever been retrieved (because the counter is
   * brand new) and would expire nearly everything.
   */
  usageWarmupDays: number;
  /** Per-pass decay applied to hits_windowed, so usefulness must be sustained. */
  usageDecay: number;
  /** A record may be reweighted at most once per this many days (idempotency). */
  reweightIntervalDays: number;
  /** Recurrences (across >= 2 sessions) needed to propose a rule candidate. */
  promoteMinOccurrences: number;
  /** Wall-clock budget for the bounded session-end sweep. */
  budgetMs: number;
  /** Surface optional-capability upgrades (e.g. a detected local model) in chat. */
  suggestUpgrades: boolean;
  /** Minimum days between repeat upgrade suggestions. */
  suggestIntervalDays: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  enabled: true,
  sessionSweepEnabled: true,
  // llmEndpoint / llmModel deliberately UNSET: the shipped default is
  // zero-LLM, zero-network, works offline on any machine.
  summarizeAfterDays: 5, // inside the 7-day conversation_turns prune window
  retentionDays: 90,
  importanceFloor: 2,
  protectedTypes: ['decision', 'cr_violation', 'incident_near_miss'],
  usageWarmupDays: 30,
  usageDecay: 0.9,
  reweightIntervalDays: 1,
  promoteMinOccurrences: 3,
  budgetMs: 3000,
  suggestUpgrades: true,
  suggestIntervalDays: 30,
};

/**
 * Resolve the effective consolidation config. Fail-open: any missing field
 * falls back to its default, and a broken config never breaks server startup.
 */
export function resolveConsolidationConfig(): ConsolidationConfig {
  try {
    const c = getConfig().memory?.consolidation as Partial<ConsolidationConfig> | undefined;
    if (!c) return { ...DEFAULT_CONSOLIDATION_CONFIG };
    return { ...DEFAULT_CONSOLIDATION_CONFIG, ...c };
  } catch {
    return { ...DEFAULT_CONSOLIDATION_CONFIG };
  }
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { getConfig } from './config.ts';
import {
  enqueueSyncPayload,
  dequeuePendingSync,
  removePendingSync,
  incrementRetryCount,
} from './memory-db.ts';
import { classifyVisibility } from './observation-extractor.ts';

// ============================================================
// Cloud Sync Module
// Internal module — NOT an MCP tool. Called by session-end hook.
// ============================================================

export interface SyncPayload {
  sessions?: Array<{
    local_session_id: string;
    project_name?: string;
    summary?: string;
    started_at?: string;
    ended_at?: string;
    turns?: number;
    tokens_used?: number;
    estimated_cost?: number;
    tools_used?: string[];
  }>;
  observations?: Array<{
    local_observation_id: string;
    session_id?: string;
    type: string;
    content: string;
    importance: number;
    file_path?: string;
  }>;
  analytics?: Array<{
    event_type: string;
    event_data: Record<string, unknown>;
  }>;
  audit?: Array<{
    action: string;
    resource?: string;
    details: Record<string, unknown>;
  }>;
  // PB-006 (plan-2026-05-28-team-shared-rule-promotion): team-shared rule
  // promotions / revocations drained from the outbound stores at session end.
  // The server `/sync` ingest (ingestRulePromotions/ingestRuleRevocations)
  // server-attests `promoted_by` from the authenticated key — the client cannot
  // claim authorship. `content_hash` drives server-side dedup.
  rule_promotions?: Array<{
    prompt_hash: string;
    destination: string;
    draft_text: string;
    score?: number;
    signals?: unknown[];
    content_hash: string;
  }>;
  rule_revocations?: Array<{
    prompt_hash: string;
  }>;
}

export interface SyncResult {
  success: boolean;
  synced: {
    sessions: number;
    observations: number;
    analytics: number;
    audit: number;
  };
  error?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

// P-H003 (plan-stage-c-high-batch): bound each HTTP request so offline
// customers don't burn the entire Stop-hook 15s budget on a single
// unreachable endpoint. Default 2_000ms is well under hook timeout while
// still tolerating typical latency. Override via config.cloud.requestTimeoutMs.
const DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 2_000;

/**
 * Sync data to the cloud endpoint.
 * Respects config flags for selective sync.
 * On failure after retries, enqueues payload for later retry.
 */
export async function syncToCloud(
  db: Database.Database,
  payload: SyncPayload
): Promise<SyncResult> {
  const config = getConfig();
  const cloud = config.cloud;

  // Check if cloud sync is enabled
  if (!cloud?.enabled) {
    return { success: true, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 } };
  }

  // Check API key
  if (!cloud.apiKey) {
    return { success: false, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 }, error: 'No API key configured' };
  }

  // Check endpoint
  const endpoint = cloud.endpoint;
  if (!endpoint) {
    return { success: false, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 }, error: 'No sync endpoint configured' };
  }

  // Apply selective sync filters
  const filteredPayload: SyncPayload = {};
  if (cloud.sync?.memory !== false) {
    filteredPayload.sessions = payload.sessions;
    // P-H020 (plan-stage-c-high-batch): consume classifyVisibility() to drop
    // observations whose title/detail matches PRIVATE_PATTERNS (Stripe keys,
    // env var names, file paths, Bearer tokens, etc.). Pre-fix: cloud-sync
    // transmitted EVERY observation to Massu's Supabase, leaking customer
    // secrets and absolute file paths.
    if (payload.observations) {
      let droppedPrivate = 0;
      filteredPayload.observations = payload.observations.filter((obs) => {
        if (classifyVisibility(obs.content ?? '', obs.content ?? '') === 'private') {
          droppedPrivate += 1;
          return false;
        }
        // Belt-and-suspenders: also drop if file_path matches private patterns.
        if (obs.file_path && classifyVisibility(obs.file_path, obs.file_path) === 'private') {
          droppedPrivate += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivate > 0) {
        // Surface to the customer's stderr so they can audit what got filtered.
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivate} private observation(s) (PRIVATE_PATTERNS match)\n`,
        );
      }
    }
  }
  if (cloud.sync?.analytics !== false) {
    filteredPayload.analytics = payload.analytics;
  }
  if (cloud.sync?.audit !== false) {
    filteredPayload.audit = payload.audit;
  }
  // PB-006: team-shared rule promotions/revocations ride the memory channel
  // (learning data). The server enforces the Team plan-gate + H1 destination
  // allowlist + size cap on ingest. Defense-in-depth (security review LOW,
  // 2026-05-31): run each promotion's draft_text through the SAME
  // classifyVisibility private-pattern filter applied to observations above, so
  // a rule body that happens to contain a secret / token / absolute path is
  // dropped before transmission rather than shared cross-seat.
  if (cloud.sync?.memory !== false) {
    if (payload.rule_promotions?.length) {
      let droppedPrivatePromos = 0;
      const safePromos = payload.rule_promotions.filter((p) => {
        if (classifyVisibility(p.draft_text ?? '', p.draft_text ?? '') === 'private') {
          droppedPrivatePromos += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivatePromos > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivatePromos} team rule promotion(s) (PRIVATE_PATTERNS match in draft_text)\n`,
        );
      }
      if (safePromos.length) filteredPayload.rule_promotions = safePromos;
    }
    if (payload.rule_revocations?.length) filteredPayload.rule_revocations = payload.rule_revocations;
  }

  // Attempt sync with retry
  let lastError = '';
  const requestTimeoutMs = (cloud as { requestTimeoutMs?: number }).requestTimeoutMs
    ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cloud.apiKey}`,
        },
        body: JSON.stringify(filteredPayload),
        // P-H003: bounded request — AbortSignal.timeout fires AbortError when
        // the request stalls (DNS failure, TCP unreachable, slow server). Cleans
        // up before hook timeout kills the whole process.
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        if (response.status >= 400 && response.status < 500) {
          // Client errors are not retryable
          break;
        }
        // Server errors — retry
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        break;
      }

      const result = await response.json() as { synced?: { sessions?: number; observations?: number; analytics?: number } };
      return {
        success: true,
        synced: {
          sessions: result.synced?.sessions ?? 0,
          observations: result.synced?.observations ?? 0,
          analytics: result.synced?.analytics ?? 0,
          audit: 0,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // P-H003: AbortError from AbortSignal.timeout means the request stalled
      // (customer offline / DNS failure / unreachable). Don't burn the remaining
      // hook budget retrying; queue for later and bail.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        break;
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
    }
  }

  // All retries exhausted — enqueue for later
  try {
    enqueueSyncPayload(db, JSON.stringify(payload));
  } catch (_e) {
    // Best effort — don't crash if queue fails
  }

  return {
    success: false,
    synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 },
    error: lastError,
  };
}

/**
 * Drain the pending sync queue. Processes items oldest-first.
 * Successfully synced items are removed; failed items get their retry count incremented.
 */
export async function drainSyncQueue(db: Database.Database): Promise<void> {
  const config = getConfig();
  if (!config.cloud?.enabled || !config.cloud?.apiKey) return;

  const pending = dequeuePendingSync(db, 10);
  for (const item of pending) {
    try {
      const payload = JSON.parse(item.payload) as SyncPayload;
      const result = await syncToCloud(db, payload);
      if (result.success) {
        removePendingSync(db, item.id);
      } else {
        incrementRetryCount(db, item.id, result.error ?? 'Unknown error');
      }
    } catch (err) {
      incrementRetryCount(db, item.id, err instanceof Error ? err.message : String(err));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
import type { RulePromotionEventType } from './memory-db.ts';
import { stripLearningFromPayload } from './rule-delivery.ts';
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
    /**
     * P1-002a (plan-2026-06-01-auto-learning-analytics-dashboard): the CR-53
     * effectiveness signal (audit_log rule_promoted metadata.recurrence_count)
     * for this rule, attached client-side keyed by prompt_hash. Omitted when no
     * recurrence row exists → server leaves promoted_rules.recurrence_count NULL.
     */
    recurrence_count?: number;
    /** PA3-004: true for a hardened (executable-destination) promotion. */
    hardened?: boolean;
    /** PA3-004: publisher review attestation (server requires it for hardened rows). */
    review_attestation?: unknown;
  }>;
  rule_revocations?: Array<{
    prompt_hash: string;
  }>;
  // P1-002 (plan-2026-06-01-auto-learning-analytics-dashboard): promotion
  // FUNNEL events (proposed/shown/approved/dismissed) drained from the local
  // outbound store at session end. The server `/sync` ingest
  // (ingestRulePromotionEvents) server-attests `user_id`/`org_id` from the
  // authenticated key — the client cannot claim authorship. Team-gated +
  // metadata-only (no draft_text). `event_type` references the single client
  // SoT RulePromotionEventType (memory-db.ts) — the CLIENT-EMITTER surface of the
  // enum drift-guard (P1-004), kept byte-identical to the server allowlist +
  // migration 046 CHECK + dashboard reader. No re-declared literal (CR-46).
  rule_promotion_events?: Array<{
    prompt_hash: string;
    event_type: RulePromotionEventType;
    created_at: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface SyncResult {
  success: boolean;
  /**
   * TRUE only when the payload was actually PUT ON THE WIRE and the server answered
   * 2xx. Distinct from `success`, which is ALSO true when cloud sync is simply
   * DISABLED (nothing attempted, nothing wrong).
   *
   * That conflation is not academic. A learned rule may be deleted only on a
   * confirmed server receipt, and `success: true` from a disabled cloud is not a
   * receipt — it means "we never sent it". Acking on `success` alone deletes every
   * learned rule on a local-only seat at session end. `transmitted` is the only
   * flag an ack may trust.
   */
  transmitted?: boolean;
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

/**
 * Per-request timeout, and the OVERALL DEADLINE for a whole sync attempt.
 *
 * THE BUG THIS REPLACES (measured 2026-07-14, against the live api.massu.ai):
 * the old default was 2_000ms, with a comment asserting it was "well under hook
 * timeout while still tolerating typical latency". Both halves were false, and
 * nobody had ever probed the endpoint to check:
 *
 *     empty payload (auth only) .................  777ms mean
 *     1 session + 50 observations ............... 2018ms mean   <-- OVER the 2s limit
 *
 * Server-side bcrypt `compareSync` alone (cost 12, on every request) eats ~40% of a
 * 2s budget before any work happens. So a perfectly ordinary session payload timed
 * out EVERY TIME, was queued, retried, timed out again, and after 10 retries was
 * DISCARDED. That is not a hypothetical: a single workspace logged three
 * `cloud_sync_giveup` events in one day, all with "aborted due to timeout".
 * Cloud sync had, in practice, never succeeded for a real session.
 *
 * THE SECOND MEASUREMENT (2026-07-20, plan-2026-07-20-cloud-sync-timeout):
 * the 8s default sized for a 50-observation payload was in turn too small for a LARGE
 * accumulated session. massu-internal queued 1003 payloads, each carrying a single
 * 423-observation session, and every one timed out:
 *
 *     423-observation payload (148 KB) .......... 9220ms   <-- OVER the 8s limit
 *
 * On a TimeoutError the loop does NOT retry (an AbortError breaks out), so each drain
 * failed, re-queued, and the queue GREW every session-end until the retry>=10 shredder
 * discarded payloads — 83 `cloud_sync_giveup` events, real data lost. Two config-layer
 * bugs (see config.ts CloudConfigSchema) meant the `cloud.requestTimeoutMs` knob that
 * should have raised this could not be set. Both are fixed; the default is raised too so
 * the fix is universal (a normal large session should sync on the first attempt).
 *
 * The numbers below are sized from those MEASUREMENTS, not from a guess:
 *   - request timeout 15s covers the measured 9.2s 423-observation payload with margin,
 *     and stays inside the 20s deadline. Tunable per-workspace via
 *     `cloud.requestTimeoutMs` (capped at SYNC_DEADLINE_MS).
 *   - an overall 20s DEADLINE, inside the 30s Stop-hook budget declared in
 *     .claude/settings.json. The deadline is what makes this safe: no combination of
 *     retries and backoff can overrun the hook, because every attempt is clamped to
 *     the time actually remaining. Bounding only the per-request timeout (the old
 *     design) leaves total time = retries × timeout + backoff, which is unbounded in
 *     practice as soon as anyone tunes a knob.
 *
 * To re-derive these: run scripts/measure-sync-latency.sh and read the mean. Do not
 * copy a number out of this comment into a plan — re-run it.
 */
const DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const SYNC_DEADLINE_MS = 20_000;
/** Below this much remaining budget, a further attempt cannot plausibly finish. */
const MIN_ATTEMPT_BUDGET_MS = 1_000;

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
    // P1-002: funnel events ride the same memory channel (org-scoped learning
    // analytics). They are metadata-only by construction (the emit sites never
    // attach draft_text), but apply the SAME classifyVisibility private-pattern
    // filter to the stringified metadata as defense-in-depth — a metadata field
    // that somehow contains a secret/token/absolute path is dropped before
    // transmission rather than aggregated cross-seat.
    if (payload.rule_promotion_events?.length) {
      let droppedPrivateEvents = 0;
      const safeEvents = payload.rule_promotion_events.filter((e) => {
        const meta = e.metadata ? JSON.stringify(e.metadata) : '';
        if (meta && classifyVisibility(meta, meta) === 'private') {
          droppedPrivateEvents += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivateEvents > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivateEvents} promotion funnel event(s) (PRIVATE_PATTERNS match in metadata)\n`,
        );
      }
      if (safeEvents.length) filteredPayload.rule_promotion_events = safeEvents;
    }
  }

  // Attempt sync with retry, under an OVERALL DEADLINE.
  //
  // The deadline — not the per-request timeout — is what guarantees we cannot
  // overrun the Stop hook. Each attempt gets the SMALLER of the configured request
  // timeout and the time actually left, so retries + backoff can never sum past the
  // budget no matter how the knobs are tuned.
  let lastError = '';
  const configuredTimeoutMs = (cloud as { requestTimeoutMs?: number }).requestTimeoutMs
    ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS;
  const deadlineAt = Date.now() + SYNC_DEADLINE_MS;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < MIN_ATTEMPT_BUDGET_MS) {
      // Out of budget. Stop cleanly and queue for later — never silently, and never
      // by blowing through the hook timeout (which would kill the process mid-write).
      lastError = lastError || `sync deadline exceeded (${SYNC_DEADLINE_MS}ms)`;
      break;
    }
    const requestTimeoutMs = Math.min(configuredTimeoutMs, remainingMs);
    try {
      // CR-59: `cloud.endpoint` is the API BASE (e.g. https://api.massu.ai/v1);
      // every consumer appends its own path. Session-data sync targets the
      // `/sync` ingest — consistent with validateLicense → `/validate-key` and
      // team-rule-sync → `/promoted-rules`.
      const response = await fetch(`${endpoint}/sync`, {
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
        // THE ONLY place this is ever set. The server received the payload and
        // answered 2xx. This — and nothing else — is a receipt, and a receipt is
        // the sole authority to delete a learned rule.
        transmitted: true,
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

  // All retries exhausted — enqueue for later.
  //
  // LEARNED RULES MUST NOT TRAVEL IN pending_sync: that queue DISCARDS its
  // contents after 10 failed retries, which is exactly how 17 of 18 real rules
  // were destroyed. Rules live in the outbound stores under the lease/ack
  // contract instead, so they are stripped from anything handed to this queue.
  try {
    enqueueSyncPayload(db, JSON.stringify(stripLearningFromPayload(payload)));
  } catch (err) {
    // S-9: non-throwing, but NEVER SILENT. A failure to queue is a failure to
    // deliver, and an empty catch here is the exact idiom that made "broken" and
    // "nothing to do" indistinguishable. The learned rules are unaffected — they
    // were stripped out above and live under the lease/ack contract.
    process.stderr.write(
      `[massu] WARNING: could not queue sync payload for retry: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
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

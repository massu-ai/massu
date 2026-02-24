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
    filteredPayload.observations = payload.observations;
  }
  if (cloud.sync?.analytics !== false) {
    filteredPayload.analytics = payload.analytics;
  }
  if (cloud.sync?.audit !== false) {
    filteredPayload.audit = payload.audit;
  }

  // Attempt sync with retry
  let lastError = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cloud.apiKey}`,
        },
        body: JSON.stringify(filteredPayload),
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

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A refusal that cannot change is never queued, and the queue cannot grow without bound.
 *
 * 2026-11-09: the sync endpoint answered every upload from one machine with
 * `403 {"error":"Sync not available for current plan status"}`. The client commented "client
 * errors are not retryable", broke out of its retry loop — and then QUEUED the payload anyway.
 * Its drain retried the same 10 oldest items, so one repo held 43,503 refused uploads (7.6 GB)
 * and re-sent a ~179 KB payload at the end of every reply, while logging only `HTTP 403: `.
 * The responses below are that server's exact shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../config.ts', async (orig) => {
  const real = await orig<typeof import('../config.ts')>();
  return {
    ...real,
    getConfig: vi.fn(() => ({
      toolPrefix: 'massu',
      cloud: { enabled: true, apiKey: 'ms_live_test', endpoint: 'https://api.example.invalid/v1', sync: { memory: true, analytics: true, audit: true } },
    })),
  };
});

import { initMemorySchema, enqueueSyncPayload, PENDING_SYNC_MAX_ITEMS, dequeuePendingSync, setMemoryMeta } from '../memory-db.ts';
import {
  syncToCloud,
  drainSyncQueue,
  readCloudSyncRefusal,
  cloudSyncRefusalBanner,
  isPermanentSyncStatus,
  CLOUD_SYNC_REFUSAL_KEY,
  CLOUD_SYNC_RECHECK_MS,
} from '../cloud-sync.ts';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const refused = (status: number, error: string) => ({
  ok: false, status, statusText: '',
  text: async () => JSON.stringify({ error }),
  json: async () => ({ error }),
});
const accepted = () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{}', json: async () => ({ synced: { sessions: 1 } }) });
const payload = { sessions: [{ local_session_id: 's1', summary: 'x', ended_at: new Date().toISOString() }] };
const queued = (db: Database.Database) => (db.prepare('SELECT COUNT(*) AS n FROM pending_sync').get() as { n: number }).n;

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
  mockFetch.mockReset();
});
afterEach(() => db.close());

describe('which failures are permanent', () => {
  it('4xx is permanent except 408 and 429; 5xx is not', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isPermanentSyncStatus(s), String(s)).toBe(true);
    for (const s of [408, 429, 500, 502, 503]) expect(isPermanentSyncStatus(s), String(s)).toBe(false);
  });
});

describe('an account-level refusal (the 2026-11-09 403)', () => {
  it('is not queued, keeps the server reason, clears the queue, and pauses sync', async () => {
    for (let i = 0; i < 5; i++) enqueueSyncPayload(db, JSON.stringify(payload));
    mockFetch.mockResolvedValue(refused(403, 'Sync not available for current plan status'));

    const r = await syncToCloud(db, payload);
    expect(r.success).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.error).toBe('HTTP 403: Sync not available for current plan status');
    expect(mockFetch, 'a permanent refusal is not retried').toHaveBeenCalledTimes(1);
    expect(queued(db), 'nothing queued, and the 5 already queued are cleared').toBe(0);

    const ref = readCloudSyncRefusal(db);
    expect(ref?.status).toBe(403);
    expect(ref?.reason).toBe('Sync not available for current plan status');
    expect(cloudSyncRefusalBanner(db)).toContain('Sync not available for current plan status');

    // Paused: the next call sends nothing and queues nothing.
    mockFetch.mockClear();
    const again = await syncToCloud(db, payload);
    expect(again.paused).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(queued(db)).toBe(0);
    expect((await drainSyncQueue(db)).attempted).toBe(0);
  });

  it('after the re-check window one attempt goes through, and success lifts the pause', async () => {
    setMemoryMeta(db, CLOUD_SYNC_REFUSAL_KEY, JSON.stringify({
      status: 403, reason: 'Sync not available for current plan status',
      at: new Date(Date.now() - CLOUD_SYNC_RECHECK_MS - 1000).toISOString(),
    }));
    mockFetch.mockResolvedValue(accepted());
    const r = await syncToCloud(db, payload);
    expect(r.success).toBe(true);
    expect(readCloudSyncRefusal(db), 'the pause is lifted').toBeNull();
    expect(cloudSyncRefusalBanner(db)).toBeNull();
  });
});

describe('temporary failures still queue, within limits', () => {
  it('a 503 is queued and does not pause sync', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' });
    const r = await syncToCloud(db, payload, { deadlineAt: Date.now() + 60_000 });
    expect(r.success).toBe(false);
    expect(r.permanent).toBeFalsy();
    expect(queued(db)).toBe(1);
    expect(readCloudSyncRefusal(db)).toBeNull();
  });

  it('the queue never holds more than PENDING_SYNC_MAX_ITEMS', () => {
    for (let i = 0; i < PENDING_SYNC_MAX_ITEMS + 25; i++) enqueueSyncPayload(db, JSON.stringify({ i }));
    expect(queued(db)).toBe(PENDING_SYNC_MAX_ITEMS);
  });

  it('items older than the age limit are dropped on the next enqueue', () => {
    enqueueSyncPayload(db, JSON.stringify({ old: true }));
    db.prepare(`UPDATE pending_sync SET created_at = datetime('now', '-40 days')`).run();
    enqueueSyncPayload(db, JSON.stringify({ fresh: true }));
    const rows = db.prepare('SELECT payload FROM pending_sync').all() as Array<{ payload: string }>;
    expect(rows.map((r) => r.payload)).toEqual([JSON.stringify({ fresh: true })]);
  });

  it('the drain takes the least-retried items first, so new items are not starved', () => {
    for (let i = 0; i < 12; i++) enqueueSyncPayload(db, JSON.stringify({ i }));
    db.prepare('UPDATE pending_sync SET retry_count = 5 WHERE id <= 10').run();
    const next = dequeuePendingSync(db, 2).map((r) => JSON.parse(r.payload).i);
    expect(next).toEqual([10, 11]);
  });
});

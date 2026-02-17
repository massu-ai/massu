// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { syncToCloud, drainSyncQueue } from '../cloud-sync.ts';
import type { SyncPayload } from '../cloud-sync.ts';
import {
  enqueueSyncPayload,
  dequeuePendingSync,
  removePendingSync,
  incrementRetryCount,
} from '../memory-db.ts';

// Mock getConfig
vi.mock('../config.ts', () => ({
  getConfig: vi.fn(() => ({
    cloud: {
      enabled: true,
      apiKey: 'ms_live_test_key_12345',
      endpoint: 'https://test.supabase.co/functions/v1/sync',
      sync: { memory: true, analytics: true, audit: true },
    },
    toolPrefix: 'massu',
    project: { name: 'test', root: '/tmp/test' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: {} },
    domains: [],
    rules: [],
  })),
  getProjectRoot: vi.fn(() => '/tmp/test'),
  getResolvedPaths: vi.fn(() => ({
    memoryDbPath: ':memory:',
    codegraphDbPath: ':memory:',
    dataDbPath: ':memory:',
    srcDir: '/tmp/test/src',
    pathAlias: {},
    extensions: ['.ts'],
    indexFiles: ['index.ts'],
    patternsDir: '/tmp/.claude/patterns',
    claudeMdPath: '/tmp/.claude/CLAUDE.md',
    docsMapPath: '/tmp/.massu/docs-map.json',
    helpSitePath: '/tmp/test-help',
    prismaSchemaPath: '/tmp/prisma/schema.prisma',
    rootRouterPath: '/tmp/src/server/api/root.ts',
    routersDir: '/tmp/src/server/api/routers',
  })),
  resetConfig: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  return db;
}

describe('cloud-sync', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    mockFetch.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  const testPayload: SyncPayload = {
    sessions: [{
      local_session_id: 'test-session-1',
      summary: 'Test session',
      ended_at: new Date().toISOString(),
    }],
    observations: [{
      local_observation_id: 'obs-1',
      type: 'decision',
      content: 'Test observation',
      importance: 3,
    }],
  };

  describe('syncToCloud', () => {
    it('should return no-op when cloud is disabled', async () => {
      const { getConfig } = await import('../config.ts');
      vi.mocked(getConfig).mockReturnValueOnce({
        cloud: { enabled: false },
        toolPrefix: 'massu',
        project: { name: 'test', root: '/tmp' },
        framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
        paths: { source: 'src', aliases: {} },
        domains: [],
        rules: [],
      });

      const result = await syncToCloud(db, testPayload);
      expect(result.success).toBe(true);
      expect(result.synced.sessions).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return error when API key is missing', async () => {
      const { getConfig } = await import('../config.ts');
      vi.mocked(getConfig).mockReturnValueOnce({
        cloud: { enabled: true },
        toolPrefix: 'massu',
        project: { name: 'test', root: '/tmp' },
        framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
        paths: { source: 'src', aliases: {} },
        domains: [],
        rules: [],
      });

      const result = await syncToCloud(db, testPayload);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No API key configured');
    });

    it('should POST payload to endpoint on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ synced: { sessions: 1, observations: 1, analytics: 0 } }),
      });

      const result = await syncToCloud(db, testPayload);

      expect(result.success).toBe(true);
      expect(result.synced.sessions).toBe(1);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.supabase.co/functions/v1/sync',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer ms_live_test_key_12345',
          }),
        }),
      );
    });

    it('should enqueue payload after retry failures', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await syncToCloud(db, testPayload);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');

      // Verify payload was enqueued
      const pending = dequeuePendingSync(db, 10);
      expect(pending.length).toBe(1);
      const enqueuedPayload = JSON.parse(pending[0].payload);
      expect(enqueuedPayload.sessions).toHaveLength(1);
    });

    it('should not retry on 4xx client errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await syncToCloud(db, testPayload);

      expect(result.success).toBe(false);
      // Should only call once (no retry on client errors)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should filter payload based on sync config', async () => {
      const { getConfig } = await import('../config.ts');
      vi.mocked(getConfig).mockReturnValueOnce({
        cloud: {
          enabled: true,
          apiKey: 'ms_live_key',
          endpoint: 'https://test.supabase.co/functions/v1/sync',
          sync: { memory: true, analytics: false, audit: false },
        },
        toolPrefix: 'massu',
        project: { name: 'test', root: '/tmp' },
        framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
        paths: { source: 'src', aliases: {} },
        domains: [],
        rules: [],
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ synced: { sessions: 1, observations: 0, analytics: 0 } }),
      });

      const payloadWithAll: SyncPayload = {
        ...testPayload,
        analytics: [{ event_type: 'test', event_data: {} }],
        audit: [{ action: 'test', details: {} }],
      };

      await syncToCloud(db, payloadWithAll);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.sessions).toBeDefined();
      expect(sentBody.analytics).toBeUndefined();
      expect(sentBody.audit).toBeUndefined();
    });
  });

  describe('pending_sync queue functions', () => {
    it('should enqueue and dequeue payloads', () => {
      enqueueSyncPayload(db, JSON.stringify(testPayload));
      enqueueSyncPayload(db, JSON.stringify({ sessions: [] }));

      const items = dequeuePendingSync(db, 10);
      expect(items).toHaveLength(2);
      expect(JSON.parse(items[0].payload).sessions).toHaveLength(1);
    });

    it('should remove successfully synced items', () => {
      enqueueSyncPayload(db, JSON.stringify(testPayload));
      const items = dequeuePendingSync(db, 10);
      expect(items).toHaveLength(1);

      removePendingSync(db, items[0].id);
      const remaining = dequeuePendingSync(db, 10);
      expect(remaining).toHaveLength(0);
    });

    it('should increment retry count on failure', () => {
      enqueueSyncPayload(db, JSON.stringify(testPayload));
      const items = dequeuePendingSync(db, 10);

      incrementRetryCount(db, items[0].id, 'Network timeout');

      const updated = dequeuePendingSync(db, 10);
      expect(updated[0].retry_count).toBe(1);
    });

    it('should discard items with retry_count >= 10', () => {
      enqueueSyncPayload(db, JSON.stringify(testPayload));
      const items = dequeuePendingSync(db, 10);

      // Set retry count to 10 manually
      db.prepare('UPDATE pending_sync SET retry_count = 10 WHERE id = ?').run(items[0].id);

      // Next dequeue should discard the stale item
      const remaining = dequeuePendingSync(db, 10);
      expect(remaining).toHaveLength(0);
    });
  });
});

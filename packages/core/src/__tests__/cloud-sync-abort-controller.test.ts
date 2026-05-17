// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H003 (plan-stage-c-high-batch) drift-guard DG-3.
 *
 * Closes the bug-class where `cloud-sync.ts` fired bare `fetch()` without
 * AbortSignal — offline customers hung the entire Stop-hook 15s budget on
 * a single unreachable endpoint, dropping queued observations.
 *
 * Structural fix: `AbortSignal.timeout(requestTimeoutMs)` on every fetch,
 * default 2000ms, configurable via cloud.requestTimeoutMs. AbortError /
 * TimeoutError short-circuits the retry loop (don't burn budget on offline).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { syncToCloud } from '../cloud-sync.ts';
import * as configModule from '../config.ts';
import { initMemorySchema } from '../memory-db.ts';

describe('cloud-sync AbortController (DG-3)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initMemorySchema(db);
    vi.spyOn(configModule, 'getConfig').mockReturnValue({
      project: { name: 'test' },
      framework: { type: 'typescript' },
      paths: { source: 'src' },
      toolPrefix: 'massu',
      cloud: {
        enabled: true,
        apiKey: 'test-key',
        endpoint: 'http://127.0.0.1:1', // unreachable port
        requestTimeoutMs: 200, // tight for test speed
      },
    } as ReturnType<typeof configModule.getConfig>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db) db.close();
  });

  it('aborts a hanging fetch within 1s when the endpoint never responds', async () => {
    // Mock fetch to hang forever — simulates unreachable endpoint.
    // AbortSignal.timeout should fire and reject after requestTimeoutMs.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        const signal = (opts as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('AbortError') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        }
        // Otherwise never resolves
      });
    });

    const start = Date.now();
    const result = await syncToCloud(db, {
      sessions: [{ local_session_id: 'test' }],
    });
    const elapsedMs = Date.now() - start;

    expect(result.success).toBe(false);
    // Single-shot abort + no retry on AbortError → well under 1s
    expect(elapsedMs).toBeLessThan(1_000);
    expect(fetchSpy).toHaveBeenCalled();
    // Verify signal was passed
    const callOpts = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callOpts?.signal).toBeDefined();
  });

  it('passes AbortSignal to every fetch call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ synced: { sessions: 1 } }), { status: 200 }),
    );

    await syncToCloud(db, { sessions: [{ local_session_id: 'test' }] });

    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      const opts = call[1] as RequestInit | undefined;
      expect(opts?.signal).toBeDefined();
    }
  });

  it('respects custom requestTimeoutMs from config', async () => {
    vi.spyOn(configModule, 'getConfig').mockReturnValue({
      project: { name: 'test' },
      framework: { type: 'typescript' },
      paths: { source: 'src' },
      toolPrefix: 'massu',
      cloud: {
        enabled: true,
        apiKey: 'test-key',
        endpoint: 'http://127.0.0.1:1',
        requestTimeoutMs: 50,
      },
    } as ReturnType<typeof configModule.getConfig>);

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        const signal = (opts as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('AbortError') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const start = Date.now();
    const result = await syncToCloud(db, { sessions: [{ local_session_id: 'test' }] });
    const elapsedMs = Date.now() - start;

    expect(result.success).toBe(false);
    // 50ms timeout + abort handling — should be very fast
    expect(elapsedMs).toBeLessThan(500);
  });
});

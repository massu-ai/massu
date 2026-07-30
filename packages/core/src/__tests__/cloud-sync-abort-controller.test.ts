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

  it('aborts a hanging fetch without retrying when the endpoint never responds', async () => {
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

    const result = await syncToCloud(db, {
      sessions: [{ local_session_id: 'test' }],
    });

    expect(result.success).toBe(false);
    // The property the old `elapsedMs < 1000` stood for is SINGLE-SHOT: an
    // AbortError must not be retried. Attempt-counting states that directly and
    // does not depend on how loaded the machine is. It is also stronger — a
    // retry loop that happened to finish inside a second would have passed the
    // wall-clock form and fails this one.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
      });
    });

    // The configured value must reach `AbortSignal.timeout()`. The old
    // `elapsedMs < 500` only inferred this from how fast the call came back,
    // which a busy machine breaks and a hardcoded 400ms would have satisfied
    // just as well. Observing the argument asserts the config knob itself.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const result = await syncToCloud(db, { sessions: [{ local_session_id: 'test' }] });

    expect(result.success).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(50);
    // Single-shot: an AbortError is not retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

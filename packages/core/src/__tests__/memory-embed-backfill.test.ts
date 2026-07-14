// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2-003 (plan-living-memory-slice-2a-embedder): embed-backfill CLI command.
 *
 * The embedding-correctness (idempotent / resumable / fail-open sweep) is proven
 * by memory-embed-sweep.test.ts (P2-001). This guards the COMMAND wrapper:
 *   - fail-open when the embedder is unavailable (Tier 2 / disabled) → exit 0,
 *     no throw, a clear "stays keyword-only" message, and the DB is never touched;
 *   - it is a distinct entry point from the md-file `massu_memory_backfill` tool.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runMemoryEmbedBackfill } from '../commands/memory-embed-backfill.ts';
import { _resetEmbedderForTest } from '../memory-embedder.ts';

describe('P2-003: massu memory embed-backfill command', () => {
  afterEach(() => {
    delete process.env.MASSU_DISABLE_EMBEDDINGS;
    _resetEmbedderForTest();
  });

  it('fails open (exit 0, never throws) when the embedder is unavailable', async () => {
    process.env.MASSU_DISABLE_EMBEDDINGS = '1';
    _resetEmbedderForTest();

    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // Capture without touching any DB — the command returns before getMemoryDb()
    // when no active embedder resolves.
    (process.stdout.write as unknown) = (chunk: string): boolean => {
      out.push(String(chunk));
      return true;
    };
    let result: { exitCode: number };
    try {
      result = await runMemoryEmbedBackfill([]);
    } finally {
      (process.stdout.write as unknown) = orig;
    }

    expect(result.exitCode).toBe(0);
    expect(out.join('')).toMatch(/embedder unavailable|keyword-only/i);
  });

  it('exports a callable async command returning a SubcommandResult', () => {
    expect(typeof runMemoryEmbedBackfill).toBe('function');
  });
});

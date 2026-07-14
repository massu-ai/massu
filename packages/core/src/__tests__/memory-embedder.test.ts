// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-002 / P5-001 (plan-living-memory-slice-2a-embedder) — 3-tier fail-open
 * embedder contract + vector math.
 *
 *   Tier 0 (configured provider): mocked fetch — hit + timeout-fallthrough.
 *   Tier 1 (bundled WASM): real embed, gated behind MASSU_RUN_EMBED_MODEL_TEST=1
 *     so the default suite stays fast; the bundled assets make it network-free.
 *   Tier 2 (FTS floor): embed() → null (disabled / empty). NEVER throws.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  embed,
  embedBatch,
  getActiveEmbedModel,
  EMBED_DIM,
  EMBED_MODEL_ID,
  _resetEmbedderForTest,
} from '../memory-embedder.ts';
import { float32ToBlob, blobToFloat32, l2normalize, cosineSim } from '../memory-vector.ts';
import * as configMod from '../config.ts';

const RUN_MODEL = process.env.MASSU_RUN_EMBED_MODEL_TEST === '1';

function stubRecallConfig(recall: Record<string, unknown>): void {
  vi.spyOn(configMod, 'getConfig').mockReturnValue({
    memory: { recall },
  } as unknown as ReturnType<typeof configMod.getConfig>);
}

describe('P1-002: 3-tier embedder — Tier 2 / fail-open', () => {
  beforeEach(() => {
    _resetEmbedderForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MASSU_DISABLE_EMBEDDINGS;
  });

  it('exposes stable model id + dim (GAP-001: no Xenova/ prefix)', () => {
    expect(EMBED_DIM).toBe(384);
    expect(EMBED_MODEL_ID).toBe('all-MiniLM-L6-v2');
  });

  it('embed() returns null (never throws) when MASSU_DISABLE_EMBEDDINGS=1', async () => {
    process.env.MASSU_DISABLE_EMBEDDINGS = '1';
    _resetEmbedderForTest();
    await expect(embed('hello world')).resolves.toBeNull();
  });

  it('embed() returns null when embedEnabled=false (forces Tier 2)', async () => {
    stubRecallConfig({ embedEnabled: false });
    _resetEmbedderForTest();
    await expect(embed('hello world')).resolves.toBeNull();
  });

  it('embed() returns null for empty / whitespace input', async () => {
    await expect(embed('')).resolves.toBeNull();
    await expect(embed('   ')).resolves.toBeNull();
  });

  it('embedBatch() returns all-null of matching length when disabled', async () => {
    process.env.MASSU_DISABLE_EMBEDDINGS = '1';
    _resetEmbedderForTest();
    const out = await embedBatch(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v === null)).toBe(true);
  });

  it('embedBatch([]) returns []', async () => {
    await expect(embedBatch([])).resolves.toEqual([]);
  });
});

describe('P1-002: Tier 0 — configured provider (mocked fetch)', () => {
  beforeEach(() => {
    _resetEmbedderForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MASSU_DISABLE_EMBEDDINGS;
  });

  it('returns the endpoint vector on a 200, and reports it as the active model', async () => {
    stubRecallConfig({ embedEndpoint: 'http://localhost:11434', embedModel: 'test-embed' });
    const raw = Array.from({ length: 8 }, (_, i) => (i + 1) / 10);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: raw }] }),
    } as unknown as Response);

    const v = await embed('hello');
    expect(v).not.toBeNull();
    expect(v!.length).toBe(8);
    // L2-normalized
    let mag = 0;
    for (const x of v!) mag += x * x;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 4);

    const active = getActiveEmbedModel();
    expect(active).toEqual({ modelId: 'test-embed', dim: 8 });

    // Called the OpenAI-compatible path with {model, input}.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:11434/v1/embeddings');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'test-embed', input: 'hello' });
  });

  it('falls through to Tier 1/2 when the endpoint errors (never throws)', async () => {
    stubRecallConfig({ embedEndpoint: 'http://localhost:9', embedModel: 'x', embedEnabled: true });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    // With MASSU_DISABLE_EMBEDDINGS unset, Tier-1 would try; disable it so this
    // asserts the pure fall-through-to-null contract deterministically.
    process.env.MASSU_DISABLE_EMBEDDINGS = '1';
    _resetEmbedderForTest();
    stubRecallConfig({ embedEndpoint: 'http://localhost:9', embedModel: 'x' });
    await expect(embed('hello')).resolves.toBeNull();
  });

  it('returns null on a malformed endpoint response (no data[0].embedding)', async () => {
    stubRecallConfig({ embedEndpoint: 'http://localhost:11434', embedModel: 'x' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ nope: true }),
    } as unknown as Response);
    process.env.MASSU_DISABLE_EMBEDDINGS = '1'; // block Tier-1 fallthrough for a clean assert
    _resetEmbedderForTest();
    stubRecallConfig({ embedEndpoint: 'http://localhost:11434', embedModel: 'x' });
    await expect(embed('hello')).resolves.toBeNull();
  });
});

describe.runIf(RUN_MODEL)('P1-002: Tier 1 — bundled WASM (real model)', () => {
  beforeEach(() => {
    _resetEmbedderForTest();
    vi.restoreAllMocks(); // use real config → no endpoint → Tier 1
  });

  it('embed() returns a 384-len L2-normalized vector + active model', async () => {
    const v = await embed('the quick brown fox');
    expect(v).not.toBeNull();
    expect(v!.length).toBe(EMBED_DIM);
    let mag = 0;
    for (const x of v!) mag += x * x;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 3);
    expect(getActiveEmbedModel()).toEqual({ modelId: EMBED_MODEL_ID, dim: EMBED_DIM });
  });

  it('paraphrase cosine > unrelated cosine (semantically meaningful)', async () => {
    const [q, para, unrel] = await embedBatch([
      'make login fail fast when there is no terminal',
      'why does massu login hang when I pipe input',
      'quarterly financial report earnings call',
    ]);
    expect(q && para && unrel).toBeTruthy();
    expect(cosineSim(q!, para!)).toBeGreaterThan(cosineSim(q!, unrel!));
  });
});

describe('memory-vector helpers', () => {
  it('float32ToBlob / blobToFloat32 round-trip', () => {
    const v = Float32Array.from([0.1, -0.2, 0.3, 0.4]);
    const blob = float32ToBlob(v);
    const back = blobToFloat32(blob);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect(back![i]).toBeCloseTo(v[i], 5);
  });

  it('blobToFloat32 returns null on non-multiple-of-4 length', () => {
    expect(blobToFloat32(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it('l2normalize produces a unit vector', () => {
    const n = l2normalize(Float32Array.from([3, 4]));
    const mag = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
    expect(mag).toBeCloseTo(1, 5);
  });

  it('l2normalize leaves a zero vector unchanged', () => {
    const n = l2normalize(Float32Array.from([0, 0, 0]));
    expect(Array.from(n)).toEqual([0, 0, 0]);
  });

  it('cosineSim: identical=1, orthogonal=0, opposite=-1', () => {
    expect(cosineSim(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1, 5);
    expect(cosineSim(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
    expect(cosineSim(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1, 5);
  });

  it('cosineSim returns 0 for length mismatch or zero vector', () => {
    expect(cosineSim(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
    expect(cosineSim(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(0);
  });
});

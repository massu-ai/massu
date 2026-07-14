// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P1-002 (plan-living-memory-slice-2a-embedder): 3-tier fail-open text embedder.
//
// CRITICAL INVARIANT: this module must add NO native module to @massu/core.
// This repo has been broken by native-ABI drift twice (incident
// 2026-07-05-node-26-native-module-abi). The embedder therefore uses
// `onnxruntime-web` (verified native-free: pure-JS deps only) + a hand-rolled
// pure-JS WordPiece tokenizer + a BUNDLED int8 ONNX model. NO
// @huggingface/transformers, NO onnxruntime-node, NO sharp — enforced by the
// native-dependency drift-guard (no-native-embedder-dep.test.ts).
//
// The three tiers, each fail-open to the next:
//   Tier 0 — configured provider: fetch {embedEndpoint}/v1/embeddings
//            (OpenAI-compatible; any local server or hosted API). Opt-in only.
//   Tier 1 — bundled pure-WASM (default): onnxruntime-web + WordPiece +
//            bundled all-MiniLM-L6-v2 int8 ONNX (Apache-2.0, 384-dim). Zero
//            egress, zero native module, works offline / air-gapped.
//   Tier 2 — FTS keyword floor: embed() → null → hybrid search degrades to
//            BM25-only ranking (shipped in Slice 1).
//
// embed() / embedBatch() NEVER throw. Any failure at any tier returns null (or
// per-item null). MASSU_DISABLE_EMBEDDINGS=1 forces Tier 2.
// ============================================================

import { l2normalize } from './memory-vector.ts';
import { encode, loadVocab, type Vocab } from './memory-embedder-tokenizer.ts';
import { getConfig } from './config.ts';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';

// Pinned to the stable model string — we bundle the raw ONNX artifact, not a
// hub id, so we drop the `Xenova/` prefix. This is the Tier-1 tag.
export const EMBED_MODEL_ID = 'all-MiniLM-L6-v2';
export const EMBED_DIM = 384;

// Externalized dependency (mirrors better-sqlite3): a real dependency, kept out
// of the esbuild bundle via `--external:onnxruntime-web`, loaded lazily so hooks
// that never embed pay nothing. Specifier held in a variable so esbuild never
// tries to statically resolve it during bundling.
const ORT_PKG = 'onnxruntime-web';

/** The active (model_id, dim) for the tier that embed()/embedBatch() last used. */
export interface ActiveEmbedModel {
  modelId: string;
  dim: number;
}

// Single source of truth for the active tag. Set the instant a tier produces a
// vector, so the recall query and the stored rows always share (model_id, dim).
let _activeModel: ActiveEmbedModel | null = null;

/**
 * The (model_id, dim) that the active embedder tier produces, or null when no
 * embedder has successfully produced a vector this process (or embeddings are
 * disabled). This is the SINGLE source both the capture path (embedMissing*)
 * and the recall query (memory-recall hook) read to tag vectors — so the query
 * filter and the stored rows can never diverge (GAP-001).
 */
export function getActiveEmbedModel(): ActiveEmbedModel | null {
  return _activeModel;
}

interface EmbedSettings {
  enabled: boolean;
  endpoint?: string;
  model?: string;
}

/** Read embed settings from config, fail-open to Tier-1-enabled defaults. */
function loadEmbedSettings(): EmbedSettings {
  try {
    const r = getConfig().memory?.recall as
      | { embedEnabled?: boolean; embedEndpoint?: string; embedModel?: string }
      | undefined;
    return {
      enabled: r?.embedEnabled ?? true,
      endpoint: r?.embedEndpoint,
      model: r?.embedModel,
    };
  } catch {
    return { enabled: true };
  }
}

function embeddingsDisabled(): boolean {
  return process.env.MASSU_DISABLE_EMBEDDINGS === '1';
}

// ============================================================
// Tier 1 — bundled pure-WASM (onnxruntime-web)
// ============================================================

interface OrtTensorCtor {
  new (type: string, data: BigInt64Array, dims: number[]): unknown;
}
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}
interface OrtModule {
  env: { wasm: { numThreads: number; proxy: boolean; wasmPaths: string } };
  Tensor: OrtTensorCtor;
  InferenceSession: { create(path: string, opts: Record<string, unknown>): Promise<OrtSession> };
}

let _sessionPromise: Promise<OrtSession | null> | null = null;
let _vocab: Vocab | null = null;
let _ortTensor: OrtTensorCtor | null = null;

/**
 * Resolve the bundled model asset dir. Walks up from this module's file to the
 * package root (nearest package.json) — robust for BOTH bundle depths
 * (dist/hooks/*.js and dist/cli.js) AND source/test (src/*.ts) — then prefers
 * dist/embedder/ (production, shipped) and falls back to assets/embedder/
 * (source, used in dev/test before build). GAP-003.
 */
function resolveModelDir(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    let root: string | null = null;
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!root) return null;
    for (const rel of ['dist/embedder', 'assets/embedder']) {
      const candidate = join(root, rel);
      if (existsSync(join(candidate, 'model_quantized.onnx'))) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the onnxruntime-web dist dir (holds the ort-wasm-*.wasm files). */
function resolveWasmDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    // require.resolve returns the package main (…/onnxruntime-web/dist/ort.node.*.js)
    const main = req.resolve(ORT_PKG);
    return dirname(main);
  } catch {
    return null;
  }
}

/** Lazily create the ONNX inference session once per process. */
async function getSession(): Promise<OrtSession | null> {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async (): Promise<OrtSession | null> => {
    try {
      const modelDir = resolveModelDir();
      const wasmDir = resolveWasmDir();
      if (!modelDir || !wasmDir) return null;

      // Dynamic, indirected import so esbuild leaves onnxruntime-web external.
      const ort = (await import(/* @vite-ignore */ ORT_PKG)) as unknown as OrtModule;

      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      // Point at the installed dependency's own wasm (NOT a vendored copy).
      ort.env.wasm.wasmPaths = wasmDir.endsWith('/') ? wasmDir : wasmDir + '/';
      _ortTensor = ort.Tensor;

      const modelPath = join(modelDir, 'model_quantized.onnx');
      const vocabPath = join(modelDir, 'vocab.txt');
      _vocab = loadVocab(vocabPath);

      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      return session;
    } catch {
      // Package missing / model absent / wasm load failed → fail-open to null.
      return null;
    }
  })();
  return _sessionPromise;
}

function meanPool(
  hidden: Float32Array,
  mask: number[],
  seqLen: number,
  hiddenSize: number,
): Float32Array {
  const out = new Float32Array(hiddenSize);
  let maskSum = 0;
  for (let t = 0; t < seqLen; t++) {
    const m = mask[t];
    if (m === 0) continue;
    maskSum += m;
    const base = t * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) out[h] += hidden[base + h] * m;
  }
  const denom = Math.max(maskSum, 1e-9);
  for (let h = 0; h < hiddenSize; h++) out[h] /= denom;
  return out;
}

/**
 * A-04 — the embedder TRUNCATES, so long memories must be CHUNKED.
 *
 * `encode()` clamps to 256 WordPiece tokens (`memory-embedder-tokenizer.ts:174`) and
 * the caller never overrides it. So a single vector covers roughly the first ~1,000
 * characters. With the operator's largest memory at 14,408 characters, ~93% of it had
 * NO semantic representation at all: the plan's own acceptance — "a query matching
 * text at the END of a long memory retrieves it" — could never pass with one vector
 * per memory, however the sweep was wired.
 *
 * So: split the text into windows that fit the budget, embed EACH, and max-pool at
 * search time (a memory is as relevant as its most relevant passage).
 *
 * The split is on paragraph/sentence boundaries where possible — cutting mid-sentence
 * degrades the embedding of both halves. CHUNK_OVERLAP_CHARS keeps a fact that
 * straddles a boundary retrievable from both sides.
 */
export const CHUNK_TARGET_CHARS = 900; // ~256 WordPiece tokens for English prose
export const CHUNK_OVERLAP_CHARS = 120;
export const MAX_CHUNKS_PER_RECORD = 24; // bounds the sweep: 24 * 900 ≈ 21K chars

export function chunkForEmbedding(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= CHUNK_TARGET_CHARS) return [t];

  const chunks: string[] = [];
  let start = 0;

  while (start < t.length && chunks.length < MAX_CHUNKS_PER_RECORD) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, t.length);

    if (end < t.length) {
      // Prefer a paragraph break, then a sentence end, then a space — but only if it
      // lands in the back half of the window, so we never emit a sliver.
      const floor = start + Math.floor(CHUNK_TARGET_CHARS / 2);
      const slice = t.slice(start, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const space = slice.lastIndexOf(' ');
      for (const rel of [para, sent, space]) {
        const abs = start + rel;
        if (rel > 0 && abs > floor) {
          end = abs + 1;
          break;
        }
      }
    }

    const chunk = t.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= t.length) break;
    // Overlap backwards so a fact spanning the seam is reachable from both chunks.
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }

  return chunks;
}

/** Tier-1 embed of a single string. Returns null on any failure (never throws). */
async function embedTier1(text: string): Promise<Float32Array | null> {
  try {
    const session = await getSession();
    if (!session || !_vocab || !_ortTensor) return null;
    const { input_ids, attention_mask, token_type_ids } = encode(text, _vocab);
    const seqLen = input_ids.length;
    const ids = BigInt64Array.from(input_ids.map((x) => BigInt(x)));
    const mask = BigInt64Array.from(attention_mask.map((x) => BigInt(x)));
    const types = BigInt64Array.from(token_type_ids.map((x) => BigInt(x)));
    const dims = [1, seqLen];
    const Tensor = _ortTensor;
    const feeds: Record<string, unknown> = {
      input_ids: new Tensor('int64', ids, dims),
      attention_mask: new Tensor('int64', mask, dims),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new Tensor('int64', types, dims);
    }
    const results = await session.run(feeds);
    const outName =
      session.outputNames.find((n) => results[n].dims.length === 3) ?? session.outputNames[0];
    const outTensor = results[outName];
    const hiddenSize = outTensor.dims[2];
    const pooled = meanPool(outTensor.data, attention_mask, seqLen, hiddenSize);
    const vec = l2normalize(pooled);
    if (vec.length !== EMBED_DIM) return null;
    _activeModel = { modelId: EMBED_MODEL_ID, dim: EMBED_DIM };
    return vec;
  } catch {
    return null;
  }
}

// ============================================================
// Tier 0 — configured OpenAI-compatible provider
// ============================================================

const TIER0_TIMEOUT_MS = 2000;

/**
 * Tier-0 embed via a configured OpenAI-compatible /v1/embeddings endpoint.
 * Returns null on any failure (missing endpoint, timeout, malformed response)
 * so the caller falls through to Tier 1.
 */
async function embedTier0(text: string, settings: EmbedSettings): Promise<Float32Array | null> {
  const endpoint = settings.endpoint;
  if (!endpoint) return null;
  const requestModel = settings.model || EMBED_MODEL_ID;
  const base = endpoint.replace(/\/+$/, '');
  const url = `${base}/v1/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIER0_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: requestModel, input: text }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const raw = body?.data?.[0]?.embedding;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const vec = l2normalize(Float32Array.from(raw));
    _activeModel = { modelId: requestModel, dim: vec.length };
    return vec;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// Public API — embed / embedBatch (fail-open at every tier)
// ============================================================

/**
 * Embed a single string. Returns an L2-normalized Float32Array, or null when no
 * tier can produce a vector (recall stays FTS-only). NEVER throws.
 *
 * Resolution order: Tier 0 (if endpoint configured) → Tier 1 (bundled WASM) →
 * null. MASSU_DISABLE_EMBEDDINGS=1 or embedEnabled:false forces null.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!text || !text.trim()) return null;
  if (embeddingsDisabled()) return null;
  try {
    const settings = loadEmbedSettings();
    if (!settings.enabled) return null;
    if (settings.endpoint) {
      const t0 = await embedTier0(text, settings);
      if (t0) return t0;
      // Tier-0 failure falls through to Tier-1.
    }
    return await embedTier1(text);
  } catch {
    return null;
  }
}

/**
 * Embed a batch of strings. Each element is an L2-normalized Float32Array or
 * null (per-item fail-open). NEVER throws.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (!texts || texts.length === 0) return [];
  if (embeddingsDisabled()) return texts.map(() => null);
  const settings = loadEmbedSettings();
  if (!settings.enabled) return texts.map(() => null);

  const results: (Float32Array | null)[] = [];
  for (const t of texts) {
    if (!t || !t.trim()) {
      results.push(null);
      continue;
    }
    try {
      let vec: Float32Array | null = null;
      if (settings.endpoint) {
        vec = await embedTier0(t, settings);
      }
      if (!vec) vec = await embedTier1(t);
      results.push(vec);
    } catch {
      results.push(null);
    }
  }
  return results;
}

/** Test-only: reset the memoized session/vocab/active-model so env/config changes take effect. */
export function _resetEmbedderForTest(): void {
  _sessionPromise = null;
  _vocab = null;
  _ortTensor = null;
  _activeModel = null;
}

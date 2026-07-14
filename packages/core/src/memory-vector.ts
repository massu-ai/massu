// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P1-001 / P1-003 (plan-living-memory-slice-1): vector storage + math.
//
// Embeddings are stored as Float32 little-endian BLOBs in companion tables
// (observation_embeddings / knowledge_chunk_embeddings). These helpers are the
// single place that encodes/decodes those BLOBs and computes similarity, used
// by the hybrid search, the embed-on-capture path, and the backfill CLI.
//
// No native dependency: pure JS over Node Buffers / typed arrays.
// ============================================================

/**
 * Encode a Float32Array as a little-endian Buffer suitable for a SQLite BLOB.
 * Copies the bytes so the returned Buffer is independent of the input's
 * backing ArrayBuffer (important when the input is a subarray/view).
 */
export function float32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
}

/**
 * Decode a SQLite BLOB (Buffer) back into a Float32Array. Returns null if the
 * byte length is not a multiple of 4 (corrupt / wrong-encoding row).
 */
export function blobToFloat32(buf: Buffer | Uint8Array): Float32Array | null {
  if (!buf || buf.byteLength % 4 !== 0) return null;
  // Copy into a fresh, 4-byte-aligned buffer so Float32Array construction is
  // always valid regardless of the source Buffer's byteOffset alignment.
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf);
  return new Float32Array(bytes.buffer, 0, buf.byteLength / 4);
}

/**
 * L2-normalize a vector in place-safe fashion (returns a new array). A
 * zero-vector is returned unchanged (all zeros) to avoid divide-by-zero.
 */
export function l2normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 for length mismatch or a
 * zero-magnitude operand (defensive — callers treat 0 as "no signal").
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0 || !Number.isFinite(denom)) return 0;
  return dot / denom;
}

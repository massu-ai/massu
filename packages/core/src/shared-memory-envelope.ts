// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-envelope.ts — the FLAT, signed cross-repo memory envelope
 * (Living Memory Slice 5, A-05).
 *
 * A cross-repo memory crosses a TRUST BOUNDARY: repo A's decision, authored under
 * repo A's assumptions, travels to repo B. The transit artifact is this envelope.
 * It is Ed25519-signed with the SAME verifier core the license + promotion paths
 * use (`security/ed25519-envelope-verifier.ts`) — one verify code path, so the
 * local transport can never rot into a weaker parallel mechanism.
 *
 * ⚠️ THE FLAT-ENVELOPE LAW (this is the whole reason the shape looks like this):
 * the canonical reconstruction the verifier signs over is
 *   `JSON.stringify(canonicalObj, [...payloadKeys].sort())`
 * — a sorted-KEY-ARRAY replacer, which STRIPS every nested object/array body from
 * the signed bytes. So an array MUST ride as a JSON *string* (`records_json`,
 * `revokes_json`), never as a nested array top-level key. A nested array would
 * leave every record body UNSIGNED and forgeable. This bug has bitten this
 * codebase before (memory `feedback_signed_envelope_nested_array_pitfall`, why
 * `/promoted-rules` carries `promotions_json`). {@link assertFlatSignedEnvelope}
 * turns the law into a runtime assertion; the A-05 drift-guard makes it a test.
 */

import { createHash } from 'crypto';
import type { SignedEnvelopeBase } from './security/ed25519-envelope-verifier.ts';

/** The envelope kind tag. Versioned so a future shape is a NEW kind, not a mutation. */
export const SHARED_MEMORY_KIND = 'massu.shared-memory.v1' as const;

/**
 * The signed top-level keys, in canonical (sorted) order. The signer builds the
 * canonical payload from EXACTLY these keys; the verifier reconstructs from the
 * envelope's own `_signature_payload_keys`. Every one of these is a scalar (string
 * or number) — NONE is an object/array (the flat-envelope law). A load-bearing
 * field NOT in this list would be UNSIGNED (the "unsigned load-bearing field"
 * defence the import path re-checks).
 */
export const SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS: readonly string[] = [
  'issued_at',
  'kind',
  'origin_repo_id',
  'origin_repo_label',
  'records_json',
  'revokes_json',
  'seq',
];

/**
 * ONE record inside `records_json`. `record_hash` is the identity + idempotency
 * key: the sha256 of the record's canonical serialization (see
 * {@link hashSharedMemoryRecord}). `created_at_epoch` is EPOCH SECONDS (the
 * Slice-2 convention — a ms/s mismatch silently breaks every expiry comparison).
 */
export interface SharedMemoryRecord {
  record_hash: string;
  /** ⊂ observations.type CHECK vocabulary (re-validated at accept time, B-05). */
  type: string;
  title: string;
  detail: string;
  importance: number;
  created_at_epoch: number;
  superseded_by_hash: string | null;
}

/** The envelope BODY (the signed fields) before the `_signature*` quartet is added. */
export interface UnsignedSharedMemoryEnvelope {
  kind: typeof SHARED_MEMORY_KIND;
  origin_repo_id: string;
  origin_repo_label: string;
  /** Monotonic per-origin-repo sequence (the import cursor / idempotency, H2). */
  seq: number;
  issued_at: string;
  /** A `SharedMemoryRecord[]` carried as a JSON STRING (the flat-envelope law). */
  records_json: string;
  /** A `string[]` of revoked record_hashes carried as a JSON STRING (the law). */
  revokes_json: string;
}

/** The full signed envelope: the body + the `_signature*` quartet. */
export interface SharedMemoryEnvelope extends UnsignedSharedMemoryEnvelope, SignedEnvelopeBase {
  _signature: string;
  _signature_alg: 'ed25519';
  _signature_payload_keys: readonly string[];
  _signature_pubkey_fingerprint: string;
}

/**
 * The canonical serialization the signature covers, byte-identical to what
 * {@link verifyEd25519SignedEnvelope} reconstructs. Building it HERE (rather than
 * re-deriving it in the signer) means the signer and the envelope module agree by
 * construction; the round-trip through the REAL verifier (A-06 test) proves it.
 *
 * The formula is fixed by the verifier core and MUST NOT drift:
 *   `JSON.stringify(canonicalObj, [...payloadKeys].sort())`.
 */
export function canonicalizeSharedMemoryEnvelope(body: UnsignedSharedMemoryEnvelope): string {
  const keys = SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS;
  const canonicalObj: Record<string, unknown> = {};
  for (const k of keys) {
    canonicalObj[k] = (body as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(canonicalObj, [...keys].sort());
}

/**
 * The stable identity of a record: sha256 over its canonical field serialization.
 * Field order is FIXED here so two repos compute the same hash for the same
 * content (idempotency across the boundary). `record_hash` itself is excluded (a
 * hash cannot cover itself).
 */
export function hashSharedMemoryRecord(record: Omit<SharedMemoryRecord, 'record_hash'>): string {
  const canonical = JSON.stringify({
    created_at_epoch: record.created_at_epoch,
    detail: record.detail,
    importance: record.importance,
    superseded_by_hash: record.superseded_by_hash,
    title: record.title,
    type: record.type,
  });
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Assert the flat-envelope law on a candidate signed envelope: every signed
 * top-level key names a SCALAR (string/number), never an object or array. A
 * violation means a record body would be UNSIGNED (forgeable). Throws with a
 * precise message naming the offending key.
 *
 * This is the runtime teeth behind the A-05 drift-guard: a test that adds a
 * nested-array signed key must FAIL here.
 */
export function assertFlatSignedEnvelope(env: Pick<SharedMemoryEnvelope, '_signature_payload_keys'> & Record<string, unknown>): void {
  const keys = env._signature_payload_keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('assertFlatSignedEnvelope: _signature_payload_keys is missing or empty');
  }
  for (const k of keys) {
    const v = env[k as string];
    const t = typeof v;
    if (v !== null && (t === 'object' || Array.isArray(v))) {
      throw new Error(
        `assertFlatSignedEnvelope: signed key '${String(k)}' holds a ${Array.isArray(v) ? 'array' : 'object'} — ` +
          'the sorted-key-array replacer would STRIP its body from the signed bytes (forgery hole). ' +
          'Carry arrays/objects as a *_json STRING field.',
      );
    }
    if (t !== 'string' && t !== 'number') {
      throw new Error(
        `assertFlatSignedEnvelope: signed key '${String(k)}' has non-scalar type '${t}' — signed keys must be string|number`,
      );
    }
  }
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-05 drift-guard — the FLAT envelope + its forgery test.
 *
 * The one that would have caught the historical bug:
 *  (a) mutate a byte INSIDE records_json → the signature no longer covers it →
 *      the verifier returns `{ kind: 'bad_signature' }`.
 *  (b) NO top-level signed key holds an object or array — an array must ride as a
 *      `*_json` STRING, or the sorted-key-array replacer strips its body from the
 *      signed bytes (forgeable). `assertFlatSignedEnvelope` enforces it, and a test
 *      that adds a nested-array signed key FAILS that assertion.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  signSharedMemoryEnvelope,
  readLocalSharePublicKeyRaw,
  localSharePubkeyFingerprint,
} from '../security/local-share-signer.ts';
import { verifyEd25519SignedEnvelope } from '../security/ed25519-envelope-verifier.ts';
import {
  assertFlatSignedEnvelope,
  SHARED_MEMORY_KIND,
  SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS,
  type SharedMemoryEnvelope,
  type UnsignedSharedMemoryEnvelope,
} from '../shared-memory-envelope.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'massu-a05-home-'));
}
function signedFixture(home: string): SharedMemoryEnvelope {
  const b: UnsignedSharedMemoryEnvelope = {
    kind: SHARED_MEMORY_KIND,
    origin_repo_id: '11111111-2222-4333-8444-555555555555',
    origin_repo_label: 'massu',
    seq: 1,
    issued_at: '2026-07-21T00:00:00.000Z',
    records_json: JSON.stringify([{ record_hash: 'b'.repeat(64), type: 'decision', title: 'never echo for vercel env', detail: 'use printf', importance: 4, created_at_epoch: 1752000000, superseded_by_hash: null }]),
    revokes_json: '[]',
  };
  return signSharedMemoryEnvelope(b, home);
}
function keyFor(home: string) {
  const fp = localSharePubkeyFingerprint(home);
  return { pubkeyBytes: readLocalSharePublicKeyRaw(home), fingerprintHex: fp, knownFingerprints: new Set([fp]), keyLabel: 'local-share' };
}

describe('A-05 shared-memory-envelope drift-guard', () => {
  it('A-05.1: mutating a byte INSIDE records_json yields bad_signature', () => {
    const home = freshHome();
    try {
      const signed = signedFixture(home);
      expect(verifyEd25519SignedEnvelope(keyFor(home), signed)).toEqual({ kind: 'valid' });
      // Flip one character inside the signed records_json string.
      const tampered: SharedMemoryEnvelope = { ...signed, records_json: signed.records_json.replace('printf', 'pryntf') };
      expect(verifyEd25519SignedEnvelope(keyFor(home), tampered)).toEqual({ kind: 'bad_signature' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-05.2: no signed top-level key holds an object or array', () => {
    const home = freshHome();
    try {
      const signed = signedFixture(home);
      // Runtime assertion passes for the real (flat) envelope.
      expect(() => assertFlatSignedEnvelope(signed as unknown as SharedMemoryEnvelope & Record<string, unknown>)).not.toThrow();
      // Each declared signed key is a scalar.
      for (const k of SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS) {
        const v = (signed as Record<string, unknown>)[k];
        expect(v === null || typeof v === 'string' || typeof v === 'number').toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-05.3: a signed key holding a NESTED ARRAY fails the flatness assertion', () => {
    // This is the exact historical forgery hole: a nested array under a signed key
    // would leave its body unsigned. The guard must reject it.
    const forged = {
      _signature_payload_keys: ['kind', 'records'],
      kind: SHARED_MEMORY_KIND,
      records: [{ title: 'unsigned body' }], // ← nested ARRAY under a signed key
    } as unknown as SharedMemoryEnvelope & Record<string, unknown>;
    expect(() => assertFlatSignedEnvelope(forged)).toThrow(/STRIP its body|forgery hole|array/i);
  });
});

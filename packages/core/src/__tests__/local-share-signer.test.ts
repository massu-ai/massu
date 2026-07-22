// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-06 — the local-share signer.
 *
 *  - Round-trips through the REAL verifier core (not a hand-rolled check): a
 *    freshly-signed envelope verifies `{ kind: 'valid' }`.
 *  - Signs BYTE-IDENTICALLY to what the verifier reconstructs, for a payload with
 *    unicode, newlines, and keys inserted out of sorted order.
 *  - Generates the keypair LAZILY on first sign only; a dormant home has no key.
 *  - The private key is written mode 0600.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  signSharedMemoryEnvelope,
  ensureLocalShareKeypair,
  readLocalSharePublicKeyRaw,
  localSharePubkeyFingerprint,
  localSharePrivKeyPath,
  localSharePubKeyPath,
} from '../security/local-share-signer.ts';
import { verifyEd25519SignedEnvelope } from '../security/ed25519-envelope-verifier.ts';
import {
  canonicalizeSharedMemoryEnvelope,
  SHARED_MEMORY_KIND,
  type UnsignedSharedMemoryEnvelope,
} from '../shared-memory-envelope.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'massu-a06-home-'));
}

function body(over: Partial<UnsignedSharedMemoryEnvelope> = {}): UnsignedSharedMemoryEnvelope {
  return {
    kind: SHARED_MEMORY_KIND,
    origin_repo_id: '11111111-2222-4333-8444-555555555555',
    origin_repo_label: 'massu',
    seq: 17,
    issued_at: '2026-07-21T00:00:00.000Z',
    records_json: JSON.stringify([{ record_hash: 'a'.repeat(64), type: 'decision', title: 'x', detail: 'y', importance: 4, created_at_epoch: 1752000000, superseded_by_hash: null }]),
    revokes_json: '[]',
    ...over,
  };
}

describe('A-06 local-share-signer', () => {
  it('A-06.1: a signed envelope verifies through the REAL verifier core', () => {
    const home = freshHome();
    try {
      const signed = signSharedMemoryEnvelope(body(), home);
      const pubkeyBytes = readLocalSharePublicKeyRaw(home);
      const fp = localSharePubkeyFingerprint(home);
      const result = verifyEd25519SignedEnvelope(
        { pubkeyBytes, fingerprintHex: fp, knownFingerprints: new Set([fp]), keyLabel: 'local-share' },
        signed,
      );
      expect(result).toEqual({ kind: 'valid' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-06.2: signer and verifier compute the SAME canonical string (unicode / \\n / unsorted keys)', () => {
    const home = freshHome();
    try {
      // Body with unicode + newline in a signed field, and keys deliberately out of
      // sorted insertion order — the canonical form must be replacer-sorted, stable.
      const b: UnsignedSharedMemoryEnvelope = {
        seq: 3,
        revokes_json: '["deadbeef"]',
        kind: SHARED_MEMORY_KIND,
        records_json: JSON.stringify([{ title: 'café\nnewline', detail: '→ ünïçødé' }]),
        origin_repo_label: 'other_repo',
        issued_at: '2026-07-21T09:00:00.000Z',
        origin_repo_id: '99999999-8888-4777-8666-555544443333',
      } as UnsignedSharedMemoryEnvelope;
      const signed = signSharedMemoryEnvelope(b, home);
      // Reconstruct exactly as the verifier core does, from the envelope's own keys.
      const canonicalObj: Record<string, unknown> = {};
      for (const k of signed._signature_payload_keys) canonicalObj[k] = (signed as Record<string, unknown>)[k];
      const verifierCanonical = JSON.stringify(canonicalObj, [...signed._signature_payload_keys].sort());
      expect(canonicalizeSharedMemoryEnvelope(b)).toBe(verifierCanonical);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-06.3: keypair is LAZY — a dormant home has no key until the first sign', () => {
    const home = freshHome();
    try {
      expect(existsSync(localSharePrivKeyPath(home))).toBe(false);
      expect(existsSync(localSharePubKeyPath(home))).toBe(false);
      signSharedMemoryEnvelope(body(), home);
      expect(existsSync(localSharePrivKeyPath(home))).toBe(true);
      expect(existsSync(localSharePubKeyPath(home))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-06.4: the private key is written mode 0600; ensure is idempotent', () => {
    const home = freshHome();
    try {
      ensureLocalShareKeypair(home);
      const mode1 = statSync(localSharePrivKeyPath(home)).mode & 0o777;
      expect(mode1).toBe(0o600);
      const fp1 = localSharePubkeyFingerprint(home);
      ensureLocalShareKeypair(home); // idempotent — MUST NOT regenerate
      expect(localSharePubkeyFingerprint(home)).toBe(fp1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

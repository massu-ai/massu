// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-07 (D4) drift-guard — a NON-VACUOUS knownFingerprints.
 *
 *  (a) With the correct pinned fingerprint a signed envelope verifies valid.
 *  (b) Swap the on-disk key file → the pinned fingerprint no longer matches the
 *      key's fingerprint → the verifier HARD-DROPS (kind:'error', tamper reason),
 *      and materializes NOTHING. This is the whole point of pinning in a DIFFERENT
 *      artifact than the key.
 *  (c) ANTI-VACUITY (source-level): the trusted set is built from the pinned
 *      fingerprint PARAMETER, never from the pubkey the verifier is checking. A
 *      self-referential `new Set([fingerprintHex])` would make the check compare a
 *      value to itself — the exact D4 defect.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  signSharedMemoryEnvelope,
  localSharePubkeyFingerprint,
  localSharePrivKeyPath,
  localSharePubKeyPath,
} from '../security/local-share-signer.ts';
import { verifyLocalShareEnvelope } from '../security/local-share-verifier.ts';
import { SHARED_MEMORY_KIND, type UnsignedSharedMemoryEnvelope } from '../shared-memory-envelope.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFIER_SRC = resolve(__dirname, '..', 'security', 'local-share-verifier.ts');

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'massu-a07-home-'));
}
function body(): UnsignedSharedMemoryEnvelope {
  return {
    kind: SHARED_MEMORY_KIND,
    origin_repo_id: '11111111-2222-4333-8444-555555555555',
    origin_repo_label: 'massu',
    seq: 1,
    issued_at: '2026-07-21T00:00:00.000Z',
    records_json: '[]',
    revokes_json: '[]',
  };
}

describe('A-07 local-share-verifier (D4)', () => {
  it('A-07.1: verifies valid against the correctly-pinned fingerprint', () => {
    const home = freshHome();
    try {
      const signed = signSharedMemoryEnvelope(body(), home);
      const pinned = localSharePubkeyFingerprint(home); // pinned TOFU on first use
      expect(verifyLocalShareEnvelope(signed, pinned, home)).toEqual({ kind: 'valid' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-07.2: a KEY SWAP → hard drop (materializes nothing) until a human re-pins', () => {
    const home = freshHome();
    try {
      const signed = signSharedMemoryEnvelope(body(), home);
      const pinned = localSharePubkeyFingerprint(home); // the ORIGINAL, pinned fingerprint

      // Swap the key: delete both files so the next sign generates a NEW keypair.
      unlinkSync(localSharePrivKeyPath(home));
      unlinkSync(localSharePubKeyPath(home));
      signSharedMemoryEnvelope(body(), home); // regenerates key2 on disk
      expect(existsSync(localSharePubKeyPath(home))).toBe(true);
      expect(localSharePubkeyFingerprint(home)).not.toBe(pinned); // key2 ≠ key1

      // The old envelope, verified against the ORIGINAL pin, now hard-drops: the
      // on-disk key's fingerprint ∉ { pinned } → self-check fails.
      const result = verifyLocalShareEnvelope(signed, pinned, home);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.reason).toMatch(/allowlist|tamper/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-07.3: no key on disk → drop, never throw (import path stays fail-open)', () => {
    const home = freshHome(); // never signed → no key
    try {
      const fake = { ...body(), _signature: 'x', _signature_alg: 'ed25519', _signature_payload_keys: [], _signature_pubkey_fingerprint: 'y' } as never;
      const result = verifyLocalShareEnvelope(fake, 'deadbeef', home);
      expect(result.kind).toBe('error');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-07.4: ANTI-VACUITY — knownFingerprints is built from the pinned param, not the key bytes', () => {
    const src = readFileSync(VERIFIER_SRC, 'utf-8');
    // The trusted set MUST come from the pinnedFingerprint parameter.
    expect(src).toContain('new Set<string>([pinnedFingerprint])');
    // It MUST NOT be derived from the key it is verifying (the vacuous D4 form).
    expect(src).not.toMatch(/knownFingerprints:\s*new Set\(\[\s*fingerprintHex/);
    expect(src).not.toMatch(/knownFingerprints:\s*new Set\(\[\s*key\.fingerprintHex/);
    expect(src).not.toMatch(/knownFingerprints:\s*new Set\(\[\s*localSharePubkeyFingerprint/);
  });
});

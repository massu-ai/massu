// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-008 (plan-2026-05-28-team-shared-rule-promotion): tests for the Ed25519
 * promotion-envelope verifier. Unlike the license verifier's unit tests (which
 * can only cover rejection paths because the real private key is not in the
 * repo), this suite mocks the bundled pubkey with a freshly-generated ephemeral
 * key so the VALID path is also exercised end-to-end. No network is ever
 * touched (the verifier imports no fetch).
 */

import { describe, it, expect, vi } from 'vitest';
import { createPrivateKey, sign as nodeSign } from 'crypto';

// Generate an ephemeral Ed25519 keypair and bundle its pubkey via the mock.
const testKey = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateKeyPairSync, createHash } = require('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki: Buffer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub: Buffer = spki.subarray(spki.length - 32);
  const fp: string = createHash('sha256').update(rawPub).digest('hex');
  return {
    rawPub: Array.from(rawPub) as number[],
    fp,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  };
});

vi.mock('../security/promotion-pubkey.generated.ts', () => ({
  PROMOTION_PUBKEY_ED25519: new Uint8Array(testKey.rawPub),
  PROMOTION_PUBKEY_FINGERPRINT_HEX: testKey.fp,
  KNOWN_PROMOTION_PUBKEY_FINGERPRINTS: new Set([testKey.fp]),
}));

import { verifyPromotionEnvelope } from '../security/promotion-envelope-verifier.ts';

/** Mirror the server's signEnvelope exactly (sorted non-underscore keys). */
function signEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(payload).filter((k) => !k.startsWith('_')).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const k of keys) canonicalObj[k] = payload[k];
  const canonical = JSON.stringify(canonicalObj, keys);
  const priv = createPrivateKey(testKey.privateKeyPem);
  const sig = nodeSign(null, Buffer.from(canonical, 'utf-8'), priv);
  return {
    ...payload,
    _signature: sig.toString('base64'),
    _signature_alg: 'ed25519',
    _signature_payload_keys: keys,
    _signature_pubkey_fingerprint: testKey.fp,
  };
}

const PROMOS = JSON.stringify([
  { prompt_hash: 'a'.repeat(16), destination: 'corrections-md', draft_text: 'be kind', score: 30, signals: [], promoted_by: 'u1', promoted_at: '2026-05-31T00:00:00Z', seq: 5, revoked_at: null },
]);

describe('promotion-envelope-verifier (PB-008)', () => {
  it('bundled pubkey fingerprint is in the trusted allowlist (self-check)', () => {
    const env = signEnvelope({ orgId: 'org-1', cursor: 5, promotions_json: PROMOS });
    const r = verifyPromotionEnvelope(env);
    expect(r.kind).toBe('valid');
  });

  it('a correctly-signed envelope verifies as valid', () => {
    const env = signEnvelope({ orgId: 'org-9', cursor: 0, promotions_json: '[]' });
    expect(verifyPromotionEnvelope(env).kind).toBe('valid');
  });

  it('a tampered promotions_json body fails as bad_signature', () => {
    const env = signEnvelope({ orgId: 'org-1', cursor: 5, promotions_json: PROMOS });
    // Mutate a signed field after signing — signature no longer covers the bytes.
    env.promotions_json = JSON.stringify([{ prompt_hash: 'b'.repeat(16), destination: 'corrections-md', draft_text: 'EVIL', promoted_by: 'attacker', promoted_at: 'x', seq: 5 }]);
    expect(verifyPromotionEnvelope(env).kind).toBe('bad_signature');
  });

  it('a tampered orgId fails as bad_signature', () => {
    const env = signEnvelope({ orgId: 'org-1', cursor: 5, promotions_json: PROMOS });
    env.orgId = 'org-ATTACKER';
    expect(verifyPromotionEnvelope(env).kind).toBe('bad_signature');
  });

  it('a missing signature is missing_signature', () => {
    expect(verifyPromotionEnvelope({ orgId: 'org-1', cursor: 0, promotions_json: '[]' }).kind).toBe(
      'missing_signature',
    );
  });

  it('an unsupported algorithm is an error', () => {
    const env = signEnvelope({ orgId: 'org-1', cursor: 0, promotions_json: '[]' });
    env._signature_alg = 'rsa';
    expect(verifyPromotionEnvelope(env).kind).toBe('error');
  });

  it('a different (unknown) signing pubkey fingerprint is unknown_pubkey', () => {
    const env = signEnvelope({ orgId: 'org-1', cursor: 0, promotions_json: '[]' });
    env._signature_pubkey_fingerprint = 'aa'.repeat(32);
    const r = verifyPromotionEnvelope(env);
    expect(r.kind).toBe('unknown_pubkey');
  });

  it('garbage signature bytes are bad_signature', () => {
    const env = signEnvelope({ orgId: 'org-1', cursor: 0, promotions_json: '[]' });
    env._signature = Buffer.alloc(64).toString('base64');
    expect(verifyPromotionEnvelope(env).kind).toBe('bad_signature');
  });
});

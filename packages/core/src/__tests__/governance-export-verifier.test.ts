// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PA3-001 (plan-2026-06-01-enterprise-governance-audit-export): tests for the
 * Ed25519 governance audit-export verifier. Mirrors promotion-envelope-verifier
 * test: mocks the bundled pubkey with a freshly-generated ephemeral key so the
 * VALID path is exercised end-to-end, plus the tamper/missing rejection paths.
 * No network is ever touched.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPrivateKey, sign as nodeSign } from 'crypto';

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

vi.mock('../security/audit-export-pubkey.generated.ts', () => ({
  AUDIT_EXPORT_PUBKEY_ED25519: new Uint8Array(testKey.rawPub),
  AUDIT_EXPORT_PUBKEY_FINGERPRINT_HEX: testKey.fp,
  KNOWN_AUDIT_EXPORT_PUBKEY_FINGERPRINTS: new Set([testKey.fp]),
}));

import { verifyGovernanceExportEnvelope } from '../security/governance-export-verifier.ts';

/** Mirror the edge fn's signEnvelope exactly (sorted non-underscore keys). */
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

const RECORDS = JSON.stringify({
  policy: { org_id: 'org-1', approvals_required: 2, allowed_destinations: ['corrections-md'], min_promoter_role: 'admin', require_hardened_review: false },
  promoted_rules: [{ prompt_hash: 'a'.repeat(16), destination: 'corrections-md', approval_state: 'pending', revoked_at: null }],
  promotion_approvals: [{ prompt_hash: 'a'.repeat(16), approver_user_id: 'u2' }],
  activity_feed: [{ event_type: 'approval_recorded', title: 'Promotion approval recorded' }],
});

describe('governance-export-verifier (PA3-001)', () => {
  it('a correctly-signed export envelope verifies as valid', () => {
    const env = signEnvelope({ orgId: 'org-1', generatedAt: '2026-06-02T00:00:00Z', version: '1', records_json: RECORDS });
    expect(verifyGovernanceExportEnvelope(env).kind).toBe('valid');
  });

  it('a tampered records_json body fails as bad_signature (forgery-hole closed)', () => {
    const env = signEnvelope({ orgId: 'org-1', generatedAt: '2026-06-02T00:00:00Z', version: '1', records_json: RECORDS });
    env.records_json = JSON.stringify({ promoted_rules: [{ prompt_hash: 'b'.repeat(16), destination: 'pattern-scanner', draft_text: 'EVIL' }] });
    expect(verifyGovernanceExportEnvelope(env).kind).toBe('bad_signature');
  });

  it('a tampered orgId fails as bad_signature', () => {
    const env = signEnvelope({ orgId: 'org-1', generatedAt: '2026-06-02T00:00:00Z', version: '1', records_json: RECORDS });
    env.orgId = 'org-ATTACKER';
    expect(verifyGovernanceExportEnvelope(env).kind).toBe('bad_signature');
  });

  it('a missing signature is missing_signature', () => {
    expect(
      verifyGovernanceExportEnvelope({ orgId: 'org-1', generatedAt: 'x', version: '1', records_json: '{}' }).kind,
    ).toBe('missing_signature');
  });

  it('an unsupported algorithm is an error', () => {
    const env = signEnvelope({ orgId: 'org-1', generatedAt: 'x', version: '1', records_json: '{}' });
    env._signature_alg = 'rsa';
    expect(verifyGovernanceExportEnvelope(env).kind).toBe('error');
  });
});

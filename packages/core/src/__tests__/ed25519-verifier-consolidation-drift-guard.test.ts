// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PC-004 (plan-2026-06-01-team-shared-promotion-phase-3 / CR-46): structural
 * drift-guard for the Ed25519 verifier consolidation. Makes the "two wrappers
 * delegate to one parametric core" invariant non-regressable, and proves
 * behavioral equivalence between the shared core and each wrapper.
 *
 * Companion bash mirror: `scripts/massu-pattern-scanner.sh` Check 33 (vitest <->
 * scanner parity, the CR-50 convention). Sub-assertion (iii) asserts the scanner
 * carries an equivalent Check 33.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrivateKey, sign as nodeSign, generateKeyPairSync } from 'node:crypto';
import {
  verifyEd25519SignedEnvelope,
  type Ed25519VerifierKey,
} from '../security/ed25519-envelope-verifier.ts';
import { verifyPromotionEnvelope } from '../security/promotion-envelope-verifier.ts';
import { verifyLicenseResponse } from '../security/license-response-verifier.ts';
import {
  PROMOTION_PUBKEY_ED25519,
  PROMOTION_PUBKEY_FINGERPRINT_HEX,
  KNOWN_PROMOTION_PUBKEY_FINGERPRINTS,
} from '../security/promotion-pubkey.generated.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CORE_SRC = resolve(REPO_ROOT, 'packages/core/src/security/ed25519-envelope-verifier.ts');
const PROMO_SRC = resolve(REPO_ROOT, 'packages/core/src/security/promotion-envelope-verifier.ts');
const LIC_SRC = resolve(REPO_ROOT, 'packages/core/src/security/license-response-verifier.ts');
const PATTERN_SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh');

describe('ed25519-verifier-consolidation drift-guard (PC-004 / CR-46)', () => {
  // (i) — both wrappers delegate to the shared core; neither re-implements the
  // crypto.verify(null,...) body.
  it('both wrappers reference verifyEd25519SignedEnvelope', () => {
    const promo = readFileSync(PROMO_SRC, 'utf-8');
    const lic = readFileSync(LIC_SRC, 'utf-8');
    expect(promo).toMatch(/verifyEd25519SignedEnvelope/);
    expect(lic).toMatch(/verifyEd25519SignedEnvelope/);
  });

  it('neither wrapper contains a duplicated crypto.verify(null,...) core', () => {
    const promo = readFileSync(PROMO_SRC, 'utf-8');
    const lic = readFileSync(LIC_SRC, 'utf-8');
    // The verify primitive must live ONLY in the shared core.
    expect(promo).not.toMatch(/Verify\(\s*\n?\s*null/);
    expect(lic).not.toMatch(/Verify\(\s*\n?\s*null/);
    // And the core itself DOES carry it.
    expect(readFileSync(CORE_SRC, 'utf-8')).toMatch(/cryptoVerify\(/);
  });

  it('the dead createVerify import was removed from license-response-verifier (CR-9)', () => {
    expect(readFileSync(LIC_SRC, 'utf-8')).not.toMatch(/createVerify/);
  });

  // (ii) — behavioral equivalence: the same fixtures through the core and the
  // promotion wrapper produce identical verdicts.
  describe('behavioral equivalence (core vs wrappers)', () => {
    const promoKey: Ed25519VerifierKey = {
      pubkeyBytes: PROMOTION_PUBKEY_ED25519,
      fingerprintHex: PROMOTION_PUBKEY_FINGERPRINT_HEX,
      knownFingerprints: KNOWN_PROMOTION_PUBKEY_FINGERPRINTS,
      keyLabel: 'promotion',
    };

    it('missing signature → both report missing_signature', () => {
      const env = { orgId: 'o1', cursor: 0, promotions_json: '[]' };
      expect(verifyEd25519SignedEnvelope(promoKey, env).kind).toBe('missing_signature');
      expect(verifyPromotionEnvelope(env).kind).toBe('missing_signature');
    });

    it('unsupported alg → both report error', () => {
      const env = {
        _signature: 'AA==',
        _signature_alg: 'rsa',
        _signature_payload_keys: ['orgId'],
        orgId: 'o1',
      };
      expect(verifyEd25519SignedEnvelope(promoKey, env).kind).toBe('error');
      expect(verifyPromotionEnvelope(env).kind).toBe('error');
    });

    it('a foreign-key signature → both report bad_signature', () => {
      // Sign with a DIFFERENT key than the bundled promotion pubkey.
      const { privateKey } = generateKeyPairSync('ed25519');
      const payloadKeys = ['cursor', 'orgId', 'promotions_json'];
      const canonicalObj: Record<string, unknown> = {
        orgId: 'o1',
        cursor: 0,
        promotions_json: '[]',
      };
      const canonical = JSON.stringify(canonicalObj, [...payloadKeys].sort());
      const sig = nodeSign(null, Buffer.from(canonical, 'utf-8'), privateKey).toString('base64');
      const env = {
        _signature: sig,
        _signature_alg: 'ed25519',
        _signature_payload_keys: payloadKeys,
        orgId: 'o1',
        cursor: 0,
        promotions_json: '[]',
      };
      expect(verifyEd25519SignedEnvelope(promoKey, env).kind).toBe('bad_signature');
      expect(verifyPromotionEnvelope(env).kind).toBe('bad_signature');
    });

    it('a different signed pubkey fingerprint → both report unknown_pubkey', () => {
      const env = {
        _signature: 'AA==',
        _signature_alg: 'ed25519',
        _signature_payload_keys: ['orgId'],
        _signature_pubkey_fingerprint: 'deadbeef'.repeat(8),
        orgId: 'o1',
      };
      expect(verifyEd25519SignedEnvelope(promoKey, env).kind).toBe('unknown_pubkey');
      expect(verifyPromotionEnvelope(env).kind).toBe('unknown_pubkey');
    });
  });

  // (iii) — vitest <-> scanner parity.
  it('pattern-scanner carries an equivalent Check 33', () => {
    const scanner = readFileSync(PATTERN_SCANNER, 'utf-8');
    expect(scanner).toMatch(/Check 33:/);
    expect(scanner).toMatch(/verifyEd25519SignedEnvelope/);
  });
});

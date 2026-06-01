// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-002 (plan-2026-05-28-team-shared-rule-promotion): Ed25519 verifier for
 * signed /promoted-rules differential-pull responses from massu.ai.
 *
 * **Bug class closed**: a team rule promotion is executable/behavioral config.
 * Propagating a teammate's promoted rule to a receiving seat and materializing
 * it is, in the worst case, the cross-seat RCE surface. MITM, a malicious
 * `cloud.endpoint`, or tampered-in-transit substitution could inject a forged
 * promotion. This verifier rejects any envelope whose Ed25519 signature does
 * not validate against the bundled promotion pubkey.
 *
 * **Structural fix**: the server (/promoted-rules Edge Function) signs every
 * response with a DEDICATED Ed25519 promotion key over the SAME canonical-JSON
 * scheme as validate-key. The envelope is intentionally FLAT — the promotions
 * array is carried as the `promotions_json` STRING field so the signature
 * genuinely covers every byte of every rule body (a nested array would be
 * stripped by the sorted-key array-replacer, a forgery hole). The client (this
 * module) reconstructs that canonical serialization and verifies it.
 *
 * **NO transition mode** (deliberate divergence from license-response-verifier).
 * `validate-key` tolerates unsigned responses in transition mode for license-tier
 * UX. A team rule-promotion is code/config, so the bar is higher: an unsigned or
 * invalid-signature envelope is REJECTED here, and the caller (team-rule-sync
 * `pullTeamPromotions`) DROPS the whole response — never materialized. There is
 * no "accept unsigned" branch.
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  PROMOTION_PUBKEY_ED25519,
  PROMOTION_PUBKEY_FINGERPRINT_HEX,
  KNOWN_PROMOTION_PUBKEY_FINGERPRINTS,
} from './promotion-pubkey.generated.ts';

/**
 * The FLAT signed envelope shape served by /promoted-rules. The `promotions`
 * array is carried as the `promotions_json` STRING so the signature covers
 * every rule body. `orgId` is included so the client can confirm org match.
 */
export interface SignedPromotionEnvelope {
  /** Base64-encoded Ed25519 signature over the canonical-serialized payload. */
  _signature?: string;
  /** Signature algorithm tag (currently always `'ed25519'`). */
  _signature_alg?: string;
  /**
   * Sorted list of top-level keys (excluding the `_signature*` quartet) that
   * were included in the signed payload — lets the client reconstruct the
   * canonical-serialization input deterministically.
   */
  _signature_payload_keys?: readonly string[];
  /** Hex sha256 of the promotion pubkey used for signing (rotation detection). */
  _signature_pubkey_fingerprint?: string;
  /** Server-attested org id of the requester (signature-covered). */
  orgId?: string;
  /** Max `seq` returned (monotonic cursor watermark, H2). */
  cursor?: number;
  /** JSON-serialized promotions array (string so the signature covers it). */
  promotions_json?: string;
  [key: string]: unknown;
}

export type PromotionVerificationResult =
  | { kind: 'valid' }
  | { kind: 'missing_signature' }
  | { kind: 'bad_signature' }
  | { kind: 'unknown_pubkey'; got: string }
  | { kind: 'error'; reason: string };

/**
 * Verify a server-signed /promoted-rules response. Returns a tagged union
 * describing the verification outcome. The caller treats ANYTHING other than
 * `{ kind: 'valid' }` as a hard drop (no transition tolerance for code/config).
 */
export function verifyPromotionEnvelope(
  payload: SignedPromotionEnvelope,
): PromotionVerificationResult {
  // Self-check: confirm the bundled key fingerprint is in the trusted
  // allowlist (a future build that swaps the pem to an unknown key refuses
  // to verify even if compiled in).
  if (!KNOWN_PROMOTION_PUBKEY_FINGERPRINTS.has(PROMOTION_PUBKEY_FINGERPRINT_HEX)) {
    return {
      kind: 'error',
      reason: `Bundled promotion pubkey fingerprint ${PROMOTION_PUBKEY_FINGERPRINT_HEX} is not in the trusted allowlist. Possible build-time tamper.`,
    };
  }

  const sig = payload._signature;
  const alg = payload._signature_alg;
  const payloadKeys = payload._signature_payload_keys;
  const sigPubkey = payload._signature_pubkey_fingerprint;

  if (typeof sig !== 'string' || sig.length === 0) {
    return { kind: 'missing_signature' };
  }
  if (alg !== 'ed25519') {
    return { kind: 'error', reason: `Unsupported signature algorithm: ${alg}` };
  }
  if (!Array.isArray(payloadKeys) || payloadKeys.length === 0) {
    return { kind: 'error', reason: 'Missing _signature_payload_keys' };
  }
  if (typeof sigPubkey === 'string' && sigPubkey !== PROMOTION_PUBKEY_FINGERPRINT_HEX) {
    // Server signed with a different pubkey than we have bundled. With NO
    // transition mode this is a hard drop (the caller treats any non-valid
    // result as a drop), but we surface the fingerprint so rotation can be
    // diagnosed from observability.
    return { kind: 'unknown_pubkey', got: sigPubkey };
  }

  // Reconstruct the canonical serialization the server signed:
  //   JSON.stringify({ k1: payload[k1], ... }, payloadKeysSorted)
  // exactly mirroring license-response-verifier and the server's signEnvelope.
  const canonicalObj: Record<string, unknown> = {};
  for (const k of payloadKeys) {
    if (typeof k !== 'string') continue;
    canonicalObj[k] = payload[k];
  }
  const canonical = JSON.stringify(canonicalObj, [...payloadKeys].sort());

  try {
    // SubjectPublicKeyInfo DER (12-byte Ed25519 OID prefix + 32-byte raw key).
    const spkiPrefix = Buffer.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
      0x70, 0x03, 0x21, 0x00,
    ]);
    const der = Buffer.concat([spkiPrefix, Buffer.from(PROMOTION_PUBKEY_ED25519)]);
    const pubkey = createPublicKey({ key: der, format: 'der', type: 'spki' });

    // Ed25519: algorithm MUST be null for crypto.verify.
    const ok = cryptoVerify(
      null,
      Buffer.from(canonical, 'utf-8'),
      pubkey,
      Buffer.from(sig, 'base64'),
    );

    return ok ? { kind: 'valid' } : { kind: 'bad_signature' };
  } catch (err) {
    return {
      kind: 'error',
      reason: `Signature verification threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H019 (plan-stage-c-high-batch / 1.10.5): Ed25519 verifier for signed
 * /validate-key responses from massu.ai.
 *
 * **Bug class closed**: pre-fix, `packages/core/src/license.ts:280-318`
 * accepted ANY `{ valid: true, plan: 'enterprise' }` JSON over HTTPS from
 * whatever endpoint `config.cloud?.endpoint` pointed to. MITM, malicious
 * cloud.endpoint, or local edit of the cached `license_cache` SQLite row
 * could grant arbitrary tier.
 *
 * **Structural fix**: the server (validate-key Supabase Edge Function)
 * signs every response with Ed25519. The client (this module, called
 * from `license.ts`) verifies the signature against the bundled public
 * key in `license-pubkey.generated.ts`. Invalid / missing signature →
 * reject under strict mode, warn-and-accept under transition mode.
 *
 * **Transition mode** (default): when `MASSU_REQUIRE_SIGNED_LICENSE` env
 * var is NOT `'true'`, unsigned/invalid-sig responses are accepted but
 * a one-shot stderr warning is emitted. Lets existing customers keep
 * working while operators provision the signing key.
 *
 * **Strict mode** (post-cutover): when `MASSU_REQUIRE_SIGNED_LICENSE=true`,
 * unsigned/invalid-sig responses are REJECTED (caller drops to grace-period
 * cached or 'free' tier). Operator flips this after Supabase Edge Function
 * env var `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` is provisioned and
 * cutover smoke test passes.
 */

import { createVerify, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  LICENSE_PUBKEY_ED25519,
  LICENSE_PUBKEY_FINGERPRINT_HEX,
  KNOWN_LICENSE_PUBKEY_FINGERPRINTS,
} from './license-pubkey.generated.ts';

export interface SignedLicenseResponse {
  /** Base64-encoded Ed25519 signature over the canonical-serialized payload. */
  _signature?: string;
  /** Signature algorithm tag (currently always `'ed25519'`). */
  _signature_alg?: string;
  /**
   * Sorted list of top-level keys (excluding the `_signature*` triplet) that
   * were included in the signed payload. Lets the client reconstruct the
   * canonical-serialization input deterministically.
   */
  _signature_payload_keys?: readonly string[];
  /** Hex sha256 of the LICENSE pubkey used for signing (so client can detect rotation). */
  _signature_pubkey_fingerprint?: string;
  // Plus the actual fields (plan, tier, validUntil, features, etc.)
  [key: string]: unknown;
}

export type VerificationResult =
  | { kind: 'valid' }
  | { kind: 'missing_signature' }
  | { kind: 'bad_signature' }
  | { kind: 'unknown_pubkey'; got: string }
  | { kind: 'error'; reason: string };

/**
 * Verify a server-signed /validate-key response. Returns a tagged union
 * describing the verification outcome. Caller decides whether to accept
 * based on strict/transition mode.
 */
export function verifyLicenseResponse(payload: SignedLicenseResponse): VerificationResult {
  // Self-check: confirm the bundled key fingerprint matches the allowlist.
  // CR-9 audit L2 pattern: a future build that swaps the pem to an unknown
  // key refuses to load even if compiled in.
  if (!KNOWN_LICENSE_PUBKEY_FINGERPRINTS.has(LICENSE_PUBKEY_FINGERPRINT_HEX)) {
    return {
      kind: 'error',
      reason: `Bundled license pubkey fingerprint ${LICENSE_PUBKEY_FINGERPRINT_HEX} is not in the trusted allowlist. Possible build-time tamper.`,
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
  if (typeof sigPubkey === 'string' && sigPubkey !== LICENSE_PUBKEY_FINGERPRINT_HEX) {
    // Server signed with a different pubkey than we have bundled — rotation
    // mismatch. Caller should fail-open under transition mode (operator
    // hasn't published the new bundle yet) but reject under strict mode.
    return { kind: 'unknown_pubkey', got: sigPubkey };
  }

  // Reconstruct the canonical serialization the server signed:
  //   JSON.stringify({ k1: payload[k1], k2: payload[k2], ... }, payloadKeysSorted)
  // where payloadKeysSorted is the sorted list of NON-underscore-prefixed keys.
  const canonicalObj: Record<string, unknown> = {};
  for (const k of payloadKeys) {
    if (typeof k !== 'string') continue;
    canonicalObj[k] = payload[k];
  }
  const canonical = JSON.stringify(canonicalObj, [...payloadKeys].sort());

  // Verify signature.
  try {
    // Construct a node KeyObject from the bundled raw Ed25519 pubkey bytes.
    // We use createPublicKey with SubjectPublicKeyInfo DER encoding (44 bytes:
    // 12-byte algorithm OID prefix + 32-byte raw key).
    const spkiPrefix = Buffer.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
      0x70, 0x03, 0x21, 0x00,
    ]);
    const der = Buffer.concat([spkiPrefix, Buffer.from(LICENSE_PUBKEY_ED25519)]);
    const pubkey = createPublicKey({ key: der, format: 'der', type: 'spki' });

    // Ed25519 in node uses `verify` directly (no createVerify needed for ed25519).
    // crypto.verify(algorithm, data, key, signature) — algorithm MUST be null for Ed25519.
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

/**
 * P-H019 strict-mode gate. Operator sets `MASSU_REQUIRE_SIGNED_LICENSE=true`
 * AFTER the validate-key Edge Function is provisioned with
 * `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` and cutover smoke test passes.
 */
export function isLicenseSignatureRequired(): boolean {
  return process.env.MASSU_REQUIRE_SIGNED_LICENSE === 'true';
}

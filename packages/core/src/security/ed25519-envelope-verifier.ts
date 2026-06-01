// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PC-001 (plan-2026-06-01-team-shared-promotion-phase-3): the single parametric
 * Ed25519 signed-envelope verifier core, consolidating the byte-identical bodies
 * previously duplicated in `license-response-verifier.ts` + `promotion-envelope-verifier.ts`.
 *
 * Both call sites sign a FLAT envelope: a `_signature*` quartet plus a sorted
 * `_signature_payload_keys` list naming the signed top-level keys. The client
 * reconstructs `JSON.stringify(canonicalObj, [...payloadKeys].sort())` and verifies
 * with Node's Ed25519 `crypto.verify(null, ...)`. The two former verifiers differed
 * ONLY in (a) the bundled pubkey trio and (b) the word "promotion"/"license" in the
 * tamper-error; transition-mode / strict-mode decisions live at the CALLER and are
 * unchanged by this consolidation.
 *
 * Hook-safe: imports only Node `crypto`. No heavy deps. Pure — no I/O, no env reads.
 *
 * ⚠️ FORGERY-HOLE PITFALL (carried from the original modules): the canonical
 * reconstruction uses a sorted-KEY ARRAY replacer, which STRIPS nested object/array
 * bodies under any signed top-level key from the signed bytes. Callers MUST carry
 * array/object bodies as a `*_json` STRING field (see promotion's `promotions_json`)
 * so the signature genuinely covers every byte. Adding a nested object as a new
 * top-level signed key would leave its contents unsigned (forgeable).
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';

/** The `_signature*` quartet shared by every signed envelope, plus its open body. */
export interface SignedEnvelopeBase {
  /** Base64-encoded Ed25519 signature over the canonical-serialized payload. */
  _signature?: string;
  /** Signature algorithm tag (currently always `'ed25519'`). */
  _signature_alg?: string;
  /**
   * Sorted list of top-level keys (excluding the `_signature*` quartet) that were
   * included in the signed payload — lets the client reconstruct the
   * canonical-serialization input deterministically.
   */
  _signature_payload_keys?: readonly string[];
  /** Hex sha256 of the pubkey used for signing (rotation detection). */
  _signature_pubkey_fingerprint?: string;
  [key: string]: unknown;
}

/**
 * Tagged-union verification outcome, shared by every envelope kind. Callers treat
 * anything other than `{ kind: 'valid' }` per their own mode (license: transition
 * tolerance; promotion: hard drop).
 */
export type Ed25519VerificationResult =
  | { kind: 'valid' }
  | { kind: 'missing_signature' }
  | { kind: 'bad_signature' }
  | { kind: 'unknown_pubkey'; got: string }
  | { kind: 'error'; reason: string };

/** The bundled-key parameters that distinguish one verifier wrapper from another. */
export interface Ed25519VerifierKey {
  /** Raw 32-byte Ed25519 public key bytes. */
  pubkeyBytes: Uint8Array;
  /** Hex sha256 fingerprint of the bundled pubkey (rotation detection). */
  fingerprintHex: string;
  /** Trusted fingerprint allowlist for the build-time tamper self-check. */
  knownFingerprints: ReadonlySet<string>;
  /** Human label for the tamper error message, e.g. `'promotion'` or `'license'`. */
  keyLabel: string;
}

// SubjectPublicKeyInfo DER prefix for Ed25519 (12-byte algorithm OID prefix; the
// 32-byte raw key is concatenated after it to form the 44-byte SPKI encoding).
const SPKI_ED25519_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
  0x70, 0x03, 0x21, 0x00,
]);

/**
 * Verify a server-signed FLAT envelope against the supplied bundled key. Returns a
 * tagged union; the caller decides acceptance based on its own mode. This is the
 * single SoT for the Ed25519 verify primitive — `verifyLicenseResponse` and
 * `verifyPromotionEnvelope` are thin wrappers over it.
 */
export function verifyEd25519SignedEnvelope(
  key: Ed25519VerifierKey,
  payload: SignedEnvelopeBase,
): Ed25519VerificationResult {
  // Self-check: confirm the bundled key fingerprint is in the trusted allowlist (a
  // future build that swaps the pem to an unknown key refuses to verify even if
  // compiled in).
  if (!key.knownFingerprints.has(key.fingerprintHex)) {
    return {
      kind: 'error',
      reason: `Bundled ${key.keyLabel} pubkey fingerprint ${key.fingerprintHex} is not in the trusted allowlist. Possible build-time tamper.`,
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
  if (typeof sigPubkey === 'string' && sigPubkey !== key.fingerprintHex) {
    // Server signed with a different pubkey than we have bundled. We surface the
    // fingerprint so rotation can be diagnosed from observability; the caller
    // decides whether to fail-open (transition) or hard-drop.
    return { kind: 'unknown_pubkey', got: sigPubkey };
  }

  // Reconstruct the canonical serialization the server signed:
  //   JSON.stringify({ k1: payload[k1], ... }, payloadKeysSorted)
  // exactly mirroring the server's signEnvelope.
  const canonicalObj: Record<string, unknown> = {};
  for (const k of payloadKeys) {
    if (typeof k !== 'string') continue;
    canonicalObj[k] = payload[k];
  }
  const canonical = JSON.stringify(canonicalObj, [...payloadKeys].sort());

  try {
    const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key.pubkeyBytes)]);
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

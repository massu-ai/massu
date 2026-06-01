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

import {
  verifyEd25519SignedEnvelope,
  type Ed25519VerificationResult,
  type SignedEnvelopeBase,
} from './ed25519-envelope-verifier.ts';
import {
  LICENSE_PUBKEY_ED25519,
  LICENSE_PUBKEY_FINGERPRINT_HEX,
  KNOWN_LICENSE_PUBKEY_FINGERPRINTS,
} from './license-pubkey.generated.ts';

export interface SignedLicenseResponse extends SignedEnvelopeBase {
  // The `_signature*` quartet is inherited from SignedEnvelopeBase; the actual
  // fields (plan, tier, validUntil, features, etc.) ride the open index signature.
}

/** Re-export of the shared result union (PC-003: kept as a named alias for callers). */
export type VerificationResult = Ed25519VerificationResult;

/**
 * Verify a server-signed /validate-key response. Thin wrapper over the shared
 * {@link verifyEd25519SignedEnvelope} core (PC-001 consolidation) bound to the
 * bundled LICENSE pubkey. Returns a tagged union; the caller (`license.ts`) decides
 * acceptance based on strict/transition mode — see {@link isLicenseSignatureRequired}.
 * The transition-mode behavior lives entirely at that caller, unchanged.
 */
export function verifyLicenseResponse(payload: SignedLicenseResponse): VerificationResult {
  return verifyEd25519SignedEnvelope(
    {
      pubkeyBytes: LICENSE_PUBKEY_ED25519,
      fingerprintHex: LICENSE_PUBKEY_FINGERPRINT_HEX,
      knownFingerprints: KNOWN_LICENSE_PUBKEY_FINGERPRINTS,
      keyLabel: 'license',
    },
    payload,
  );
}

/**
 * P-H019 strict-mode gate. Operator sets `MASSU_REQUIRE_SIGNED_LICENSE=true`
 * AFTER the validate-key Edge Function is provisioned with
 * `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` and cutover smoke test passes.
 */
export function isLicenseSignatureRequired(): boolean {
  return process.env.MASSU_REQUIRE_SIGNED_LICENSE === 'true';
}

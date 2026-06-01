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

import {
  verifyEd25519SignedEnvelope,
  type Ed25519VerificationResult,
  type SignedEnvelopeBase,
} from './ed25519-envelope-verifier.ts';
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
export interface SignedPromotionEnvelope extends SignedEnvelopeBase {
  /** Server-attested org id of the requester (signature-covered). */
  orgId?: string;
  /** Max `seq` returned (monotonic cursor watermark, H2). */
  cursor?: number;
  /** JSON-serialized promotions array (string so the signature covers it). */
  promotions_json?: string;
}

/** Re-export of the shared result union (PC-002: kept as a named alias for callers). */
export type PromotionVerificationResult = Ed25519VerificationResult;

/**
 * Verify a server-signed /promoted-rules response. Thin wrapper over the shared
 * {@link verifyEd25519SignedEnvelope} core (PC-001 consolidation) bound to the
 * bundled PROMOTION pubkey. The caller (`team-rule-sync.pullTeamPromotions`) treats
 * ANYTHING other than `{ kind: 'valid' }` as a hard drop — NO transition tolerance
 * for code/config (deliberate divergence from license-response-verifier; the
 * transition decision lives entirely at each caller, not in the shared core).
 */
export function verifyPromotionEnvelope(
  payload: SignedPromotionEnvelope,
): PromotionVerificationResult {
  return verifyEd25519SignedEnvelope(
    {
      pubkeyBytes: PROMOTION_PUBKEY_ED25519,
      fingerprintHex: PROMOTION_PUBKEY_FINGERPRINT_HEX,
      knownFingerprints: KNOWN_PROMOTION_PUBKEY_FINGERPRINTS,
      keyLabel: 'promotion',
    },
    payload,
  );
}

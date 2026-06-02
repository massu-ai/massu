// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PA2-002 (plan-2026-06-01-enterprise-governance-audit-export): Ed25519 verifier
 * for the signed /audit-export governance envelope from massu.ai.
 *
 * **Bug class closed**: a signed audit export is a compliance/authenticity
 * artifact — an auditor or regulator trusts that the exported governance history
 * (who promoted what, who approved, what was revoked) genuinely came from massu
 * and was not forged or tampered. This verifier rejects any envelope whose
 * Ed25519 signature does not validate against the bundled audit-export pubkey.
 *
 * **Structural fix**: the server (audit-export Edge Function — the SOLE signer,
 * CR-46 single-signer) signs every export with a DEDICATED Ed25519 key over the
 * SAME canonical-JSON scheme as the license + promotion verifiers. The envelope
 * is intentionally FLAT — the export rows are carried as the `records_json`
 * STRING field so the signature genuinely covers every byte of every record (a
 * nested array would be stripped by the sorted-key array-replacer, a forgery
 * hole — feedback_signed_envelope_nested_array_pitfall).
 *
 * **NO transition mode** (like promotion-envelope-verifier, unlike
 * license-response-verifier): an unsigned or invalid-signature export is
 * REJECTED. The caller treats anything other than `{ kind: 'valid' }` as a hard
 * fail. This is the THIRD Ed25519 artifact and — thanks to the PC-001
 * consolidation — a one-line wrapper over the shared core, no copy-pasted crypto.
 */

import {
  verifyEd25519SignedEnvelope,
  type Ed25519VerificationResult,
  type SignedEnvelopeBase,
} from './ed25519-envelope-verifier.ts';
import {
  AUDIT_EXPORT_PUBKEY_ED25519,
  AUDIT_EXPORT_PUBKEY_FINGERPRINT_HEX,
  KNOWN_AUDIT_EXPORT_PUBKEY_FINGERPRINTS,
} from './audit-export-pubkey.generated.ts';

/**
 * The FLAT signed envelope shape served by /audit-export. The export rows are
 * carried as the `records_json` STRING so the signature covers every record.
 * `orgId` is signature-covered so the consumer can confirm org match.
 */
export interface SignedAuditExportEnvelope extends SignedEnvelopeBase {
  /** Server-attested org id of the export (signature-covered). */
  orgId?: string;
  /** ISO timestamp the export was generated (signature-covered). */
  generatedAt?: string;
  /** Export format/schema version (signature-covered). */
  version?: string;
  /** JSON-serialized export rows (string so the signature covers every record). */
  records_json?: string;
}

/** Re-export of the shared result union (kept as a named alias for callers). */
export type GovernanceExportVerificationResult = Ed25519VerificationResult;

/**
 * Verify a server-signed /audit-export envelope. Thin wrapper over the shared
 * {@link verifyEd25519SignedEnvelope} core (PC-001 consolidation) bound to the
 * bundled AUDIT_EXPORT pubkey. The caller treats ANYTHING other than
 * `{ kind: 'valid' }` as a hard fail — NO transition tolerance for a compliance
 * artifact.
 */
export function verifyGovernanceExportEnvelope(
  payload: SignedAuditExportEnvelope,
): GovernanceExportVerificationResult {
  return verifyEd25519SignedEnvelope(
    {
      pubkeyBytes: AUDIT_EXPORT_PUBKEY_ED25519,
      fingerprintHex: AUDIT_EXPORT_PUBKEY_FINGERPRINT_HEX,
      knownFingerprints: KNOWN_AUDIT_EXPORT_PUBKEY_FINGERPRINTS,
      keyLabel: 'audit-export',
    },
    payload,
  );
}

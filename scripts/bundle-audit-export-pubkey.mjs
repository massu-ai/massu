#!/usr/bin/env node
/**
 * PA2-002 (plan-2026-06-01-enterprise-governance-audit-export): Bundle the
 * Ed25519 audit-export signing public key into a TypeScript module shipped in
 * dist/security/. The client-side verifier
 * (packages/core/src/security/governance-export-verifier.ts, PA2-002) uses this
 * to verify signatures on the /audit-export signed envelope.
 *
 * Parallel to scripts/bundle-promotion-pubkey.mjs. Same pattern; DEDICATED key
 * (key-hygiene separation from the license + promotion signing keys — a
 * compromise of one never grants the others). The signing PRIVATE key lives in a
 * SINGLE runtime (CR-46 single-signer, audit iter 5):
 *
 *   - Audit-export signing key: Supabase Edge Function secret
 *     `AUDIT_EXPORT_SIGNING_PRIVATE_KEY_B64` (operator provisions); used by
 *     `website/supabase/functions/audit-export/index.ts` to sign the export
 *     envelope for BOTH the CLI/programmatic path AND the dashboard path (the
 *     dashboard calls the edge fn server-side via a service-role bearer — there
 *     is NO Vercel-side signing key).
 *
 * Usage:
 *   node scripts/bundle-audit-export-pubkey.mjs           # write generated TS module
 *   node scripts/bundle-audit-export-pubkey.mjs --check   # verify without writing (CI gate)
 *
 * Wired into packages/core/package.json prepublishOnly alongside the license +
 * promotion bundlers so every npm publish ships a freshly-bundled audit-export
 * pubkey aligned with the vendored pem.
 */
import { runPubkeyBundleCli, isMain } from './lib/ed25519-pubkey-bundle.mjs';

/**
 * Known RAW-bytes sha256 fingerprints of the Ed25519 audit-export signing pubkey.
 * Append on rotation; the verifier accepts any entry in this set as trusted
 * during the rotation grace window (DO NOT delete the old entry during the
 * grace window).
 *
 * Initial fingerprint (generated 2026-06-02 via scripts/generate-audit-export-keypair.mjs):
 *   224ee86985c69cee4f616104da1819eeab13c1c640147b4ca55d874326c7b7cd
 */
export const KNOWN_PUBKEY_FINGERPRINTS = new Set([
  '224ee86985c69cee4f616104da1819eeab13c1c640147b4ca55d874326c7b7cd',
]);

/** Everything specific to this key; the shared implementation is scripts/lib/ed25519-pubkey-bundle.mjs. */
export const SPEC = {
  script: 'scripts/bundle-audit-export-pubkey.mjs',
  pem: 'packages/core/security/audit-export-pubkey.pem',
  out: 'packages/core/src/security/audit-export-pubkey.generated.ts',
  knownFingerprints: KNOWN_PUBKEY_FINGERPRINTS,
  missingPemHelp: 'Generate via scripts/generate-audit-export-keypair.mjs per the rotation runbook.',
  renderBody: ({ numbers, fingerprint, knownFingerprintsLiteral }) => `/**
 * Ed25519 public key for verifying the signed /audit-export envelope from
 * massu.ai. Used by
 * packages/core/src/security/governance-export-verifier.ts to reject forged /
 * tampered governance audit exports.
 *
 * A signed audit export is a compliance/authenticity artifact, so the verifier
 * has NO transition mode: an unsigned or invalid-signature envelope is REJECTED.
 *
 * PA2-002 (plan-2026-06-01-enterprise-governance-audit-export).
 *
 * To rotate: regenerate the keypair via scripts/generate-audit-export-keypair.mjs,
 * append the new RAW-bytes sha256 to KNOWN_PUBKEY_FINGERPRINTS in
 * scripts/bundle-audit-export-pubkey.mjs (DO NOT delete the old entry during the
 * rotation grace window), then run \`node scripts/bundle-audit-export-pubkey.mjs\`.
 * Operator then updates the Supabase Edge Function secret
 * \`AUDIT_EXPORT_SIGNING_PRIVATE_KEY_B64\` with the new private key.
 */
export const AUDIT_EXPORT_PUBKEY_ED25519: Uint8Array = new Uint8Array([${numbers}]);

/** Hex sha256 of AUDIT_EXPORT_PUBKEY_ED25519 (raw 32 bytes). */
export const AUDIT_EXPORT_PUBKEY_FINGERPRINT_HEX = '${fingerprint}';

/** Allowlist of historically-trusted audit-export pubkey fingerprints. */
export const KNOWN_AUDIT_EXPORT_PUBKEY_FINGERPRINTS: ReadonlySet<string> = new Set(${knownFingerprintsLiteral});
`,
};

if (isMain(import.meta.url)) runPubkeyBundleCli(SPEC);

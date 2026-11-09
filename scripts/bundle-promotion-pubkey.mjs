#!/usr/bin/env node
/**
 * PA-003 (plan-2026-05-28-team-shared-rule-promotion): Bundle the Ed25519
 * promotion-response signing public key into a TypeScript module shipped in
 * dist/security/. The client-side verifier
 * (packages/core/src/security/promotion-envelope-verifier.ts, PB-002) uses
 * this to verify signatures on /promoted-rules differential-pull responses.
 *
 * Parallel to scripts/bundle-license-pubkey.mjs. Same pattern; DEDICATED key
 * (key-hygiene separation from the license-signing key — a compromise of one
 * never grants the other). Different OS-level secret-store guidance:
 *
 *   - License-pubkey signing key: Supabase Edge Function env var
 *     `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` — used by validate-key.
 *   - Promotion-pubkey signing key: Supabase Edge Function env var
 *     `PROMOTION_RESPONSE_SIGNING_PRIVATE_KEY_B64` (operator provisions);
 *     used by `website/supabase/functions/promoted-rules/index.ts` to sign
 *     each differential-pull response (a team rule promotion is executable/
 *     behavioral config, so the client bar is higher: no transition mode —
 *     an unsigned/invalid envelope is DROPPED, never materialized).
 *
 * Usage:
 *   node scripts/bundle-promotion-pubkey.mjs           # write generated TS module
 *   node scripts/bundle-promotion-pubkey.mjs --check   # verify without writing (CI gate)
 *
 * Wired into packages/core/package.json prepublishOnly alongside
 * bundle-license-pubkey.mjs so every npm publish ships a freshly-bundled
 * promotion pubkey aligned with the vendored pem.
 */
import { runPubkeyBundleCli, isMain } from './lib/ed25519-pubkey-bundle.mjs';

/**
 * Known RAW-bytes sha256 fingerprints of the Ed25519 promotion-signing pubkey.
 * Append on rotation; the verifier accepts any entry in this set as trusted
 * during the rotation grace window (DO NOT delete the old entry during the
 * grace window).
 *
 * Initial fingerprint (generated 2026-05-29 via Node crypto.generateKeyPairSync):
 *   0aeb8eff38f70fa3ed413ebf1fdc8cc00539ab7e76ea023e9424733847ad9956
 *   -- SUPERSEDED 2026-05-30: the matching private key was never persisted and
 *      never deployed to prod, so no grace window is required (removed).
 * Active fingerprint (regenerated 2026-05-30 via scripts/generate-promotion-keypair.mjs):
 *   b14e2a73e23c02891e976ec161d339da6c930266c0202828d3187a3bd6e5d83f
 */
export const KNOWN_PUBKEY_FINGERPRINTS = new Set([
  'b14e2a73e23c02891e976ec161d339da6c930266c0202828d3187a3bd6e5d83f',
]);

/** Everything specific to this key; the shared implementation is scripts/lib/ed25519-pubkey-bundle.mjs. */
export const SPEC = {
  script: 'scripts/bundle-promotion-pubkey.mjs',
  pem: 'packages/core/security/promotion-pubkey.pem',
  out: 'packages/core/src/security/promotion-pubkey.generated.ts',
  knownFingerprints: KNOWN_PUBKEY_FINGERPRINTS,
  missingPemHelp: 'Generate via Node crypto.generateKeyPairSync per the promotion-key rotation runbook.',
  renderBody: ({ numbers, fingerprint, knownFingerprintsLiteral }) => `/**
 * Ed25519 public key for verifying signed /promoted-rules differential-pull
 * responses from massu.ai. Used by
 * packages/core/src/security/promotion-envelope-verifier.ts to reject MITM /
 * malicious-cloud-endpoint / tampered-in-transit promotion envelopes.
 *
 * A team rule promotion is executable/behavioral config, so the verifier has
 * NO transition mode (unlike license-response-verifier): an unsigned or
 * invalid-signature envelope is DROPPED, never materialized.
 *
 * PA-003 (plan-2026-05-28-team-shared-rule-promotion).
 *
 * To rotate: regenerate the keypair via Node crypto.generateKeyPairSync,
 * update packages/core/security/promotion-pubkey.pem with the new public key,
 * append the new RAW-bytes sha256 to KNOWN_PUBKEY_FINGERPRINTS in
 * scripts/bundle-promotion-pubkey.mjs (DO NOT delete the old entry during
 * the rotation grace window), then run \`node scripts/bundle-promotion-pubkey.mjs\`.
 * Operator then updates the Supabase Edge Function env var
 * \`PROMOTION_RESPONSE_SIGNING_PRIVATE_KEY_B64\` with the new private key.
 */
export const PROMOTION_PUBKEY_ED25519: Uint8Array = new Uint8Array([${numbers}]);

/** Hex sha256 of PROMOTION_PUBKEY_ED25519 (raw 32 bytes). */
export const PROMOTION_PUBKEY_FINGERPRINT_HEX = '${fingerprint}';

/** Allowlist of historically-trusted promotion pubkey fingerprints. */
export const KNOWN_PROMOTION_PUBKEY_FINGERPRINTS: ReadonlySet<string> = new Set(${knownFingerprintsLiteral});
`,
};

if (isMain(import.meta.url)) runPubkeyBundleCli(SPEC);

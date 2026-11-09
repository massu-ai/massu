#!/usr/bin/env node
/**
 * P-H019 (plan-stage-c-high-batch / 1.10.5): Bundle the Ed25519 license-response
 * signing public key into a TypeScript module shipped in dist/security/. The
 * client-side verifier (packages/core/src/security/license-response-verifier.ts)
 * uses this to verify signatures on /validate-key responses.
 *
 * Parallel to scripts/bundle-pubkey.mjs (which bundles the adapter-registry key).
 * Same pattern; different key purpose; different OS-level secret-store guidance:
 *
 *   - Registry-pubkey signing key: stored in macOS Keychain at `massu/registry/signing/private`
 *     for adapter bundle signing during npm publish.
 *   - License-pubkey signing key: stored as Supabase Edge Function env var
 *     `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64` (operator provisions);
 *     used by `website/supabase/functions/validate-key/index.ts` to sign
 *     each license-validation response.
 *
 * Usage:
 *   node scripts/bundle-license-pubkey.mjs           # write generated TS module
 *   node scripts/bundle-license-pubkey.mjs --check   # verify without writing (CI gate)
 *
 * Wire into packages/core/package.json prepublishOnly alongside bundle-pubkey.mjs
 * so every npm publish ships a freshly-bundled license pubkey aligned with the
 * vendored pem.
 */
import { runPubkeyBundleCli, isMain } from './lib/ed25519-pubkey-bundle.mjs';

/**
 * Known RAW-bytes sha256 fingerprints of the Ed25519 license-signing pubkey.
 * Append on rotation; the verifier accepts any entry in this set as trusted
 * during the rotation grace window.
 *
 * Initial fingerprint (generated 2026-05-18 via Node crypto.generateKeyPairSync):
 *   18a63d64fdec9e5a368fc45feaa49bed6ced815967e582bc7b8af534f22a9475
 */
export const KNOWN_PUBKEY_FINGERPRINTS = new Set([
  '18a63d64fdec9e5a368fc45feaa49bed6ced815967e582bc7b8af534f22a9475', // 2026-05-18 (original); kept during the SEC-1 rotation grace window.
  '18c0456789a70eeee28012719f04725f43f59e693f735227ff73f0475f2290e3', // 2026-07-14 (SEC-1 rotation) — new signing key.
]);

/** Everything specific to this key; the shared implementation is scripts/lib/ed25519-pubkey-bundle.mjs. */
export const SPEC = {
  script: 'scripts/bundle-license-pubkey.mjs',
  pem: 'packages/core/security/license-pubkey.pem',
  out: 'packages/core/src/security/license-pubkey.generated.ts',
  knownFingerprints: KNOWN_PUBKEY_FINGERPRINTS,
  missingPemHelp: 'Generate via Node crypto.generateKeyPairSync per the license-key rotation runbook.',
  renderBody: ({ numbers, fingerprint, knownFingerprintsLiteral }) => `/**
 * Ed25519 public key for verifying signed /validate-key responses from
 * massu.ai. Used by packages/core/src/security/license-response-verifier.ts
 * to reject MITM / malicious-cloud-endpoint responses.
 *
 * P-H019 (plan-stage-c-high-batch / 1.10.5).
 *
 * To rotate (full runbook: docs/runbooks/license-response-signing-key-rotation.md):
 * regenerate the keypair, append the new RAW-bytes sha256 to
 * KNOWN_PUBKEY_FINGERPRINTS above (DO NOT delete the old entry during the grace
 * window), AND update PUBKEY_FINGERPRINT_HEX in
 * website/supabase/functions/validate-key/index.ts to the SAME new fingerprint
 * (it is stamped onto every response; a stale stamp is rejected by the client at
 * ed25519-envelope-verifier.ts:111). The order is load-bearing: the operator
 * installs the new secret AND deploys the fingerprint-updated function FIRST
 * (production signs with the new key), and only THEN is the new public key
 * vendored + this bundle regenerated + the client published. Bundling the new
 * client pubkey before production signs with it would make strict-mode clients
 * reject every response.
 */
export const LICENSE_PUBKEY_ED25519: Uint8Array = new Uint8Array([${numbers}]);

/** Hex sha256 of LICENSE_PUBKEY_ED25519 (raw 32 bytes). */
export const LICENSE_PUBKEY_FINGERPRINT_HEX = '${fingerprint}';

/** Allowlist of historically-trusted license pubkey fingerprints. */
export const KNOWN_LICENSE_PUBKEY_FINGERPRINTS: ReadonlySet<string> = new Set(${knownFingerprintsLiteral});
`,
};

if (isMain(import.meta.url)) runPubkeyBundleCli(SPEC);

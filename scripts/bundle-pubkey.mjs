#!/usr/bin/env node
/**
 * Bundle the Ed25519 registry signing public key into a TypeScript module
 * that ships in dist/security/ for runtime signature verification.
 *
 * Plan 3c Phase 5 deliverable (Option A — gap-31, audit-iter-1 fix #4 +
 * iter-4 fix #24): generates packages/core/src/security/registry-pubkey.generated.ts
 * exporting `REGISTRY_PUBKEY_ED25519: Uint8Array` from the on-disk pem at
 * packages/core/security/registry-pubkey.pem. The generated module is
 * checked-in (NOT gitignored) so consumers reading the npm tarball can
 * audit the bundled key. The build:cli esbuild step picks it up via the
 * normal src recursive glob in package.json files[] — no separate copy step required.
 *
 * Usage:
 *   node scripts/bundle-pubkey.mjs           # write generated TS module
 *   node scripts/bundle-pubkey.mjs --check   # verify without writing (CI gate)
 *
 * Wired into packages/core/package.json `prepublishOnly` so every npm publish
 * includes a freshly-bundled pubkey aligned with whatever pem is currently
 * vendored. If the operator rotates the pem between releases, the next
 * `npm publish` automatically ships the new key.
 *
 * Acceptance gate (gap-29 deliverable):
 * - The pem file exists at packages/core/security/registry-pubkey.pem.
 * - The pem parses to exactly 32 raw bytes (Ed25519 public-key length).
 * - The generated TS module exports a Uint8Array whose RAW-bytes sha256
 *   matches one of the recorded fingerprints in this script's
 *   KNOWN_PUBKEY_FINGERPRINTS array. PEM-wrapped sha256 is recorded in the
 *   plan (lines 147-148) for cross-check but is NOT what the verifier
 *   uses — the verifier consumes raw bytes.
 *
 * If the operator rotates the pubkey, append the new RAW-bytes sha256 to
 * KNOWN_PUBKEY_FINGERPRINTS in the same commit that swaps the pem. Old
 * fingerprints stay so historical auditing of `git log --follow` on this
 * file shows the full key-rotation history.
 */
import { runPubkeyBundleCli, isMain } from './lib/ed25519-pubkey-bundle.mjs';

/**
 * Known RAW-bytes sha256 fingerprints of the Ed25519 pubkey. Append (don't
 * replace) on rotation; the verifier accepts ANY entry in this list as the
 * trusted key during the rotation grace window (Plan 3c gap-54).
 * Plan 3c gap-29 (Phase D P4-003 prework) recorded the initial fingerprint:
 *   3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c
 */
export const KNOWN_PUBKEY_FINGERPRINTS = new Set([
  '3b6226d036c472e533110d11a7d0cd2773ce1d7d4f1003517d5bd69c5418ed4c',
]);

/** Everything specific to this key; the shared implementation is scripts/lib/ed25519-pubkey-bundle.mjs. */
export const SPEC = {
  script: 'scripts/bundle-pubkey.mjs',
  pem: 'packages/core/security/registry-pubkey.pem',
  out: 'packages/core/src/security/registry-pubkey.generated.ts',
  knownFingerprints: KNOWN_PUBKEY_FINGERPRINTS,
  missingPemHelp: 'Plan 3c gap-29 requires the pubkey pem to be vendored before bundling; generate via tweetnacl + macOS Keychain per Plan 3c hard prerequisite #3.',
  renderBody: ({ numbers, fingerprint, knownFingerprintsLiteral }) => `/**
 * Ed25519 public key for the Massu adapter registry (registry.massu.ai).
 * Used by packages/core/src/security/adapter-verifier.ts to verify signed
 * manifests. Plan 3c gap-29 (Phase D P4-003) generated and vendored.
 *
 * To rotate: regenerate the keypair (operator-only, store private in
 * macOS Keychain at \`massu/registry/signing/private\`), update
 * packages/core/security/registry-pubkey.pem with the new public key,
 * append the new RAW-bytes sha256 to KNOWN_PUBKEY_FINGERPRINTS in
 * scripts/bundle-pubkey.mjs (DO NOT delete the old entry — rotation grace
 * window per gap-54), then run \`node scripts/bundle-pubkey.mjs\`.
 */
export const REGISTRY_PUBKEY_ED25519: Uint8Array = new Uint8Array([${numbers}]);

/** Hex sha256 of REGISTRY_PUBKEY_ED25519 (raw 32 bytes). */
export const REGISTRY_PUBKEY_FINGERPRINT_HEX = '${fingerprint}';

/**
 * Allowlist of historically-trusted pubkey fingerprints. CR-9 audit L2
 * fix: the runtime verifier asserts that REGISTRY_PUBKEY_FINGERPRINT_HEX
 * is a member of this set; a bundled key that does not appear in the
 * allowlist refuses to load even if compiled in. Mirror of
 * KNOWN_PUBKEY_FINGERPRINTS in scripts/bundle-pubkey.mjs (kept in sync
 * by the bundle script's emit step). Append on rotation; never remove
 * during the grace window.
 */
export const KNOWN_PUBKEY_FINGERPRINTS: ReadonlySet<string> = new Set(${knownFingerprintsLiteral});
`,
};

if (isMain(import.meta.url)) runPubkeyBundleCli(SPEC);

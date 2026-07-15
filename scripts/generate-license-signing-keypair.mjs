#!/usr/bin/env node
/**
 * Generate a fresh Ed25519 license-response signing keypair for rotation
 * (runbook: docs/runbooks/license-response-signing-key-rotation.md, SEC-1).
 *
 * Writes TWO files to a caller-chosen prefix OUTSIDE the repo:
 *   <out>.private.b64  — base64 PKCS#8 private key (the SECRET; chmod 0600)
 *                        install as Supabase secret LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64
 *   <out>.public.pem   — SPKI PEM public key (safe to vendor + bundle)
 *
 * The private key is NEVER printed to stdout and NEVER written inside the repo.
 *
 * Usage:
 *   node scripts/generate-license-signing-keypair.mjs --out ~/.massu/license-signing-2026-07-14
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
if (outIdx === -1 || !args[outIdx + 1]) {
  console.error('ERROR: --out <path-prefix> is required (a path OUTSIDE any git repo, e.g. ~/.massu/license-signing-<date>).');
  process.exit(2);
}
const out = resolve(args[outIdx + 1].replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));

// Refuse to write key material anywhere inside a git repo WORKING TREE — that is
// the actual risk (a committable secret). Walk up from the target looking for a
// `.git`. This is precise: it does not false-reject a scratch/tmp path that merely
// contains "massu" in its name, and it DOES reject ~/massu-internal/... etc.
function isInsideGitRepo(p) {
  let d = dirname(p);
  for (;;) {
    if (existsSync(resolve(d, '.git'))) return true;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}
if (isInsideGitRepo(out)) {
  console.error(`ERROR: refusing to write key material inside a git repo working tree (${out}). Choose a location OUTSIDE any repo, e.g. ~/.massu/.`);
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const privPath = `${out}.private.b64`;
const pubPath = `${out}.public.pem`;
writeFileSync(privPath, privB64 + '\n', { mode: 0o600 });
chmodSync(privPath, 0o600);
writeFileSync(pubPath, pubPem);

console.log('Generated a fresh Ed25519 license-signing keypair.');
console.log(`  private (SECRET, 0600): ${privPath}`);
console.log(`  public  (vendor this) : ${pubPath}`);
console.log('\nNext: follow docs/runbooks/license-response-signing-key-rotation.md (install secret → bundle pubkey → publish → purge history → shred private).');

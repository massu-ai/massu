#!/usr/bin/env node
/**
 * Audit-export signing keypair generator / rotation tool (PA2-002,
 * plan-2026-06-01-enterprise-governance-audit-export).
 *
 * Generates a fresh Ed25519 keypair for the SIGNED AUDIT EXPORT chain:
 *   - PUBLIC key  -> packages/core/security/audit-export-pubkey.pem (SPKI, vendored
 *     + committed; consumed by scripts/bundle-audit-export-pubkey.mjs to regenerate
 *     packages/core/src/security/audit-export-pubkey.generated.ts).
 *   - PRIVATE key -> written ONLY to the --out-private dotenv file (mode 0600).
 *     NEVER printed to stdout, NEVER committed. This is the value of the Supabase
 *     Edge Function secret AUDIT_EXPORT_SIGNING_PRIVATE_KEY_B64 (base64 of the
 *     PKCS8 DER), which website/supabase/functions/audit-export/index.ts imports
 *     via crypto.subtle.importKey('pkcs8', decodeBase64(b64), {name:'Ed25519'}).
 *
 * SINGLE SIGNER (audit iter 5, CR-46): the audit-export edge fn is the SOLE
 * holder + sole signer for BOTH the CLI/programmatic path AND the dashboard path.
 * There is NO Vercel-side signing key — the dashboard server action calls the
 * edge fn server-side with a service-role bearer. So this private key lives in
 * ONE runtime (the Supabase edge secret) with one rotation target.
 *
 * stdout carries ONLY public material (the fingerprint) so it is safe to log.
 *
 * Usage:
 *   node scripts/generate-audit-export-keypair.mjs --out-private <path> [--force]
 *
 * Rotation runbook:
 *   1. node scripts/generate-audit-export-keypair.mjs --out-private /tmp/ax_input.txt --force
 *   2. Update KNOWN_PUBKEY_FINGERPRINTS in scripts/bundle-audit-export-pubkey.mjs
 *      (append the new fingerprint; keep the prior one during a grace window IF
 *      that prior key was ever deployed — if it was never deployed, replace it).
 *   3. node scripts/bundle-audit-export-pubkey.mjs           # regenerate generated.ts
 *   4. supabase secrets set --env-file <out-private> --project-ref <ref>
 *   5. shred -u <out-private>
 *   6. supabase functions deploy audit-export --project-ref <ref>
 *   7. commit the public pem + generated.ts + bundle-script fingerprint change.
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const PUB_PATH = resolve(REPO_ROOT, 'packages/core/security/audit-export-pubkey.pem');
const SECRET_NAME = 'AUDIT_EXPORT_SIGNING_PRIVATE_KEY_B64';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const outPrivate = arg('--out-private');
  const force = process.argv.includes('--force');

  if (!outPrivate) {
    console.error('error: --out-private <path> is required (where the private dotenv line is written).');
    process.exit(2);
  }
  if (existsSync(PUB_PATH) && !force) {
    console.error(`error: ${PUB_PATH} already exists. Re-run with --force to rotate it.`);
    process.exit(2);
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });  // 44 bytes
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const privB64 = pkcs8Der.toString('base64');

  if (spkiDer.length !== 44) {
    console.error(`error: unexpected SPKI length ${spkiDer.length} (expected 44 for Ed25519).`);
    process.exit(1);
  }
  // Same derivation as scripts/bundle-audit-export-pubkey.mjs: sha256 of the raw
  // 32-byte key (SPKI minus its 12-byte header).
  const fp = createHash('sha256').update(spkiDer.subarray(12)).digest('hex');

  writeFileSync(PUB_PATH, pubPem, 'utf-8');
  writeFileSync(outPrivate, `${SECRET_NAME}=${privB64}\n`, { mode: 0o600 });
  chmodSync(outPrivate, 0o600);

  console.log('audit-export keypair generated.');
  console.log(`fingerprint=${fp}`);
  console.log(`pub_written=${PUB_PATH}`);
  console.log(`private_dotenv_written=${outPrivate} (mode 0600 — set the secret then shred it)`);
}

main();

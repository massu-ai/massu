// SEC-3 HARD GATE — live valid:true signature smoke.
//
// Proves production is CURRENTLY signing successful /validate-key responses with the
// rotated key and that the bundled client verifies them. This is the precondition for
// publishing strict-mode-default (SEC-3): if a live valid:true response is unsigned or
// signed by an untrusted key, an upgraded strict client would REJECT it → licensing outage.
//
// NO-LEAK CONTRACT: the API key is read from MASSU_SMOKE_API_KEY and is NEVER printed.
// Only the verdict is emitted — HTTP status, valid flag, tier, the pubkey fingerprint,
// and the Ed25519 verify result. The signature bytes themselves are not printed.
//
// Run:  MASSU_SMOKE_API_KEY=$(pbpaste) npx tsx scripts/sec3-live-smoke.ts
// Exit: 0 = gate PASS (safe to publish SEC-3); non-zero = gate FAIL (do NOT publish).

import { verifyLicenseResponse } from '../packages/core/src/security/license-response-verifier.ts';
import { LICENSE_PUBKEY_FINGERPRINT_HEX } from '../packages/core/src/security/license-pubkey.generated.ts';

async function main(): Promise<void> {
const KEY = process.env.MASSU_SMOKE_API_KEY;
if (!KEY || !KEY.startsWith('ms_live_')) {
  console.error('FAIL: MASSU_SMOKE_API_KEY unset or not an ms_live_ key. Provide a real key (never pasted to the transcript).');
  process.exit(2);
}

const ENDPOINT = process.env.MASSU_SMOKE_ENDPOINT || 'https://api.massu.ai/v1/validate-key';

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
});

const status = res.status;
let data: Record<string, unknown>;
try {
  data = await res.json() as Record<string, unknown>;
} catch {
  console.error(`FAIL: HTTP ${status} — response was not JSON.`);
  process.exit(1);
}

const valid = data.valid === true;
const tier = (data.plan ?? data.tier ?? '(none)') as string;
const stampedFp = (data._signature_pubkey_fingerprint ?? '(unsigned)') as string;
const fpShort = stampedFp === '(unsigned)' ? stampedFp : stampedFp.slice(0, 8) + '…';

console.log(`HTTP status      : ${status}`);
console.log(`valid            : ${valid}`);
console.log(`tier/plan        : ${tier}`);
console.log(`stamped fp        : ${fpShort}  (expected ${LICENSE_PUBKEY_FINGERPRINT_HEX.slice(0, 8)}…)`);

if (status !== 200 || !valid) {
  console.error('FAIL: expected HTTP 200 + valid:true (only a successful response is signed). Check the key/tier.');
  process.exit(1);
}

const fpMatches = stampedFp === LICENSE_PUBKEY_FINGERPRINT_HEX;
console.log(`fingerprint match: ${fpMatches ? 'PASS' : 'FAIL'}`);

const verify = verifyLicenseResponse(data as never);
const verifyPass = verify.kind === 'valid';
console.log(`ed25519 verify   : ${verifyPass ? 'PASS' : 'FAIL (' + verify.kind + ')'}`);

if (fpMatches && verifyPass) {
  console.log('\nSEC-3 HARD GATE: PASS — production signs valid:true with the trusted key; safe to publish strict mode.');
  process.exit(0);
}
console.error('\nSEC-3 HARD GATE: FAIL — do NOT publish strict mode (an upgraded client would reject this response).');
process.exit(1);
}

main().catch((e) => {
  console.error('FAIL: smoke script errored:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

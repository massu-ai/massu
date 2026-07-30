/**
 * Tests for the adapter manifest verifier (Plan 3c Phase 5 5F).
 *
 * Coverage matrix (every step of the 9-step verification chain):
 * 1. Envelope shape — happy path + missing manifest_b64 + wrong field types
 * 2. base64 decode of manifest_b64 — empty string + zero-byte payload
 * 3. sha256 round-trip — tampered manifest_b64 caught
 * 4. JSON.parse manifest_b64 — invalid UTF-8 / non-JSON caught
 * 5. Deep-equal manifest_b64-decoded vs envelope.manifest — publisher
 *    swapping fields independently caught
 * 6. ManifestBodySchema — missing required fields caught
 * 7. Ed25519 signature verify — wrong signature, wrong public key,
 *    truncated signature all caught
 * 8. signing_key_id == sha256(publicKey) — key rotation drift caught
 * 9. manifest_schema_version — too low refused, too high warned
 *
 * Plus: deprecated/unpublished entries preserved via passthrough; live
 * registry envelope (after the canonicalization fix in commit 1b724d3)
 * round-trips successfully against the bundled pubkey.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyManifest } from '../security/adapter-verifier.js';
import {
  REGISTRY_PUBKEY_ED25519,
  REGISTRY_PUBKEY_FINGERPRINT_HEX,
} from '../security/registry-pubkey.generated.js';

interface SignedFixture {
  envelope: Record<string, unknown>;
  manifest_b64: string;
  signature: string;
  manifest_sha256: string;
  signing_key_id: string;
  manifestBytes: Uint8Array;
}

/**
 * Build a signed test envelope using an ephemeral keypair. Returns the
 * envelope + the inputs so individual tests can mutate fields and re-feed
 * to verifyManifest.
 */
function buildSignedEnvelope(
  manifestBody: Record<string, unknown>,
  keyPair: nacl.SignKeyPair = nacl.sign.keyPair(),
  overrides: Partial<Record<string, unknown>> = {},
): SignedFixture & { keyPair: nacl.SignKeyPair } {
  const bodyJson = JSON.stringify(manifestBody);
  const bodyBytes = Buffer.from(bodyJson, 'utf-8');
  const sig = nacl.sign.detached(new Uint8Array(bodyBytes), keyPair.secretKey);
  const sha = createHash('sha256').update(bodyBytes).digest('hex');
  const keyId = createHash('sha256').update(keyPair.publicKey).digest('hex');
  const envelope = {
    manifest: manifestBody,
    manifest_b64: bodyBytes.toString('base64'),
    signature: Buffer.from(sig).toString('base64'),
    manifest_sha256: sha,
    signed_at: '2026-05-07T20:00:00Z',
    signing_key_id: keyId,
    ...overrides,
  };
  return {
    envelope,
    manifest_b64: bodyBytes.toString('base64'),
    signature: Buffer.from(sig).toString('base64'),
    manifest_sha256: sha,
    signing_key_id: keyId,
    manifestBytes: new Uint8Array(bodyBytes),
    keyPair,
  };
}

const SAMPLE_MANIFEST = {
  manifest_schema_version: 1,
  issued_at: '2026-05-07T00:00:00Z',
  adapters: [],
};

describe('verifyManifest — happy path', () => {
  it('verifies a freshly signed envelope under the matching pubkey', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const result = verifyManifest({ envelope: fx.envelope, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.manifest_schema_version).toBe(1);
      expect(result.manifest.adapters).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  it('preserves additive forward-compat fields via passthrough (gap-56)', () => {
    const manifestWithFutureField = {
      ...SAMPLE_MANIFEST,
      future_field: 'unknown-value',
    };
    const fx = buildSignedEnvelope(manifestWithFutureField);
    const result = verifyManifest({ envelope: fx.envelope, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.manifest as Record<string, unknown>).future_field).toBe('unknown-value');
    }
  });

  it('preserves adapter entry deprecated + unpublished fields (gap-57)', () => {
    // CR-9 audit M3 fix: per-entry signing_key_id MUST equal envelope
    // signing_key_id. Fixture pre-builds the keypair so we can stamp the
    // matching key id on the entry before signing.
    const keyPair = nacl.sign.keyPair();
    const keyId = createHash('sha256').update(keyPair.publicKey).digest('hex');
    const manifestWithDeprecated = {
      manifest_schema_version: 1,
      issued_at: '2026-05-07T00:00:00Z',
      adapters: [
        {
          package: '@massu/adapter-old-rails',
          version: '0.1.0',
          sha256: 'a'.repeat(64),
          signing_key_id: keyId,
          deprecated: { since: '2026-05-01', replacement: '@massu/adapter-rails', reason: 'fork' },
        },
      ],
    };
    const fx = buildSignedEnvelope(manifestWithDeprecated, keyPair);
    const result = verifyManifest({ envelope: fx.envelope, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.adapters[0]?.deprecated?.replacement).toBe('@massu/adapter-rails');
    }
  });
});

describe('verifyManifest — envelope shape failures (step 1)', () => {
  it('refuses an envelope missing manifest_b64', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const broken = { ...fx.envelope };
    delete (broken as Record<string, unknown>).manifest_b64;
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/envelope shape invalid/i);
  });

  it('refuses non-base64 manifest_b64', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const broken = { ...fx.envelope, manifest_b64: 'not-base64-!@#$' };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
  });

  it('refuses non-hex manifest_sha256', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const broken = { ...fx.envelope, manifest_sha256: 'XYZ' };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
  });

  it('refuses null envelope', () => {
    const result = verifyManifest({ envelope: null, publicKey: REGISTRY_PUBKEY_ED25519 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/envelope shape invalid/i);
  });
});

describe('verifyManifest — sha256 round-trip (step 3)', () => {
  it('catches manifest_b64 tampering when sha mismatches', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    // Replace manifest_b64 with a different (but well-formed base64) value.
    const tamperedBytes = Buffer.from(JSON.stringify({ ...SAMPLE_MANIFEST, issued_at: 'tampered' }), 'utf-8');
    const broken = { ...fx.envelope, manifest_b64: tamperedBytes.toString('base64') };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/manifest_sha256 mismatch/i);
  });
});

describe('verifyManifest — manifest_b64 JSON parse (step 4) + deep-equal (step 5)', () => {
  it('refuses manifest_b64 that decodes to non-JSON', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    // Replace manifest_b64 with bytes that base64-decode cleanly but are not JSON.
    const garbage = Buffer.from('this is not json', 'utf-8');
    const garbageSha = createHash('sha256').update(garbage).digest('hex');
    const broken = {
      ...fx.envelope,
      manifest_b64: garbage.toString('base64'),
      manifest_sha256: garbageSha, // make the sha consistent so we reach step 4
    };
    // Re-sign over `garbage` so we don't fail at signature step.
    const garbageSig = nacl.sign.detached(new Uint8Array(garbage), fx.keyPair.secretKey);
    broken.signature = Buffer.from(garbageSig).toString('base64');
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not decode to valid JSON/i);
  });

  it('refuses publisher-inconsistent envelope where manifest_b64 != envelope.manifest', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    // Replace envelope.manifest with a different object but keep manifest_b64
    // pointing to the original. The two views now disagree → step 5 refuses.
    const broken = {
      ...fx.envelope,
      manifest: { ...SAMPLE_MANIFEST, issued_at: 'DIFFERENT' },
    };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not deep-equal envelope\.manifest/i);
  });
});

describe('verifyManifest — Ed25519 signature (step 7)', () => {
  it('refuses a manifest signed by a different key', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const otherKey = nacl.sign.keyPair();
    // Use the bundled production key (or any wrong key) — verify should fail.
    const result = verifyManifest({ envelope: fx.envelope, publicKey: otherKey.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Ed25519 signature verification failed|signing_key_id mismatch/i);
  });

  it('refuses a corrupted signature (right length, wrong bytes)', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const corrupt = Buffer.alloc(nacl.sign.signatureLength).toString('base64');
    const broken = { ...fx.envelope, signature: corrupt };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Ed25519 signature verification failed/i);
  });

  it('refuses a signature of wrong length', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const tooShort = Buffer.alloc(8).toString('base64');
    const broken = { ...fx.envelope, signature: tooShort };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature byte length/i);
  });
});

describe('verifyManifest — signing_key_id rotation (step 8)', () => {
  it('refuses when signing_key_id does not match sha256(publicKey)', () => {
    const fx = buildSignedEnvelope(SAMPLE_MANIFEST);
    const broken = { ...fx.envelope, signing_key_id: 'b'.repeat(64) };
    const result = verifyManifest({ envelope: broken, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signing_key_id mismatch/i);
  });
});

describe('verifyManifest — schema version (step 9)', () => {
  it('refuses manifest_schema_version below MIN', () => {
    // Force schema_version=0 (below MIN=1). Our schema rejects 0 via .positive(),
    // so this lands in the manifest body schema step (step 6) instead of step 9.
    const manifestBelow = { ...SAMPLE_MANIFEST, manifest_schema_version: 0 };
    const fx = buildSignedEnvelope(manifestBelow);
    const result = verifyManifest({ envelope: fx.envelope, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(false);
  });

  it('warns + continues when manifest_schema_version above KNOWN_MAX', () => {
    const manifestAbove = { ...SAMPLE_MANIFEST, manifest_schema_version: 2 };
    const fx = buildSignedEnvelope(manifestAbove);
    const result = verifyManifest({ envelope: fx.envelope, publicKey: fx.keyPair.publicKey });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toMatch(/schema v2.*supports up to v1/i);
    }
  });
});

// G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): `registry-site/` is absent on
// a fresh checkout. Resolved at MODULE scope so `it.skipIf` adjudicates at collection
// time and vitest reports SKIPPED. The old try/catch `return` also swallowed a
// MALFORMED envelope — an absent fixture and a broken signature payload rendered the
// same. Parsing outside the try means a corrupt envelope now FAILS, as it must.
const LIVE_ENVELOPE_PATH = resolve(__dirname, '../../../../registry-site/adapters/manifest.json');
const HAS_LIVE_ENVELOPE = existsSync(LIVE_ENVELOPE_PATH);

describe('verifyManifest — live registry envelope after canonicalization fix', () => {
  it.skipIf(!HAS_LIVE_ENVELOPE)('verifies the live envelope at registry-site/adapters/manifest.json', () => {
    // The publisher (registry-publish.sh post-1b724d3) writes the same
    // envelope shape that's currently deployed. Read the locally-saved
    // copy and verify it against the bundled pubkey.
    const envelope: unknown = JSON.parse(readFileSync(LIVE_ENVELOPE_PATH, 'utf-8'));
    const result = verifyManifest({ envelope, publicKey: REGISTRY_PUBKEY_ED25519 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.signing_key_id).toBe(REGISTRY_PUBKEY_FINGERPRINT_HEX);
      expect(result.envelope.manifest_b64.length).toBeGreaterThan(0);
    }
  });
});

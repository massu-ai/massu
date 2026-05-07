/**
 * Adapter manifest signature + integrity verifier.
 *
 * Plan 3c Phase 5 deliverable (5F). The center of the supply-chain trust
 * chain: every REGISTRY-VERIFIED adapter load (per the three-class trust
 * model in adapter-origin.ts) goes through this module before the loader
 * accepts it. Verification fails CLOSED — any failure path returns
 * { ok: false, reason } and the loader refuses to load.
 *
 * Verification chain (all checks MUST pass):
 *
 * 1. Envelope shape passes EnvelopeSchema (manifest, manifest_b64,
 *    signature, manifest_sha256, signed_at, signing_key_id all present
 *    and well-typed).
 * 2. base64-decode(envelope.manifest_b64) yields raw bytes B.
 * 3. sha256(B) hex == envelope.manifest_sha256.
 * 4. JSON.parse(B as utf-8) succeeds.
 * 5. The parsed JSON deep-equals envelope.manifest (defense against
 *    publisher swapping the manifest_b64 and manifest fields independently).
 * 6. ManifestBodySchema accepts the parsed JSON.
 * 7. nacl.sign.detached.verify(B, base64-decode(signature), publicKey)
 *    returns true. publicKey is the bundled REGISTRY_PUBKEY_ED25519
 *    (caller passes it; default is the bundle from registry-pubkey.generated.ts).
 * 8. envelope.signing_key_id == sha256(publicKey hex). This is the
 *    drift-detection mechanism for key rotation (Plan 3c gap-54): a
 *    stale @massu/core that holds an old pubkey reading a manifest
 *    signed by the new pubkey will see signing_key_id mismatch and
 *    refuse — the cache is then marked STALE-DUE-TO-ROTATION (handled
 *    by the cache module, not here).
 * 9. manifest.manifest_schema_version >= MIN_KNOWN_SCHEMA_VERSION (else
 *    REFUSE — a future v2 that drops fields v1 expects is incompatible).
 *    > KNOWN_MAX_SCHEMA_VERSION → continue with warning (additive
 *    forward-compat per gap-56).
 *
 * Why every step matters:
 * - Step 3 catches manifest_b64 tampering (someone swapped the bytes
 *   between the publisher's signing and the consumer's verify).
 * - Step 5 catches publisher bugs that emit two non-equal views of
 *   the same field (this is the canonicalization-gap class — the
 *   publisher's self-check at registry-publish.sh enforces the same
 *   invariant before deploy, but we re-check on the consumer side).
 * - Step 7 is the actual signature verification.
 * - Step 8 protects against attackers who know an old key — they can
 *   sign a valid manifest under the old key, but signing_key_id will
 *   mismatch the bundled pubkey and the loader refuses.
 *
 * Test fixtures sign against the real Phase D Ed25519 private key via
 * `bash scripts/sign-fixture-manifest.sh` (operator-runs, reads from
 * macOS Keychain) producing signed envelopes that round-trip the verifier
 * end-to-end without needing the live registry.
 */
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { z } from 'zod';
import {
  EnvelopeSchema,
  ManifestBodySchema,
  KNOWN_MAX_SCHEMA_VERSION,
  MIN_KNOWN_SCHEMA_VERSION,
  type Envelope,
  type ManifestBody,
} from './manifest-schema.js';
import { REGISTRY_PUBKEY_ED25519 } from './registry-pubkey.generated.js';

export interface VerifyManifestInput {
  /** Raw envelope JSON, parsed but not yet validated. */
  envelope: unknown;
  /**
   * The bundled Ed25519 public key (32 raw bytes). Caller passes the
   * bundled key from registry-pubkey.generated.ts. Test-only override
   * to swap keys for fixture signing.
   */
  publicKey?: Uint8Array;
}

export type VerifyManifestResult =
  | { ok: true; envelope: Envelope; manifest: ManifestBody; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Compute sha256 hex of raw bytes. Helper used at multiple verification
 * steps; centralized to avoid drift between callsites.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Deep-equal check for the parsed JSON tree of envelope.manifest vs the
 * JSON parsed from base64-decode(envelope.manifest_b64). Both inputs come
 * from the same envelope so they MUST be deep-equal — any mismatch is a
 * publisher bug or active tampering. Uses canonical JSON.stringify with
 * sorted keys so the comparison ignores key-order differences.
 */
function jsonDeepEqualByCanonical(a: unknown, b: unknown): boolean {
  const ca = canonicalJsonStringify(a);
  const cb = canonicalJsonStringify(b);
  return ca === cb;
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  if (typeof value === 'object' && value !== undefined) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Verify a registry adapter manifest envelope. See module-level doc for the
 * full chain. Returns ok=true with parsed envelope+manifest+warnings on
 * success, or ok=false with a specific reason on any failure.
 *
 * This function does NOT cache, NOT fetch, and NOT mutate any state. Pure
 * verification of a given input. The caller (cache module + CLI) is
 * responsible for cache I/O and refusing-to-load semantics.
 */
export function verifyManifest(input: VerifyManifestInput): VerifyManifestResult {
  const publicKey = input.publicKey ?? REGISTRY_PUBKEY_ED25519;
  const warnings: string[] = [];

  // Step 1 — envelope shape
  const envelopeParsed = EnvelopeSchema.safeParse(input.envelope);
  if (!envelopeParsed.success) {
    const issues = envelopeParsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: `envelope shape invalid: ${issues}` };
  }
  const envelope = envelopeParsed.data;

  // Step 2 — base64-decode manifest_b64
  let manifestBytes: Buffer;
  try {
    manifestBytes = Buffer.from(envelope.manifest_b64, 'base64');
  } catch (err) {
    return { ok: false, reason: `manifest_b64 base64 decode failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (manifestBytes.length === 0) {
    return { ok: false, reason: 'manifest_b64 decoded to zero bytes' };
  }

  // Step 3 — sha256 round-trip
  const computedSha = sha256Hex(manifestBytes);
  if (computedSha !== envelope.manifest_sha256) {
    return {
      ok: false,
      reason:
        `manifest_sha256 mismatch: computed ${computedSha}, envelope claims ${envelope.manifest_sha256}. ` +
        `manifest_b64 was tampered with after signing.`,
    };
  }

  // Step 4 — JSON.parse manifest_b64 bytes
  let manifestFromBytes: unknown;
  try {
    manifestFromBytes = JSON.parse(manifestBytes.toString('utf-8'));
  } catch (err) {
    return {
      ok: false,
      reason: `manifest_b64 does not decode to valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 5 — deep-equal vs envelope.manifest
  if (!jsonDeepEqualByCanonical(manifestFromBytes, envelope.manifest)) {
    return {
      ok: false,
      reason:
        `manifest_b64 (decoded) does not deep-equal envelope.manifest field. ` +
        `Publisher emitted inconsistent envelope — refusing to trust either view.`,
    };
  }

  // Step 6 — manifest body schema
  const manifestParsed = ManifestBodySchema.safeParse(manifestFromBytes);
  if (!manifestParsed.success) {
    const issues = manifestParsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: `manifest body shape invalid: ${issues}` };
  }
  const manifest = manifestParsed.data;

  // Step 7 — Ed25519 signature verify
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(envelope.signature, 'base64');
  } catch (err) {
    return { ok: false, reason: `signature base64 decode failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (signatureBytes.length !== nacl.sign.signatureLength) {
    return {
      ok: false,
      reason: `signature byte length ${signatureBytes.length} != expected ${nacl.sign.signatureLength}`,
    };
  }
  if (publicKey.length !== nacl.sign.publicKeyLength) {
    return {
      ok: false,
      reason: `publicKey byte length ${publicKey.length} != expected ${nacl.sign.publicKeyLength}`,
    };
  }
  const sigOk = nacl.sign.detached.verify(
    new Uint8Array(manifestBytes),
    new Uint8Array(signatureBytes),
    publicKey,
  );
  if (!sigOk) {
    return {
      ok: false,
      reason: `Ed25519 signature verification failed against bundled public key ` +
        `(fingerprint ${sha256Hex(publicKey).slice(0, 16)}...). ` +
        `Manifest was either signed by a different key OR the signature is corrupt.`,
    };
  }

  // Step 8 — signing_key_id matches sha256(publicKey)
  const expectedKeyId = sha256Hex(publicKey);
  if (envelope.signing_key_id !== expectedKeyId) {
    return {
      ok: false,
      reason:
        `signing_key_id mismatch: envelope claims ${envelope.signing_key_id}, ` +
        `bundled pubkey sha256 is ${expectedKeyId}. ` +
        `This indicates a key rotation; cache must refresh from the live registry, ` +
        `or @massu/core must be upgraded to a version with the new bundled pubkey.`,
    };
  }

  // Step 9 — schema version compat
  if (manifest.manifest_schema_version < MIN_KNOWN_SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `manifest_schema_version ${manifest.manifest_schema_version} < MIN ${MIN_KNOWN_SCHEMA_VERSION}. ` +
        `This @massu/core does not support reading this manifest; upgrade required.`,
    };
  }
  if (manifest.manifest_schema_version > KNOWN_MAX_SCHEMA_VERSION) {
    warnings.push(
      `Adapter registry uses schema v${manifest.manifest_schema_version}, this @massu/core ` +
      `supports up to v${KNOWN_MAX_SCHEMA_VERSION}. Some adapter metadata may be ignored. ` +
      `Upgrade @massu/core to access new features.`,
    );
  }

  return { ok: true, envelope, manifest, warnings };
}

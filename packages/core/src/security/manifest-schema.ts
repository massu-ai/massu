/**
 * Zod schemas for the registry adapter manifest envelope and body.
 *
 * Plan 3c Phase 5 deliverable. The publisher (registry-publish.sh, version
 * with manifest_b64 — see project_plan_3c_phase5_canonicalization_gap.md
 * memory + commit 1b724d3) emits envelopes matching EnvelopeSchema; the
 * verifier (adapter-verifier.ts) consumes ParsedEnvelope. The body inside
 * manifest_b64 (base64-decoded) parses against ManifestBodySchema.
 *
 * Forward-compatibility model (Plan 3c gap-56):
 * - Manifest body has `manifest_schema_version: 1` (integer, default 1 if
 *   absent for legacy pre-3c manifests).
 * - Schemas use `.passthrough()` so unknown additive keys (gap-57
 *   `deprecated`, `unpublished`, future `revoked_at` etc.) are preserved
 *   on parse — verifier emits a one-time stderr warning when
 *   manifest_schema_version > KNOWN_MAX (NOT a refusal — additive
 *   forward-compat).
 * - manifest_schema_version < MIN_KNOWN_VERSION → verifier REFUSES (a
 *   future v2 may drop fields v1 consumers expect).
 *
 * Single source of truth: this is the ONLY definition of the envelope and
 * manifest shapes in @massu/core. Other modules (verifier, cache, CLI) MUST
 * import these schemas + their inferred types instead of re-declaring.
 */
import { z } from 'zod';

/** Minimum schema version this @massu/core build accepts. Below this → refuse. */
export const MIN_KNOWN_SCHEMA_VERSION = 1 as const;
/** Maximum schema version this @massu/core build understands. Above this → warn + continue. */
export const KNOWN_MAX_SCHEMA_VERSION = 1 as const;

/** sha256 hex string. 64 lowercase hex chars. */
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex must be 64 lowercase hex chars');

/** Standard base64 (RFC 4648) — alphabet [A-Za-z0-9+/], optional `=` padding, no newlines. */
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be standard base64 (no newlines, A-Za-z0-9+/=)').min(1);

/**
 * Single adapter entry in the manifest. Plan 3c gap-31 + gap-57:
 * - `package` + `version` + `sha256` are the install-time + load-time
 *   verification primitives.
 * - `signing_key_id` is the sha256 fingerprint of the pubkey that signed
 *   THIS entry (per gap-61, v1 always uses the single registry key).
 * - `deprecated` (gap-57) — additive optional. Loader warns + still loads.
 * - `unpublished` (gap-57) — additive optional. Loader REFUSES to load.
 * - `.passthrough()` preserves unknown additive fields (gap-56 forward-compat).
 */
export const AdapterEntrySchema = z.object({
  package: z.string().min(1),
  version: z.string().min(1),
  sha256: Sha256HexSchema,
  signing_key_id: Sha256HexSchema,
  deprecated: z.object({
    since: z.string().min(1),
    replacement: z.string().nullable().optional(),
    reason: z.string().min(1),
  }).optional(),
  unpublished: z.boolean().optional(),
}).passthrough();
export type AdapterEntry = z.infer<typeof AdapterEntrySchema>;

/**
 * Manifest body — the JSON object inside base64-decoded `manifest_b64`.
 * Plan 3c gap-56: schema_version is a numeric integer. Defaults to 1 if
 * absent (legacy pre-3c manifests) so the verifier can still read them
 * during the rollout transition.
 */
export const ManifestBodySchema = z.object({
  manifest_schema_version: z.number().int().positive().default(1),
  issued_at: z.string().min(1),
  adapters: z.array(AdapterEntrySchema),
}).passthrough();
export type ManifestBody = z.infer<typeof ManifestBodySchema>;

/**
 * Full envelope as served by registry.massu.ai/adapters/manifest.json AND
 * cached at ~/.massu/adapter-manifest.json. Plan 3c canonicalization-gap
 * fix (commit 1b724d3): manifest_b64 is the byte-equal-to-signed-input
 * field; verifier MUST consume manifest_b64 (NOT the parsed `manifest`
 * field, which is a human-readable re-serialization that does NOT round-
 * trip to the signed bytes).
 */
export const EnvelopeSchema = z.object({
  manifest: ManifestBodySchema,
  manifest_b64: Base64Schema,
  signature: Base64Schema,
  manifest_sha256: Sha256HexSchema,
  signed_at: z.string().min(1),
  signing_key_id: Sha256HexSchema,
}).passthrough();
export type Envelope = z.infer<typeof EnvelopeSchema>;

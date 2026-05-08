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

/**
 * Printable ASCII string — 0x20 to 0x7e, length 1+. Rejects control
 * characters (including ESC \x1b for ANSI escapes), tabs, newlines, and
 * any non-ASCII Unicode. Used for fields that get rendered to stderr or
 * stdout in the CLI; without this constraint, an attacker could embed
 * ANSI escape sequences in (manifest entry version, package.json name,
 * sidecar version, etc.) to log-inject CI/operator-terminal output.
 *
 * CR-9 iter-4 audit single-source-of-truth (LOW-NEW4-1/2/3 fix): every
 * schema field that's downstream of a stderr/stdout emit MUST use this
 * type instead of bare z.string(). Adding a new string field that's
 * later rendered in CLI output without reaching for this type is a
 * regression worth catching at code review.
 */
export const PrintableAsciiStringSchema = z.string().min(1).regex(
  /^[\x20-\x7e]+$/,
  'must be printable ASCII (0x20-0x7e); control characters like ESC, tab, newline, and non-ASCII are rejected to prevent log injection',
);

/**
 * Standard base64 (RFC 4648) — alphabet [A-Za-z0-9+/], length must be a
 * multiple of 4 (with up to two `=` padding chars), no newlines.
 * CR-9 audit L1 fix: the prior `^[A-Za-z0-9+/]*={0,2}$` regex permitted a
 * lone `=` (decodes to zero bytes) which downstream code would parse as
 * a valid empty input. The strict RFC 4648 form below rejects malformed
 * base64 at the schema layer instead of relying on a downstream length
 * check.
 */
const Base64Schema = z.string()
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/,
    'must be standard base64 (RFC 4648; length divisible by 4 with optional == or = padding)',
  )
  .min(1);

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
  // CR-9 iter-4 audit LOW-NEW4-3 fix: every string field rendered in CLI
  // output (discover.ts deprecation warning + adapters.ts search status)
  // uses PrintableAsciiStringSchema to prevent log-injection from a
  // compromised registry. The trust model assumes the registry can be
  // adversarial pre-signing; the verifier's signature check + this
  // schema together neutralize that vector.
  package: PrintableAsciiStringSchema,
  version: PrintableAsciiStringSchema,
  sha256: Sha256HexSchema,
  signing_key_id: Sha256HexSchema,
  deprecated: z.object({
    since: PrintableAsciiStringSchema,
    replacement: PrintableAsciiStringSchema.nullable().optional(),
    reason: PrintableAsciiStringSchema,
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

/**
 * memory-origin.ts — ONE origin vocabulary, ONE predicate, ONE source of truth.
 *
 * WHY THIS EXISTS (Living Memory Slice 5, A-01):
 * A memory row's `origin` says WHERE its content came from. It is the seam that
 * keeps a memory synced from ANOTHER repo (Slice 5) from ever being rendered to
 * this repo's disk as if the human here wrote it. Slice 4B shipped the renderer
 * gate as an INLINE literal (`if (c.origin !== 'local')`, memory-renderer.ts) but
 * never extracted the vocabulary — so "what counts as local" lived in a single
 * string comparison with no shared definition. This module is that definition.
 *
 * THE INVARIANT: there is exactly ONE place in `packages/core/src` that declares
 * the origin literal set (this file). Every other site asks a PREDICATE here —
 * never re-compares against a bare `'local'`. Enforced by
 * `memory-origin-drift-guard.test.ts`.
 *
 * FAIL-CLOSED: `null` / `undefined` / `''` are NOT local. A row with a missing or
 * empty origin is treated as untrusted (refused by the renderer), never as local.
 * "Absence of a local stamp" must never read as "safe to write to the human's disk."
 *
 * The `observations.origin` and `memory_files.origin` COLUMNS already exist
 * (added by Slice 4B, memory-db.ts:382 / :821, `TEXT NOT NULL DEFAULT 'local'`).
 * This module adds NO column and re-declares NO default — it only interprets the
 * value those columns hold.
 */

/**
 * The closed set of memory origins.
 *  - `local`        — authored in THIS repo (the human, or a machine render the
 *                     human's on-disk file stands behind). The ONLY origin the
 *                     renderer will write to disk.
 *  - `repo:<uuid>`  — surfaced from another of the operator's repos (Slice 5).
 *                     `<uuid>` is the origin repo's `repo_id` (a v4 UUID).
 *  - `team`         — a team-shared promotion (CR-55).
 *  - `pack`         — a curated rule pack (CR-55).
 */
export type MemoryOrigin = 'local' | `repo:${string}` | 'team' | 'pack';

/** The one canonical local-origin literal. Nothing else may spell it. */
export const LOCAL_ORIGIN = 'local';

/**
 * Is this origin the trusted local one? FAIL-CLOSED: only the exact literal
 * `'local'` is local; `null` / `undefined` / `''` / any other value is NOT.
 */
export function isLocalOrigin(o: string | null | undefined): boolean {
  return o === LOCAL_ORIGIN;
}

/**
 * A canonical cross-repo origin is `repo:` followed by a v4-shaped UUID
 * (`8-4-4-4-12` lowercase hex). Anything else — including `repo:` with a
 * malformed id — is NOT a recognized cross-repo origin (fail-closed).
 */
const CROSS_REPO_ORIGIN_RE =
  /^repo:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True iff `o` is a well-formed `repo:<uuid>` cross-repo origin. */
export function isCrossRepoOrigin(o: string | null | undefined): boolean {
  return typeof o === 'string' && CROSS_REPO_ORIGIN_RE.test(o);
}

/**
 * Extract the origin repo's `repo_id` from a `repo:<uuid>` origin, or `null` if
 * `o` is not a well-formed cross-repo origin. Never throws.
 */
export function parseOriginRepoId(o: string | null | undefined): string | null {
  if (!isCrossRepoOrigin(o as string)) return null;
  return (o as string).slice('repo:'.length);
}

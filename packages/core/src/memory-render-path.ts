/**
 * B-02 — where a rendered memory is allowed to land.
 *
 * A memory's frontmatter `name` is HUMAN PROSE, not a filename. In the operator's real
 * corpus three names contain a `/` and fourteen are not valid filenames at all (spaces,
 * parens, em-dashes, `+`, `↔`). The renderer's original design wrote `memory/<name>.md`
 * — which is an ARBITRARY FILE WRITE primitive: `../../CLAUDE.md` is one memory away.
 *
 * So the only thing that may become a filename is a validated slug, and the only place
 * it may land is inside the memory directory, proven by the shared symlink-aware
 * containment check. Both are imported, not reimplemented (F-05: two copies of a
 * containment check is how a containment check ends up containing nothing).
 */
import { existsSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import {
  assertContainedIn,
  memoryFileSlug,
  deriveSlug,
  SLUG_ALLOWED,
  PathEscapeError,
} from './lib/safe-write.ts';

/** A memory that is a candidate for rendering. */
export interface RenderSource {
  observationId: number;
  /** The frontmatter `name` — untrusted human prose. NEVER joined into a path. */
  name: string;
  /** The observation title. Used as the deterministic collision discriminator. */
  title: string;
}

export class RenderPathRefused extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'RenderPathRefused';
  }
}

/**
 * Compute the absolute path a memory renders to, or throw `RenderPathRefused`.
 *
 * COLLISION (F-22). `deriveSlug` truncates at 60 chars and the operator's corpus is
 * full of long near-identical names — so two DISTINCT memories can slug to the SAME
 * file, and one render would silently clobber the other, every session, forever.
 *
 * The resolution is deterministic, never counter-based:
 *   1. Try the bare slug. If it is free, or already belongs to THIS observation, take it.
 *   2. If it is taken by a DIFFERENT observation, append `_<hash8>` where hash8 is
 *      derived from this memory's own identity. The same memory therefore always
 *      renders to the same path — a counter (`_2`, `_3`) would renumber files whenever
 *      the iteration order changed, which is a rename storm in a git-tracked directory.
 *   3. If even that is taken by a different observation, REFUSE. Never overwrite.
 */
export function computeRenderPath(
  memoryDir: string,
  src: RenderSource,
  ownerOfRelPath: (relPath: string) => number | undefined
): { absPath: string; relPath: string } {
  // The name must slug to something nonempty and safe.
  //
  // ⚠ `deriveSlug` does NOT signal failure: when it strips the input to nothing it
  // returns the literal fallback `'rule_candidate'` (safe-write.ts:201, inherited from
  // the applier, where a fallback name is harmless). Here it is NOT harmless — a memory
  // named `///` would render to `rule_candidate.md`, which is an INVENTED IDENTITY, and
  // every unsluggable memory in the corpus would collide on that one filename. So test
  // the input for renderability directly rather than trusting the fallback.
  if (!/[a-z0-9]/i.test(src.name)) {
    throw new RenderPathRefused(
      `name has no alphanumeric content and cannot become a filename: ${JSON.stringify(src.name)}`,
      'unsluggable_name'
    );
  }
  const base = deriveSlug(src.name);
  if (!base || !SLUG_ALLOWED.test(base)) {
    throw new RenderPathRefused(
      `name does not slug to a safe filename: ${JSON.stringify(src.name)}`,
      'unsluggable_name'
    );
  }

  const candidates = [
    `${base}.md`,
    // Deterministic discriminator, keyed on the memory's own identity.
    `${memoryFileSlug(src.name, `${src.observationId}:${src.title}`)}.md`,
  ];

  for (const relPath of candidates) {
    const owner = ownerOfRelPath(relPath);
    if (owner !== undefined && owner !== src.observationId) continue; // taken by another memory
    // Containment is checked on EVERY candidate, not just the first — a slug is not a
    // proof of safety, it is an input to one.
    try {
      const absPath = assertContainedIn(memoryDir, relPath); // flat: no nesting in the memory dir
      return { absPath, relPath };
    } catch (err) {
      throw new RenderPathRefused(
        `refused to render ${JSON.stringify(src.name)}: ${(err as Error).message}`,
        err instanceof PathEscapeError ? 'path_escape' : 'containment_error'
      );
    }
  }

  // Two distinct memories collided on both the bare slug AND the discriminated slug.
  // Astronomically unlikely; refuse and log rather than overwrite a real memory.
  throw new RenderPathRefused(
    `slug collision could not be resolved for ${JSON.stringify(src.name)}`,
    'unresolvable_collision'
  );
}

/** Build the `ownerOfRelPath` lookup from the store. `rel_path` is IDENTITY (F-14). */
export function relPathOwnerLookup(db: Database.Database): (relPath: string) => number | undefined {
  // COLLATE NOCASE: macOS and Windows fold case — `Foo.md` and `foo.md` are ONE file
  // on disk, and the store must not believe they are two.
  const stmt = db.prepare(
    `SELECT observation_id FROM memory_files WHERE rel_path = ? COLLATE NOCASE`
  );
  return (relPath: string): number | undefined => {
    const row = stmt.get(relPath) as { observation_id: number | null } | undefined;
    return row?.observation_id ?? undefined;
  };
}

/**
 * A file already on disk that we have no store row for still OWNS its path. Rendering
 * over it would destroy a human file we simply have not ingested yet — the "absence of
 * evidence is not evidence of absence" law.
 */
export function pathIsFreeOnDisk(memoryDir: string, relPath: string): boolean {
  return !existsSync(join(memoryDir, relPath));
}

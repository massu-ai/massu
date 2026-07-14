// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Memory File Auto-Ingest
// Shared module for parsing memory/*.md files and ingesting
// their YAML frontmatter + content into the observations table.
// Used by: post-tool-use.ts, memory-tools.ts, init.ts
// ============================================================

import type Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { basename as pathBasename } from 'path';
import { createHash } from 'crypto';
import {
  addObservation,
  MEMORY_FILE_TITLE_PREFIX,
  MEMORY_FILE_TITLE_LIKE,
} from './memory-db.ts';

/**
 * A-16 — the ONE way to turn a memory file's path into its name.
 *
 * Ingest used an UNANCHORED `.replace('.md', '')` while reconcile used an
 * anchored `/\.md$/`, so `a.mdb.md` ingested as `ab.md` but reconciled as
 * `a.mdb` — the row matched neither live set and was retired on EVERY session
 * start, then recreated on the next write. Ingest also split on '/' only, so on
 * Windows the "basename" was the entire path.
 *
 * `path.basename` handles both separators; the strip is anchored.
 */
export function stripMdExtension(filePathOrName: string): string {
  return pathBasename(filePathOrName).replace(/\.md$/, '');
}

/**
 * A-06 (D1) — read the frontmatter key the corpus ACTUALLY writes.
 *
 * Ingest read a TOP-LEVEL `type:`. The real corpus nests it under `metadata:`
 * (55 of 69 files; only 14 are top-level, and the overlap is zero). So every
 * nested file — which is to say every one of the operator's Laws — landed as the
 * generic `'discovery'` default, and recall ranked them as generic discoveries.
 *
 * The bug survived because EVERY test fixture used the top-level shape: the suite
 * was green while production drifted. Both shapes are now read, nested first
 * (that is what the tooling writes), and the drift-guard asserts that the key
 * ingest READS is a key the corpus WRITES.
 *
 * `confidence` had the identical latent nesting bug — masked only because no file
 * in the corpus sets it yet. A future nested `confidence:` would have silently
 * done nothing.
 */
/**
 * A-06b — recover a memory's scalar frontmatter when strict YAML refuses it.
 *
 * Not a YAML implementation: a deliberately narrow line scan for the four scalar
 * keys ingest needs, at top level or nested one level under `metadata:`. Values
 * are taken verbatim to end-of-line (so an unquoted `description:` containing
 * ': ' — the exact construct that breaks `parseYaml` on two of the operator's
 * real files — survives intact).
 *
 * Returns `metadata` as a nested object so `readMemoryKey` works unchanged.
 */
export function parseFrontmatterLoosely(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  const WANTED = new Set(['name', 'description', 'type', 'confidence']);

  let inMetadata = false;
  for (const line of raw.split('\n')) {
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    // Any new top-level key ends the metadata block.
    if (/^[A-Za-z_][\w-]*:/.test(line)) inMetadata = false;

    const m = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, rawValue] = m;
    if (!WANTED.has(key)) continue;

    // Strip a single layer of matching quotes; otherwise take the value as-is.
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    if (indent.length > 0 && inMetadata) metadata[key] = value;
    else if (indent.length === 0) out[key] = value;
  }

  if (Object.keys(metadata).length > 0) out.metadata = metadata;
  return out;
}

/**
 * THE frontmatter reader. Both ingest (which decides a row's title) and reconcile
 * (which decides whether a row is an orphan) MUST read frontmatter through this
 * one function — if they disagree, reconcile retires rows that are not orphans.
 *
 * Returns `undefined` when there is no frontmatter block at all.
 */
export function readMemoryFileFrontmatter(
  content: string,
): Record<string, unknown> | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  try {
    // pattern-scanner-allow: yaml-parse — reason: parses YAML FRONTMATTER from markdown memory files (NOT massu.config.yaml). Document metadata parsing, not application config; getConfig() does not apply.
    return (parseYaml(match[1]) as Record<string, unknown>) ?? undefined;
  } catch {
    // Strict YAML refused it — recover the scalars rather than drop the memory.
    return parseFrontmatterLoosely(match[1]);
  }
}

export function readMemoryKey(
  fm: Record<string, unknown>,
  key: 'type' | 'confidence',
): string | undefined {
  const metadata = fm.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>)[key];
    if (nested != null) return String(nested);
  }
  const top = fm[key];
  if (top != null) return String(top);
  return undefined;
}

/**
 * A-08 — BUMP THIS whenever the PARSE or MAPPING behaviour of ingest changes.
 *
 * The hash gate compares the file's CONTENT. But A-06 changed the PARSER, not the
 * content — the 55 mis-typed files' bytes never changed, so a content-hash gate
 * would have skipped every one of them and the re-backfill would have reported
 * success while leaving every Law mis-typed forever. A content hash is invalidated
 * by content changes; it is blind to the code that reads it.
 *
 * The gate is therefore: `content_hash unchanged AND ingest_schema_version === CURRENT`.
 *
 * Version log:
 *   1 — nested `metadata.type` + tolerant frontmatter recovery (A-06/A-06b),
 *       untruncated body, verbatim `raw` (A-02).
 */
export const INGEST_SCHEMA_VERSION = 1;

/**
 * A-18 — refuse, never silently truncate.
 *
 * A 5MB pasted log dropped into the memory dir would otherwise go whole into the
 * store AND into the embed sweep, blowing the hook's time budget. Refusing loudly is
 * honest; truncating quietly is how the 500-char clamp survived for so long.
 */
export const MAX_MEMORY_FILE_BYTES = 1_000_000;

/**
 * A-19 — leave a trace whenever memory state changes.
 *
 * Without this nobody could ever notice "Massu touched 12 of my memory files last
 * week", and once 4B can WRITE, an unobservable writer is an unauditable one. Fail-open:
 * observability must never be able to break ingest. (The event types are in the
 * `audit_log` CHECK — see the N-02 migration; before that, every one of these inserts
 * would have thrown and been swallowed, producing silence that looked like success.)
 */
function auditMemoryFileEvent(
  db: Database.Database,
  sessionId: string | undefined,
  eventType: 'memory_file_ingested' | 'memory_file_expired',
  detail: string,
): void {
  // `audit_log.session_id` is NOT NULL with an FK to `sessions`. Passing NULL throws —
  // and the catch below would swallow it, so the audit trail would be SILENTLY EMPTY
  // while looking like it worked. That is the same shape as the CHECK-constraint bug
  // this feature exists to fix, so it is asserted by a test rather than assumed.
  if (!sessionId) return;
  try {
    db.prepare(
      `INSERT INTO audit_log (session_id, event_type, actor, evidence)
       VALUES (?, ?, 'hook', ?)`,
    ).run(sessionId, eventType, detail);
  } catch {
    // Never let the audit trail break the thing it is auditing.
  }
}

type MirrorResult = 'inserted' | 'updated' | 'unchanged';

/** Write the file into `memory_files` WHOLE. Returns 'unchanged' when hash-gated. */
function upsertMemoryFileMirror(
  db: Database.Database,
  f: {
    relPath: string;
    name: string;
    raw: string;
    frontmatterJson: string | null;
    body: string;
    contentHash: string;
  },
): MirrorResult {
  const now = Math.floor(Date.now() / 1000);

  const existing = db
    .prepare(
      `SELECT id, content_hash, ingest_schema_version FROM memory_files WHERE rel_path = ?`,
    )
    .get(f.relPath) as
    | { id: number; content_hash: string; ingest_schema_version: number }
    | undefined;

  if (
    existing &&
    existing.content_hash === f.contentHash &&
    existing.ingest_schema_version === INGEST_SCHEMA_VERSION
  ) {
    return 'unchanged';
  }

  if (existing) {
    db.prepare(
      `UPDATE memory_files
          SET name = ?, raw = ?, frontmatter_json = ?, body = ?, content_hash = ?,
              ingest_schema_version = ?, synced_at_epoch = ?,
              expired_at_epoch = NULL
        WHERE id = ?`,
    ).run(
      f.name,
      f.raw,
      f.frontmatterJson,
      f.body,
      f.contentHash,
      INGEST_SCHEMA_VERSION,
      now,
      existing.id,
    );
    return 'updated';
  }

  db.prepare(
    `INSERT INTO memory_files
       (rel_path, name, raw, frontmatter_json, body, content_hash, ingest_schema_version, synced_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.relPath,
    f.name,
    f.raw,
    f.frontmatterJson,
    f.body,
    f.contentHash,
    INGEST_SCHEMA_VERSION,
    now,
  );
  return 'inserted';
}

export type IngestResult = 'inserted' | 'updated' | 'skipped';

/**
 * Parse a memory/*.md file's YAML frontmatter and ingest it into the
 * observations table. Deduplicates by title prefix `[memory-file] {name}`.
 *
 * @returns 'inserted' | 'updated' | 'skipped'
 */
export function ingestMemoryFile(
  db: Database.Database,
  sessionId: string,
  filePath: string,
): IngestResult {
  if (!existsSync(filePath)) return 'skipped';

  const content = readFileSync(filePath, 'utf-8');

  // A-18 — refuse, never silently truncate. (Truncating quietly is exactly how the
  // 500-char clamp survived unnoticed for so long.)
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_BYTES) {
    process.stderr.write(
      `[massu] memory file exceeds ${MAX_MEMORY_FILE_BYTES} bytes, not ingested: ${filePath}\n`,
    );
    return 'skipped';
  }

  const basename = stripMdExtension(filePath);

  // A-06b — STRICT YAML IS NOT A REASON TO DROP A MEMORY.
  //
  // Two of the operator's real memory files fail `parseYaml` outright
  // (BLOCK_AS_IMPLICIT_KEY — an unquoted `description:` whose value itself contains
  // ': '). The old code swallowed the error in an EMPTY catch and fell through to
  // the defaults, so those memories were stored with no name, no description and
  // the generic 'discovery' type — silently gutted, and invisible.
  //
  // A memory file is human prose, not a config file: it must degrade gracefully.
  // `readMemoryFileFrontmatter` is the ONE reader (reconcile uses it too — see the
  // dual-parser note there).
  const fm = readMemoryFileFrontmatter(content);

  let name = basename;
  let description = '';
  let type = 'discovery';
  let confidence: number | undefined;

  if (fm) {
    name = (fm.name as string) ?? basename;
    description = (fm.description as string) ?? '';
    type = readMemoryKey(fm, 'type') ?? 'discovery';
    const rawConfidence = readMemoryKey(fm, 'confidence');
    confidence = rawConfidence != null ? Number(rawConfidence) : undefined;
  }

  // Map memory types to observation types
  const obsType = mapMemoryTypeToObservationType(type);

  // Calculate importance from confidence (0.0-1.0 -> 1-5)
  const importance = confidence != null
    ? Math.max(1, Math.min(5, Math.round(confidence * 4 + 1)))
    : 4;

  // A-02 — THE 500-CHAR TRUNCATION IS GONE.
  //
  // Ingest kept `bodyMatch[1].trim().slice(0, 500)`. The operator's largest memory
  // is 14,968 bytes, so the store held ~3% of it — and `observations.detail` is what
  // `observations_fts` indexes, so 97% of every long memory was UNSEARCHABLE. Recall
  // could only ever find a memory by its first paragraph.
  //
  // Keeping the body in `detail` (rather than moving it to memory_files and leaving
  // detail empty) is deliberate: `detail` IS the FTS surface. Move the body out
  // without adding an FTS table over its new home and full-text coverage goes from
  // 500 chars to ZERO — recall gets WORSE, not better. Reusing the existing FTS
  // index is also the smaller mechanism (no N+1th search surface to keep in sync).
  //
  // The `.trim()` is gone too: it destroyed bytes BEFORE the clamp, so a body could
  // never round-trip byte-identically. `memory_files.raw` holds the verbatim file.
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  const body = bodyMatch ? bodyMatch[1] : '';

  const title = `${MEMORY_FILE_TITLE_PREFIX}${name}`;
  const detail = description ? `${description}\n\n${body}` : body;

  // A-02/A-08 — mirror the file WHOLE, hash-gated.
  const relPath = pathBasename(filePath);
  const contentHash = createHash('sha256').update(content, 'utf-8').digest('hex');
  const mirror = upsertMemoryFileMirror(db, {
    relPath,
    name,
    raw: content,
    frontmatterJson: fm ? JSON.stringify(fm) : null,
    body,
    contentHash,
  });

  // Deduplicate: check if this exact title exists
  const existing = db.prepare(
    'SELECT id, type FROM observations WHERE title = ? LIMIT 1'
  ).get(title) as { id: number; type: string } | undefined;

  // Hash-gated: an unchanged file, ingested by the CURRENT parser, needs no rewrite.
  // The schema version is what makes that safe (INGEST_SCHEMA_VERSION).
  //
  // But a gate that skips MUST first confirm there is anything to skip. Two ways the
  // gate would otherwise silently disable a repair it exists to perform:
  //
  //   1. RESURRECT-ON-CONTACT. The file a pre-fix release expired is EXACTLY the file
  //      whose bytes never change — it was expired precisely because nothing ever
  //      touched it. Skipping past the un-expire leaves it retired forever.
  //   2. PROJECTION DRIFT. `memory_files` is the mirror; `observations` is the
  //      projection built from it. If the projection is missing or stale (wrong type
  //      — the exact state all 55 mis-typed rows were in) while the mirror is current,
  //      a mirror-only gate refuses to rebuild it. The projection would stay wrong
  //      forever, and the backfill would report success. A gate must compare against
  //      the thing it is gating, not just its own bookkeeping.
  //
  // So: skip ONLY when the mirror is current AND the projection exists AND matches.
  const projectionCurrent = existing !== undefined && existing.type === obsType;
  if (mirror === 'unchanged' && projectionCurrent) {
    db.prepare(
      `UPDATE observations
          SET expired_at = NULL, expired_at_epoch = NULL,
              valid_to = NULL, valid_to_epoch = NULL
        WHERE title = ? AND expired_at IS NOT NULL`,
    ).run(title);
    return 'skipped';
  }

  if (existing) {
    // RESURRECT-ON-CONTACT: the file is on disk, so the memory is live — clear
    // any temporal retirement. File-backed rows are now exempt from value-decay
    // (MEMORY_FILE_TITLE_LIKE), so nothing should expire them going forward;
    // this heals rows that a prior version already retired, and keeps the
    // invariant "the file's existence decides reachability" true by repair as
    // well as by prevention.
    //
    // `type` MUST be in this UPDATE. It was not, so an existing row's type was
    // frozen at whatever the first ingest decided — meaning the A-06 parser fix
    // alone would have left all 55 mis-typed rows mis-typed forever, and the
    // re-backfill would have reported success while changing nothing that
    // mattered. The projection is only as correct as its slowest-updating column.
    db.prepare(
      `UPDATE observations
          SET type = ?, detail = ?, importance = ?,
              expired_at = NULL, expired_at_epoch = NULL,
              valid_to = NULL, valid_to_epoch = NULL
        WHERE id = ?`,
    ).run(obsType, detail, importance, existing.id);
    auditMemoryFileEvent(db, sessionId, 'memory_file_ingested', relPath);
    return 'updated';
  } else {
    addObservation(db, sessionId, obsType, title, detail, { importance });
    auditMemoryFileEvent(db, sessionId, 'memory_file_ingested', relPath);
    return 'inserted';
  }
}

/**
 * Bulk-ingest all memory/*.md files from a directory.
 * Skips MEMORY.md (the index file).
 *
 * @returns { inserted, updated, skipped, total }
 */
export function backfillMemoryFiles(
  db: Database.Database,
  memoryDir: string,
  sessionId?: string,
): { inserted: number; updated: number; skipped: number; total: number } {
  const stats = { inserted: 0, updated: 0, skipped: 0, total: 0 };

  if (!existsSync(memoryDir)) return stats;

  const files = readdirSync(memoryDir).filter(
    f => f.endsWith('.md') && f !== 'MEMORY.md'
  );
  stats.total = files.length;

  const sid = sessionId ?? `backfill-${Date.now()}`;

  for (const file of files) {
    const result = ingestMemoryFile(db, sid, join(memoryDir, file));
    stats[result]++;
  }

  return stats;
}

/**
 * P4-002 (plan-living-memory-slice-1): garbage-collect orphaned
 * `[memory-file] <name>` observations.
 *
 * `ingestMemoryFile` is UPSERT-by-title with no delete path, so deleting a
 * `memory/*.md` file leaves its observations row (title `[memory-file] <name>`)
 * behind forever — stale memory that keeps surfacing in recall/session-start.
 *
 * This reconciler lists the memory files that currently exist and deletes any
 * `[memory-file] *` observation whose backing file is gone. Present files are
 * never touched. Fail-open: any error returns 0 (never blocks session start).
 *
 * NOTE: the memory `name` written at ingest time is the frontmatter `name`
 * field when present, else the file basename. We therefore reconcile against
 * BOTH the set of live basenames AND the set of live frontmatter names so a
 * file that declares a custom `name` is not wrongly GC'd. Only observations
 * whose derived name matches NEITHER live set are deleted.
 *
 * @returns number of orphaned observation rows deleted
 */
export function reconcileMemoryFileObservations(
  db: Database.Database,
  memoryDir: string,
  sessionId?: string,
): number {
  try {
    // A-01 (D3) — THE DIRECTORY MUST BE PROVABLY THERE BEFORE ANYTHING RETIRES.
    //
    // The old code treated "no live files" as "every memory was deleted" and ran
    // an UNQUALIFIED sweep over every [memory-file] row. But an absent or
    // unreadable directory is not evidence of deletion — it is the normal state
    // of a fresh clone, an unsynced machine, a container, or a locked-down $HOME
    // (and the dir name is derived from cwd, so a path mismatch produced it too).
    // In that state the sweep retired the ENTIRE projected corpus.
    //
    // Absence of evidence is not evidence of absence: if we cannot read the
    // directory, we know NOTHING about which files are live, and the only honest
    // action is to do nothing.
    if (!existsSync(memoryDir)) return 0;

    let entries: string[];
    try {
      entries = readdirSync(memoryDir);
    } catch {
      // EACCES / ENOTDIR / EIO — unreadable is unknowable. No-op, never a wipe.
      return 0;
    }

    // Collect the set of live memory-file names (basename + frontmatter name).
    //
    // ONE PARSER. Reconcile decides which rows are ORPHANED, and ingest decides
    // what a row is TITLED. If they read frontmatter differently, reconcile
    // retires rows that are not orphans at all.
    //
    // That is not hypothetical — it fired on the real corpus. Ingest recovers the
    // frontmatter `name` of the two files whose YAML does not parse (A-06b), so
    // their rows are titled with that recovered name; reconcile called `parseYaml`
    // directly, swallowed the failure, and knew them only by basename. The names
    // did not match, the rows looked orphaned, and reconcile EXPIRED two of the
    // operator's memories. A dual-parser drift is exactly the bug class this slice
    // exists to end — so both paths now go through `readMemoryFileFrontmatter`.
    const liveNames = new Set<string>();
    const files = entries.filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      liveNames.add(stripMdExtension(file));
      try {
        const content = readFileSync(join(memoryDir, file), 'utf-8');
        const fm = readMemoryFileFrontmatter(content);
        if (fm && typeof fm.name === 'string' && fm.name) liveNames.add(fm.name);
      } catch {
        // Unreadable file: keep its basename in the live set (conservative — do not GC).
      }
    }

    // A-11 (P5-001) — EXPIRE, NEVER DELETE. These were the last two hard deletes
    // in the codebase; converting them empties the no-hard-delete allowlist.
    // Expiry is reversible (still `asOf`-queryable) and self-heals via
    // resurrect-on-contact if the file comes back.
    const now = Math.floor(Date.now() / 1000);
    const iso = new Date(now * 1000).toISOString();
    const liveTitles = [...liveNames].map((n) => `${MEMORY_FILE_TITLE_PREFIX}${n}`);

    // No live files, but the directory IS readable => the human really did remove
    // them. Expire (reversibly); never delete.
    if (liveTitles.length === 0) {
      const res = db
        .prepare(
          `UPDATE observations
              SET expired_at = ?, expired_at_epoch = ?, valid_to = ?, valid_to_epoch = ?
            WHERE title LIKE ? AND expired_at IS NULL`,
        )
        .run(iso, now, iso, now, MEMORY_FILE_TITLE_LIKE);
      return res.changes;
    }

    const placeholders = liveTitles.map(() => '?').join(',');
    const res = db
      .prepare(
        `UPDATE observations
            SET expired_at = ?, expired_at_epoch = ?, valid_to = ?, valid_to_epoch = ?
          WHERE title LIKE ? AND expired_at IS NULL AND title NOT IN (${placeholders})`,
      )
      .run(iso, now, iso, now, MEMORY_FILE_TITLE_LIKE, ...liveTitles);

    // A-19 — retirement is the one thing here that changes what reaches the model.
    // It must leave a trace, or "why did that memory stop surfacing?" is unanswerable.
    if (res.changes > 0) {
      auditMemoryFileEvent(db, sessionId, 'memory_file_expired', String(res.changes));
    }

    return res.changes;
  } catch {
    // Fail-open: never block the caller (session start) on reconcile failure.
    return 0;
  }
}

function mapMemoryTypeToObservationType(memoryType: string): string {
  switch (memoryType) {
    case 'user':
    case 'feedback':
      return 'decision';
    case 'project':
      return 'feature';
    case 'reference':
      return 'discovery';
    default:
      return 'discovery';
  }
}

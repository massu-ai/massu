// A-02 (lossless mirror + no truncation) · A-08 (schema-version gate) · A-18 (size cap).
//
// The headline: the 500-char truncation is GONE. `observations.detail` is what
// `observations_fts` indexes, so with a 14,968-byte memory the store held ~3% of it
// and 97% was UNSEARCHABLE — recall could only ever find a memory by its first
// paragraph. And `.trim()` destroyed bytes BEFORE the clamp, so nothing could ever
// round-trip byte-identically.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';

import { initMemorySchema, createSession, MEMORY_FILE_TITLE_PREFIX } from '../memory-db.ts';
import {
  ingestMemoryFile,
  INGEST_SCHEMA_VERSION,
  MAX_MEMORY_FILE_BYTES,
} from '../memory-file-ingest.ts';

describe('memory_files mirror (A-02, A-08, A-18)', () => {
  let db: Database.Database;
  let root: string;
  let memDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-mirror-'));
    memDir = join(root, 'memory');
    mkdirSync(memDir);
    db = new Database(join(root, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(memDir, `${name}.md`);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  function mirror(relPath: string) {
    return db.prepare('SELECT * FROM memory_files WHERE rel_path = ?').get(relPath) as
      | Record<string, any>
      | undefined;
  }

  it('A-02: a 15KB memory is stored WHOLE and round-trips byte-identically', () => {
    const tail = 'THE-NEEDLE-AT-THE-VERY-END';
    const content =
      `---\nname: big\ndescription: d\nmetadata:\n  type: feedback\n---\n\n` +
      `  leading space .trim() would have eaten\n` +
      `A [[wiki-link]] survives.\n` +
      'filler '.repeat(2200) +
      `\n${tail}\n`;
    expect(content.length).toBeGreaterThan(14_000);

    const p = write('big', content);
    expect(ingestMemoryFile(db, 'S1', p)).toBe('inserted');

    const m = mirror('big.md')!;
    expect(m.raw, 'raw must be the verbatim file').toBe(content);
    expect(m.raw).toBe(readFileSync(p, 'utf-8'));
    expect(m.body.length, 'the body is NOT clamped to 500').toBeGreaterThan(14_000);
    expect(m.body).toContain('[[wiki-link]]');
    expect(m.body).toContain('  leading space'); // .trim() is gone
  });

  it('A-02: text at the END of a long memory is now SEARCHABLE (it never was)', () => {
    const tail = 'zzqqxneedle'; // one bare token: FTS5 reads a hyphen as an operator
    write('big', `---\nname: big\n---\n\n${'filler '.repeat(2000)}\n${tail}\n`);
    ingestMemoryFile(db, 'S1', join(memDir, 'big.md'));

    // detail is the FTS surface. Before A-02 it held the first 500 chars, so this
    // needle — 14,000 chars in — was invisible to every search.
    const row = db
      .prepare(`SELECT detail FROM observations WHERE title = ?`)
      .get(`${MEMORY_FILE_TITLE_PREFIX}big`) as { detail: string };
    expect(row.detail).toContain(tail);

    const hit = db
      .prepare(`SELECT COUNT(*) n FROM observations_fts WHERE observations_fts MATCH ?`)
      .get(tail) as { n: number };
    expect(hit.n, 'full-text search must find text at the end of a long memory').toBe(1);
  });

  it('A-08: an unchanged file is a no-op (hash-gated)', () => {
    const p = write('a', `---\nname: a\n---\n\nbody\n`);
    expect(ingestMemoryFile(db, 'S1', p)).toBe('inserted');
    expect(ingestMemoryFile(db, 'S1', p), 'unchanged file => no rewrite').toBe('skipped');
    expect(mirror('a.md')!.ingest_schema_version).toBe(INGEST_SCHEMA_VERSION);
  });

  it('A-08: a PARSER change re-ingests an unchanged file (a content hash is blind to code)', () => {
    // This is the whole reason the schema version exists. A-06 changed the PARSER,
    // not the content: the 55 mis-typed files' bytes never changed. A content-hash
    // gate alone would have skipped every one of them, and the re-backfill would have
    // reported success while leaving every Law mis-typed forever.
    const p = write('a', `---\nname: a\n---\n\nbody\n`);
    ingestMemoryFile(db, 'S1', p);
    expect(ingestMemoryFile(db, 'S1', p)).toBe('skipped');

    // Simulate a version bump (a parser change shipped).
    db.prepare(`UPDATE memory_files SET ingest_schema_version = 0 WHERE rel_path = 'a.md'`).run();

    expect(
      ingestMemoryFile(db, 'S1', p),
      'a stale schema version must force a re-ingest even though the bytes are identical',
    ).toBe('updated');
    expect(mirror('a.md')!.ingest_schema_version).toBe(INGEST_SCHEMA_VERSION);
  });

  it('the hash gate does NOT disable resurrect-on-contact', () => {
    // The file a pre-fix release expired is EXACTLY the file whose bytes never change
    // — it was expired precisely because nothing ever touched it. If the hash gate
    // short-circuits past the un-expire, that memory stays retired forever and the
    // self-healing is silently dead.
    const p = write('a', `---\nname: a\n---\n\nbody\n`);
    ingestMemoryFile(db, 'S1', p);

    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `UPDATE observations SET expired_at = ?, expired_at_epoch = ? WHERE title = ?`,
    ).run(new Date(now * 1000).toISOString(), now, `${MEMORY_FILE_TITLE_PREFIX}a`);

    // Same bytes, same schema version => the gate says 'skipped'...
    expect(ingestMemoryFile(db, 'S1', p)).toBe('skipped');

    // ...but the memory must be LIVE again.
    const row = db
      .prepare(`SELECT expired_at FROM observations WHERE title = ?`)
      .get(`${MEMORY_FILE_TITLE_PREFIX}a`) as { expired_at: string | null };
    expect(row.expired_at, 'the file is on disk, so the memory is live').toBeNull();
  });

  it('A-18: an oversized file is REFUSED, never silently truncated', () => {
    const p = write('huge', `---\nname: huge\n---\n\n${'x'.repeat(MAX_MEMORY_FILE_BYTES + 10)}`);
    expect(ingestMemoryFile(db, 'S1', p)).toBe('skipped');
    expect(mirror('huge.md'), 'refused, not stored half-way').toBeUndefined();
  });

  it('the two files whose YAML does not parse are still mirrored WHOLE', () => {
    // BLOCK_AS_IMPLICIT_KEY — an unquoted `description:` whose value contains ': '.
    const content =
      `---\nname: TOOL_DB_NEEDS is the SoT\ndescription: Every MCP tool MUST update tool-db-needs.ts: the manifest\nmetadata:\n  type: feedback\n---\n\nBody.\n`;
    const p = write('broken', content);
    expect(ingestMemoryFile(db, 'S1', p)).toBe('inserted');
    const m = mirror('broken.md')!;
    expect(m.raw).toBe(content);
    expect(m.name).toBe('TOOL_DB_NEEDS is the SoT');
  });
});

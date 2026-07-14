// A-17 + A-21 — THE TEST THAT WOULD HAVE CAUGHT A CATASTROPHE.
//
// A full ingest -> reconcile -> backfill cycle must not change ONE BYTE of any memory
// file on disk. 4A is read-only with respect to the corpus by design; this asserts it
// mechanically, so the day a writer is added (4B) the guard is already in place.
//
// WHY A SYNTHETIC CORPUS AND NOT THE REAL ONE:
// The plan originally said "copy the operator's actual 70 files" into the test. That
// would have been a data leak, not a safety test: `packages/core/` SYNCS TO THE PUBLIC
// REPO (`scripts/PUBLIC_MANIFEST.md:9` excludes only node_modules/.claude/dist —
// `__tests__/` is NOT excluded), and the corpus contains prod refs, internal incidents
// and operator home paths. It would also be unrunnable on any other machine, so "the
// test that would have caught a catastrophe" would be the one test that never runs
// anywhere but one laptop — a breach of the universal-product law.
//
// So: the committed fixture is SYNTHETIC but structurally ISOMORPHIC to the real
// corpus — same shapes, same edge cases, no real content. The real corpus is checked
// by an OPT-IN, env-gated case that never ships bytes anywhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'fs';
import { createHash } from 'crypto';

import { initMemorySchema, createSession, MEMORY_FILE_TITLE_PREFIX } from '../memory-db.ts';
import {
  backfillMemoryFiles,
  reconcileMemoryFileObservations,
  ingestMemoryFile,
} from '../memory-file-ingest.ts';

/**
 * A-17 — structurally isomorphic to the real corpus, with NO real content.
 * Every entry here is a shape that actually exists in the operator's memory dir, or an
 * adversarial edge the renderer will one day have to survive.
 */
function writeSyntheticCorpus(dir: string): void {
  const f = (name: string, content: string) => writeFileSync(join(dir, name), content, 'utf-8');

  // The dominant shape: type NESTED under metadata (55 of 69 real files).
  for (let i = 0; i < 55; i++) {
    f(
      `feedback_nested_${i}.md`,
      `---\nname: nested-${i}\ndescription: d${i}\nmetadata:\n  type: feedback\n---\n\n` +
        `Body ${i} with a [[wiki-link]] that no code parses.\n`,
    );
  }
  // The minority shape: TOP-LEVEL type (14 of 69).
  for (let i = 0; i < 14; i++) {
    f(`project_top_${i}.md`, `---\nname: top-${i}\ntype: project\n---\n\nBody ${i}.\n`);
  }

  // --- the adversarial members ---
  // A 19KB body (the real corpus's largest is ~15KB).
  f('feedback_huge.md', `---\nname: huge\nmetadata:\n  type: feedback\n---\n\n${'x'.repeat(19_000)}\n`);
  // A frontmatter `name` containing a SLASH (3 real memories do this).
  f('feedback_slashname.md', `---\nname: org-a/repo-b IS PUBLIC — never commit\nmetadata:\n  type: feedback\n---\n\nBody.\n`);
  // YAML that does NOT parse (2 real files: an unquoted description containing ': ').
  f('feedback_badyaml.md', `---\nname: bad yaml\ndescription: Every tool MUST update x.ts: the manifest\nmetadata:\n  type: feedback\n---\n\nBody.\n`);
  // No frontmatter at all.
  f('feedback_nofm.md', `Just prose, no frontmatter.\n`);
  // Empty body.
  f('feedback_emptybody.md', `---\nname: empty\nmetadata:\n  type: feedback\n---\n`);
  // CRLF line endings.
  f('feedback_crlf.md', `---\r\nname: crlf\r\nmetadata:\r\n  type: feedback\r\n---\r\n\r\nBody.\r\n`);
  // Two files declaring the SAME frontmatter name (name is NOT unique).
  f('feedback_dup_a.md', `---\nname: duplicate-name\nmetadata:\n  type: feedback\n---\n\nA.\n`);
  f('feedback_dup_b.md', `---\nname: duplicate-name\nmetadata:\n  type: feedback\n---\n\nB.\n`);
  // A name that is prose with spaces and punctuation.
  f('feedback_prosename.md', `---\nname: CR-48 — deploy is mandatory (1.6.3+)\nmetadata:\n  type: feedback\n---\n\nBody.\n`);
  // The index. Never ingested (both entry points exclude it by basename).
  f('MEMORY.md', `# Memory Index\n\n- [nested-0](feedback_nested_0.md) — hook\n`);
}

/** sha256 of every file in a directory, keyed by name. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    out.set(name, createHash('sha256').update(readFileSync(p)).digest('hex'));
  }
  return out;
}

/** The full cycle a session performs against the memory dir. */
function fullCycle(db: Database.Database, memDir: string): void {
  backfillMemoryFiles(db, memDir, 'S1');
  reconcileMemoryFileObservations(db, memDir);
  for (const name of readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')) {
    ingestMemoryFile(db, 'S1', join(memDir, name));
  }
  reconcileMemoryFileObservations(db, memDir);
}

describe('memory corpus safety (A-17, A-21)', () => {
  let db: Database.Database;
  let root: string;
  let memDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-corpus-'));
    memDir = join(root, 'memory');
    mkdirSync(memDir);
    db = new Database(join(root, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
    writeSyntheticCorpus(memDir);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('a FULL cycle changes ZERO bytes on disk', () => {
    const before = fingerprint(memDir);
    expect(before.size).toBeGreaterThan(70);

    fullCycle(db, memDir);

    const after = fingerprint(memDir);
    expect(after.size, 'no file created, no file deleted').toBe(before.size);
    for (const [name, hash] of before) {
      expect(after.get(name), `${name} MUST be byte-identical after a full cycle`).toBe(hash);
    }
  });

  it('TEN cycles change zero bytes and reach a FIXED POINT in the store', () => {
    const before = fingerprint(memDir);
    fullCycle(db, memDir);
    const rowsAfterFirst = (
      db.prepare(`SELECT COUNT(*) n FROM memory_files`).get() as { n: number }
    ).n;
    const obsAfterFirst = (
      db.prepare(`SELECT COUNT(*) n FROM observations WHERE title LIKE ?`).get(
        `${MEMORY_FILE_TITLE_PREFIX}%`,
      ) as { n: number }
    ).n;

    for (let i = 0; i < 9; i++) fullCycle(db, memDir);

    // Files: untouched.
    const after = fingerprint(memDir);
    for (const [name, hash] of before) expect(after.get(name)).toBe(hash);

    // Store: converged. A cycle that keeps inserting rows never terminates.
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM memory_files`).get() as { n: number }).n,
      'the mirror must reach a fixed point',
    ).toBe(rowsAfterFirst);
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM observations WHERE title LIKE ?`).get(
        `${MEMORY_FILE_TITLE_PREFIX}%`,
      ) as { n: number }).n,
      'the projection must reach a fixed point',
    ).toBe(obsAfterFirst);
  });

  it('every memory is mirrored byte-identically, including the adversarial ones', () => {
    fullCycle(db, memDir);
    for (const name of readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')) {
      const onDisk = readFileSync(join(memDir, name), 'utf-8');
      const row = db.prepare(`SELECT raw FROM memory_files WHERE rel_path = ?`).get(name) as
        | { raw: string }
        | undefined;
      expect(row, `${name} must be mirrored`).toBeTruthy();
      expect(row!.raw, `${name} must round-trip byte-identically`).toBe(onDisk);
    }
  });

  it('MEMORY.md is never ingested as a memory', () => {
    fullCycle(db, memDir);
    const row = db.prepare(`SELECT COUNT(*) n FROM memory_files WHERE rel_path = 'MEMORY.md'`).get() as {
      n: number;
    };
    expect(row.n, 'the index is not a memory').toBe(0);
  });

  // ---------------------------------------------------------------------------
  // A-21 — the REAL corpus. Opt-in, operator-local, never ships bytes anywhere.
  //   MASSU_REAL_CORPUS_DIR=~/.claude/projects/<enc>/memory npx vitest run memory-corpus-safety
  // Skipped by default, so it is inert in public CI and on every other machine.
  // ---------------------------------------------------------------------------
  const realDir = process.env.MASSU_REAL_CORPUS_DIR;
  const realCorpusAvailable = !!realDir && existsSync(realDir);

  it.skipIf(!realCorpusAvailable)(
    'THE REAL CORPUS survives a full cycle byte-identical (opt-in)',
    () => {
      const before = fingerprint(realDir!);
      expect(before.size, 'the real corpus must be non-trivial').toBeGreaterThan(10);

      const scratch = new Database(join(root, 'real.db'));
      try {
        initMemorySchema(scratch);
        createSession(scratch, 'S1');
        fullCycle(scratch, realDir!);
      } finally {
        scratch.close();
      }

      const after = fingerprint(realDir!);
      expect(after.size, 'no real memory file created or deleted').toBe(before.size);
      for (const [name, hash] of before) {
        expect(after.get(name), `REAL FILE ${name} MUST BE UNTOUCHED`).toBe(hash);
      }
    },
  );
});

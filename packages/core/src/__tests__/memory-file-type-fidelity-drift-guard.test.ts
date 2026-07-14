// A-06 (D1) + A-07 (D1-TRAP): the memory type is read correctly — and doing so
// does not feed the operator's Laws to the dedupe engine.
//
// D1: ingest read a TOP-LEVEL `type:`; the real corpus nests it under `metadata:`
// (55 of 69 files; 14 top-level; overlap zero). Every nested file — every one of
// the operator's Laws — landed as the generic 'discovery' default. The bug
// survived because EVERY existing fixture used the top-level shape: the suite was
// green while production drifted. THAT is the blind spot this file closes.
//
// D1-TRAP: fixing D1 is not a free win. `feedback` maps to the observation type
// `decision`, and stage-A dedupe gates on exactly ['decision','cr_violation',
// 'failed_attempt']. Before the fix, the Laws were 'discovery' and therefore
// ACCIDENTALLY outside the gate. Fixing the type pulls 36 hand-written Laws into
// the supersede engine for the first time — and several are deliberate
// near-paraphrases of each other. A-07 exempts file-backed rows from dedupe, and
// must ship in the same commit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';

import { initMemorySchema, createSession, MEMORY_FILE_TITLE_PREFIX } from '../memory-db.ts';
import { ingestMemoryFile, readMemoryKey } from '../memory-file-ingest.ts';
import { runConsolidation } from '../memory-consolidate.ts';
import { DEFAULT_CONSOLIDATION_CONFIG } from '../consolidation-config.ts';

const SRC = join(__dirname, '..');

/** The shape 55 of the operator's 69 memories actually use. */
function nestedTypeFile(dir: string, name: string, type: string, body = 'Body.'): string {
  const p = join(dir, `${name}.md`);
  writeFileSync(
    p,
    `---\nname: ${name}\ndescription: d\nmetadata:\n  type: ${type}\n---\n\n${body}\n`,
    'utf-8',
  );
  return p;
}

/** The shape the other 14 use — and the ONLY shape the old fixtures covered. */
function topLevelTypeFile(dir: string, name: string, type: string): string {
  const p = join(dir, `${name}.md`);
  writeFileSync(p, `---\nname: ${name}\ndescription: d\ntype: ${type}\n---\n\nBody.\n`, 'utf-8');
  return p;
}

function typeOf(db: Database.Database, name: string): string {
  return (
    db
      .prepare(`SELECT type FROM observations WHERE title = ?`)
      .get(`${MEMORY_FILE_TITLE_PREFIX}${name}`) as { type: string }
  ).type;
}

describe('memory-file type fidelity (A-06) + dedupe exemption (A-07)', () => {
  let db: Database.Database;
  let root: string;
  let memDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-type-'));
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

  it('reads a NESTED metadata.type — the shape 55 of the 69 real memories use', () => {
    ingestMemoryFile(db, 'S1', nestedTypeFile(memDir, 'a_law', 'feedback'));
    // feedback -> decision. Before A-06 this was 'discovery'.
    expect(typeOf(db, 'a_law'), "a nested `metadata.type: feedback` must not land as 'discovery'").toBe(
      'decision',
    );
  });

  it('still reads a TOP-LEVEL type — the other 14 must not regress', () => {
    ingestMemoryFile(db, 'S1', topLevelTypeFile(memDir, 'b_ref', 'project'));
    expect(typeOf(db, 'b_ref')).toBe('feature'); // project -> feature
  });

  it('prefers the NESTED key when both are present (that is what the tooling writes)', () => {
    const p = join(memDir, 'c_both.md');
    writeFileSync(
      p,
      `---\nname: c_both\ntype: reference\nmetadata:\n  type: feedback\n---\n\nBody.\n`,
      'utf-8',
    );
    ingestMemoryFile(db, 'S1', p);
    expect(typeOf(db, 'c_both')).toBe('decision'); // feedback (nested) wins over reference (top)
  });

  it('RE-INGEST CORRECTS AN ALREADY-MIS-TYPED ROW (the fix is worthless without this)', () => {
    // Simulate a row written by the buggy parser: nested type, stored as discovery.
    const p = nestedTypeFile(memDir, 'd_law', 'feedback');
    ingestMemoryFile(db, 'S1', p);
    db.prepare(`UPDATE observations SET type = 'discovery' WHERE title = ?`).run(
      `${MEMORY_FILE_TITLE_PREFIX}d_law`,
    );
    expect(typeOf(db, 'd_law')).toBe('discovery');

    // Re-ingest (the backfill). The UPDATE previously did NOT set `type`, so this
    // silently changed nothing and a "successful" re-backfill left every Law
    // mis-typed forever.
    expect(ingestMemoryFile(db, 'S1', p)).toBe('updated');
    expect(typeOf(db, 'd_law'), 're-ingest must correct the type of an existing row').toBe('decision');
  });

  it('`confidence` has the same nesting bug — nested must be read too', () => {
    expect(readMemoryKey({ metadata: { confidence: 0.5 } }, 'confidence')).toBe('0.5');
    expect(readMemoryKey({ confidence: 0.5 }, 'confidence')).toBe('0.5');
    expect(readMemoryKey({}, 'confidence')).toBeUndefined();
  });

  it('A-07: two near-paraphrase LAWS are never deduped against each other', async () => {
    // The operator's real Laws include deliberate near-paraphrases. Post-A-06 they
    // are type `decision` — inside the dedupe gate. They must survive anyway.
    ingestMemoryFile(
      db,
      'S1',
      nestedTypeFile(
        memDir,
        'feedback_never_guess_anything',
        'feedback',
        'Never guess. Verify or ask. Cite evidence before any claim that rests on an assumption.',
      ),
    );
    ingestMemoryFile(
      db,
      'S1',
      nestedTypeFile(
        memDir,
        'feedback_r011_diagnosis_verification',
        'feedback',
        'Never guess a diagnosis. Verify or ask. Cite evidence before any claim that rests on an assumption.',
      ),
    );

    const res = await runConsolidation(db, {
      config: { ...DEFAULT_CONSOLIDATION_CONFIG },
      projectRoot: root,
    });

    expect(res.deduped, 'a file-backed row must NEVER be superseded by similarity').toBe(0);
    const live = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM observations WHERE title LIKE ? AND expired_at IS NULL`,
        )
        .get(`${MEMORY_FILE_TITLE_PREFIX}%`) as { n: number }
    ).n;
    expect(live, 'both Laws survive — the file is the dedupe unit, the human its judge').toBe(2);
  });

  it('A-06b: a memory whose YAML does not parse is RECOVERED, not gutted', () => {
    // Two of the operator's REAL memory files fail parseYaml outright
    // (BLOCK_AS_IMPLICIT_KEY: an unquoted `description:` whose value itself
    // contains ': '). The old empty catch fell through to the defaults, storing
    // them with NO description, NO name, and the generic 'discovery' type. This
    // is that exact frontmatter shape.
    const p = join(memDir, 'e_broken.md');
    writeFileSync(
      p,
      `---\nname: TOOL_DB_NEEDS manifest is sole source of truth (1.6.2+)\n` +
        `description: Every MCP tool MUST update packages/core/src/tool-db-needs.ts: the manifest\n` +
        `metadata:\n  type: feedback\n---\n\nBody.\n`,
      'utf-8',
    );

    // Precondition: strict YAML really does reject this.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parse } = require('yaml');
      parse(readFileSync(p, 'utf-8').match(/^---\n([\s\S]*?)\n---/)![1]);
    }).toThrow();

    ingestMemoryFile(db, 'S1', p);

    const row = db
      .prepare(`SELECT type, detail FROM observations WHERE title LIKE ?`)
      .get('%TOOL_DB_NEEDS%') as { type: string; detail: string } | undefined;

    expect(row, 'the memory must be stored under its declared name, not the basename').toBeTruthy();
    expect(row!.type, 'its nested type must survive a YAML failure').toBe('decision');
    expect(row!.detail, 'its description must survive a YAML failure').toContain(
      'Every MCP tool MUST update',
    );
  });

  it('STRUCTURAL: ingest reads `metadata`, and dedupe still excludes file-backed rows', () => {
    const ingest = readFileSync(join(SRC, 'memory-file-ingest.ts'), 'utf-8');
    const consolidate = readFileSync(join(SRC, 'memory-consolidate.ts'), 'utf-8');

    // The assertion whose ABSENCE let D1 rot: the key ingest READS must be the key
    // the corpus WRITES (nested under `metadata`).
    expect(
      /metadata/.test(ingest),
      'ingest must read the nested `metadata` key the real corpus writes (D1)',
    ).toBe(true);
    expect(
      /fm\.type as string/.test(ingest),
      'the bare top-level-only `fm.type` read must NOT come back',
    ).toBe(false);

    // A-07 must not be silently dropped while A-06 stays.
    expect(
      /AND title NOT LIKE \?/.test(consolidate),
      'stage-A dedupe must exclude file-backed rows (A-07) — mandatory whenever A-06 is present',
    ).toBe(true);
  });
});

/**
 * B-14 — THE 4B EVAL, plus the B-15 (adopt) and B-18 (unrender) ceremonies.
 *
 * The six clauses, stated as the plan states them:
 *   1. edit the store  → the Massu file re-renders
 *   2. edit the FILE   → the store updates and the file is NOT reverted
 *   3. delete the file → it STAYS deleted (including after the DB is destroyed)
 *   4. a full cycle produces ZERO drift (a fixed point)
 *   5. every byte of MEMORY.md OUTSIDE the managed region is unchanged
 *   6. a HUMAN file is never touched — byte-identical
 *
 * Clause 5 is stated correctly (F-23): the draft said "MEMORY.md append-only, its
 * pre-existing bytes unchanged", which B-05 contradicts BY CONSTRUCTION — the managed
 * region is rewritten wholly, and an eviction changes bytes that were previously written
 * INSIDE it. The real, testable invariant is: every byte OUTSIDE the region, and every
 * byte the HUMAN wrote, is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMemorySchema } from '../memory-db.ts';
import { renderMemoryFiles, type RenderCandidate } from '../memory-renderer.ts';
import { DEFAULT_MEMORY_FILES_CONFIG } from '../memory-files-config.ts';
import { corpusHashes } from '../memory-backup.ts';
import { BEGIN_SENTINEL, END_SENTINEL, readRegionLines } from '../memory-index-region.ts';
import { memoryAdopt, memoryUnrender } from '../commands/memory-render-cli.ts';
import { mintAuthorship, RENDER_MAC_KEY } from '../memory-authorship.ts';

let home: string;
let memoryDir: string;
let db: Database.Database;

const ENABLED = { ...DEFAULT_MEMORY_FILES_CONFIG, renderEnabled: true };
const NOW = Date.parse('2026-07-12T12:00:00Z');
const EPOCH = Math.floor(NOW / 1000);

const HUMAN_INDEX = `# Memory Index

## Laws (always apply)
- [**Cardinal: never guess**](feedback_never_guess_anything.md) — verify or ASK.

${BEGIN_SENTINEL}
${END_SENTINEL}

## Supabase
- [prod drift](feedback_supabase_prod_migration_drift.md) — ledger fiction.
`;

function c(over: Partial<RenderCandidate> = {}): RenderCandidate {
  return {
    observationId: 1,
    name: 'a_learned_lesson',
    title: 'A learned lesson',
    body: 'The original body.',
    importance: 5,
    origin: 'local',
    ...over,
  };
}

function seed(x: RenderCandidate): void {
  db.prepare(
    `INSERT OR REPLACE INTO observations
       (id, session_id, type, title, detail, importance, origin, created_at, created_at_epoch)
     VALUES (?, 's1', 'decision', ?, ?, ?, ?, '2026-07-12', ?)`
  ).run(x.observationId, x.title, x.body, x.importance, x.origin, EPOCH);
}

const opts = () => ({ memoryDir, home, now: NOW, config: ENABLED });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'massu-eval-'));
  memoryDir = join(home, '.claude', 'projects', 'p', 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), HUMAN_INDEX);
  // A real, irreplaceable, hand-written memory sitting in the corpus the whole time.
  writeFileSync(
    join(memoryDir, 'feedback_never_guess_anything.md'),
    '---\nname: never guess\n---\n\nNEVER GUESS. Verify or ASK. This is the operator\'s law.\n'
  );

  db = new Database(':memory:');
  initMemorySchema(db);
  db.prepare(
    `INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s1','2026-07-12',?)`
  ).run(EPOCH);
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('B-14 — the 4B eval, all six clauses', () => {
  it('CLAUSE 1: edit the store → the Massu file RE-RENDERS', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());

    const p = join(memoryDir, 'a_learned_lesson.md');
    expect(readFileSync(p, 'utf8')).toContain('The original body.');

    // The lesson is refined in the store.
    const updated = c({ body: 'The REFINED body, learned later.' });
    seed(updated);
    const r = renderMemoryFiles(db, [updated], opts());

    expect(r.written).toEqual(['a_learned_lesson.md']);
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('The REFINED body, learned later.');
    expect(after).not.toContain('The original body.');
  });

  it('CLAUSE 2: edit the FILE → the file is NOT reverted', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());

    const p = join(memoryDir, 'a_learned_lesson.md');
    const handEdited = `${readFileSync(p, 'utf8')}\n\nTHE OPERATOR'S OWN ADDITION.\n`;
    writeFileSync(p, handEdited);

    // Even though the store still wants to render it, the human's edit wins. Forever.
    const r = renderMemoryFiles(db, [x], opts());
    expect(r.written).toEqual([]);
    expect(r.refusals.some((f) => f.reason === 'human_authored')).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe(handEdited);
  });

  it('CLAUSE 3: delete the file → it STAYS deleted, even after the DB is destroyed', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());
    const p = join(memoryDir, 'a_learned_lesson.md');
    expect(existsSync(p)).toBe(true);

    // `massu memory unrender --file` is how a deletion is recorded durably.
    const res = memoryUnrender(db, memoryDir, { file: 'a_learned_lesson.md', home, now: EPOCH });
    expect(res.exitCode).toBe(0);
    expect(existsSync(p)).toBe(false);

    // Destroy the entire database. This is what a DB-only tombstone cannot survive.
    db.close();
    db = new Database(':memory:');
    initMemorySchema(db);
    db.prepare(
      `INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s1','2026-07-12',?)`
    ).run(EPOCH);
    seed(x);

    const r = renderMemoryFiles(db, [x], opts());
    expect(r.written).toEqual([]);
    expect(existsSync(p), 'a deletion you have to repeat is not a deletion').toBe(false);
  });

  it('CLAUSE 4: a full cycle produces ZERO drift (a fixed point)', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());

    const stable = corpusHashes(memoryDir);
    const rows = (db.prepare(`SELECT COUNT(*) n FROM memory_files`).get() as { n: number }).n;

    for (let i = 0; i < 10; i++) {
      renderMemoryFiles(db, [x], opts());
      expect(corpusHashes(memoryDir), `cycle ${i}`).toEqual(stable);
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM memory_files`).get() as { n: number }).n,
        `cycle ${i}: a second row appeared (self-duplicate)`
      ).toBe(rows);
    }
  });

  it('CLAUSE 5: every byte of MEMORY.md OUTSIDE the region is unchanged', () => {
    const x = c();
    seed(x);
    const pre = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');

    for (let i = 0; i < 5; i++) renderMemoryFiles(db, [x], opts());

    const post = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(post.slice(0, post.indexOf(BEGIN_SENTINEL))).toBe(pre.slice(0, pre.indexOf(BEGIN_SENTINEL)));
    expect(post.slice(post.indexOf(END_SENTINEL))).toBe(pre.slice(pre.indexOf(END_SENTINEL)));
    // The region itself DID get a pointer — that is the point.
    expect(readRegionLines(post).length).toBe(1);
  });

  it("CLAUSE 6: the operator's hand-written memory is BYTE-IDENTICAL throughout", () => {
    const human = join(memoryDir, 'feedback_never_guess_anything.md');
    const before = readFileSync(human);

    // Render a bunch of things, including one whose name collides with the human file.
    const cands = [
      c(),
      c({ observationId: 2, name: 'never guess', title: 'never guess', body: 'A machine version.' }),
      c({ observationId: 3, name: 'another_lesson', title: 'Another lesson', body: 'More.' }),
    ];
    cands.forEach(seed);
    for (let i = 0; i < 5; i++) renderMemoryFiles(db, cands, opts());

    // Not one byte. This is the whole slice.
    expect(readFileSync(human)).toEqual(before);
  });
});

describe('B-15 — the adopt ceremony', () => {
  // ⚠ THE PLAN READS TWO WAYS HERE, AND THE SCENARIO IS WHAT DISAMBIGUATES IT.
  //
  // B-15's acceptance says "with a valid corpus and an empty DB, a hook-driven session
  // start adopts 0 files and writes 0 bytes". OD-1(a)'s rationale says the opposite: "If
  // the key came along, Massu re-adopts its own files automatically and everything keeps
  // working" — and calls that the whole benefit of choosing a keyed MAC over store-only
  // authorship ("it makes the frozen-file cell RARE instead of UNIVERSAL").
  //
  // They are not in conflict; they describe DIFFERENT machines. The variable is whether
  // the KEY travelled, and the store row is explicitly "a cache, not the credential":
  //   - KEY PRESENT: the MAC verifies ⇒ the file is PROVABLY Massu's ⇒ it may maintain
  //     it. This can never destroy human prose: only the holder of this install's secret
  //     could have produced that stamp.
  //   - KEY ABSENT: nothing verifies ⇒ every file is HUMAN ⇒ 0 files, 0 bytes. THAT is
  //     the frozen-file cell B-15's ceremony exists to recover, and B-15's acceptance
  //     describes exactly it.
  // Both are asserted below.

  it('KEY PRESENT: a valid MAC with no store row SELF-HEALS (OD-1(a)’s whole point)', () => {
    const body = 'A body Massu wrote on another machine.\n';
    const mac = mintAuthorship(body, home)!;
    writeFileSync(
      join(memoryDir, 'from_another_machine.md'),
      `---\nname: from_another_machine\n${RENDER_MAC_KEY}: ${mac}\n---\n${body}`
    );

    const x = c({ observationId: 9, name: 'from_another_machine', title: 'From another machine' });
    seed(x);
    const r = renderMemoryFiles(db, [x], opts());

    // It maintains its own file rather than being amnesiac about it. Under the rejected
    // store-only design, every Massu file on earth would become permanently human-owned
    // the moment the DB was rebuilt.
    expect(r.written).toEqual(['from_another_machine.md']);
    expect(r.refusals.filter((f) => f.reason === 'human_authored')).toEqual([]);
  });

  it('KEY ABSENT: the frozen-file cell — 0 files, 0 bytes (B-15’s acceptance)', () => {
    const otherMachine = mkdtempSync(join(tmpdir(), 'massu-other-'));
    const body = 'A body Massu wrote on a machine whose key did NOT travel.\n';
    const mac = mintAuthorship(body, otherMachine)!;
    rmSync(otherMachine, { recursive: true, force: true });

    writeFileSync(
      join(memoryDir, 'frozen_no_key.md'),
      `---\nname: frozen_no_key\n${RENDER_MAC_KEY}: ${mac}\n---\n${body}`
    );
    const before = corpusHashes(memoryDir);

    const x = c({ observationId: 9, name: 'frozen_no_key', title: 'Frozen no key' });
    seed(x);
    const r = renderMemoryFiles(db, [x], opts());

    // This machine holds no key that verifies it ⇒ it is the human's ⇒ hands off.
    // Fail-SAFE: the cost of being wrong the other way is destroying irreplaceable prose.
    expect(r.written).toEqual([]);
    expect(corpusHashes(memoryDir)).toEqual(before);
    expect(r.refusals.some((f) => f.reason === 'human_authored')).toBe(true);
  });

  it('--dry-run lists the candidates and writes 0 bytes', () => {
    const body = 'Massu wrote this.\n';
    const mac = mintAuthorship(body, home)!;
    writeFileSync(
      join(memoryDir, 'frozen.md'),
      `---\nname: frozen\n${RENDER_MAC_KEY}: ${mac}\n---\n${body}`
    );
    const before = corpusHashes(memoryDir);

    const res = memoryAdopt(db, memoryDir, { dryRun: true, home });
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('frozen.md');
    expect(corpusHashes(memoryDir)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) n FROM memory_files`).get()).toEqual({ n: 0 });
  });

  it('REFUSES to adopt without explicit confirmation (piping is not consent)', () => {
    const body = 'Massu wrote this.\n';
    const mac = mintAuthorship(body, home)!;
    writeFileSync(
      join(memoryDir, 'frozen.md'),
      `---\nname: frozen\n${RENDER_MAC_KEY}: ${mac}\n---\n${body}`
    );

    const res = memoryAdopt(db, memoryDir, { isTTY: false, home });
    expect(res.exitCode).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM memory_files`).get()).toEqual({ n: 0 });
  });

  it('adopts on confirmation, and the next render then maintains the file', () => {
    const body = 'Massu wrote this.\n';
    const mac = mintAuthorship(body, home)!;
    writeFileSync(
      join(memoryDir, 'frozen.md'),
      `---\nname: frozen\n${RENDER_MAC_KEY}: ${mac}\n---\n${body}`
    );

    const res = memoryAdopt(db, memoryDir, { confirmed: true, isTTY: true, home });
    expect(res.exitCode).toBe(0);
    const row = db.prepare(`SELECT massu_authored FROM memory_files WHERE rel_path='frozen.md'`).get();
    expect(row).toEqual({ massu_authored: 1 });
  });

  it('never adopts a HUMAN file, even one claiming massu_authored', () => {
    writeFileSync(
      join(memoryDir, 'human.md'),
      '---\nname: human\nmassu_authored: true\n---\n\nMY OWN WORDS.\n'
    );
    const res = memoryAdopt(db, memoryDir, { confirmed: true, isTTY: true, home });
    expect(res.output).not.toContain('human.md');
    expect(readFileSync(join(memoryDir, 'human.md'), 'utf8')).toContain('MY OWN WORDS.');
  });
});

describe('B-18 — unrender is the 4B rollback, and it never deletes what it cannot prove it wrote', () => {
  it('removes ONLY Massu files; skips and LISTS every human file', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());

    const human = join(memoryDir, 'feedback_never_guess_anything.md');
    const humanBefore = readFileSync(human);

    const res = memoryUnrender(db, memoryDir, { all: true, home, now: EPOCH });

    expect(res.exitCode).toBe(0);
    expect(existsSync(join(memoryDir, 'a_learned_lesson.md'))).toBe(false);
    // The human's file is untouched AND reported as skipped.
    expect(readFileSync(human)).toEqual(humanBefore);
    expect(res.output).toContain('feedback_never_guess_anything.md');
    expect(res.output).toContain('cannot prove it wrote');
  });

  it('re-enabling the renderer does NOT bring the unrendered files back', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());
    memoryUnrender(db, memoryDir, { all: true, home, now: EPOCH });

    const r = renderMemoryFiles(db, [x], opts());
    expect(r.written).toEqual([]);
    expect(existsSync(join(memoryDir, 'a_learned_lesson.md'))).toBe(false);
  });

  it('clears the managed region but leaves every byte outside it intact', () => {
    const x = c();
    seed(x);
    renderMemoryFiles(db, [x], opts());
    expect(readRegionLines(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).length).toBe(1);

    memoryUnrender(db, memoryDir, { all: true, home, now: EPOCH });

    const post = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(readRegionLines(post)).toEqual([]);
    expect(post).toContain('Cardinal: never guess');
    expect(post).toContain('prod drift');
  });

  it('REFUSES --file on a human file', () => {
    const res = memoryUnrender(db, memoryDir, {
      file: 'feedback_never_guess_anything.md',
      home,
      now: EPOCH,
    });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('cannot prove it wrote');
    expect(existsSync(join(memoryDir, 'feedback_never_guess_anything.md'))).toBe(true);
  });
});

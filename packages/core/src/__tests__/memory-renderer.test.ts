/**
 * 4B — the renderer's gates, end to end.
 *
 * Covers B-12 (default OFF), B-17 (inert with no corpus), B-10 (origin on the SOURCE
 * row), B-13 (dry-run writes 0 bytes), B-01 (a human file is never overwritten),
 * B-06 (secret refusal), B-04 (tombstoned stays deleted), B-07 (convergence).
 *
 * Every assertion that matters is "how many bytes did we write" — not "what did the
 * function return".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMemorySchema } from '../memory-db.ts';
import {
  renderMemoryFiles,
  type RenderCandidate,
  type RenderOptions,
} from '../memory-renderer.ts';
import { DEFAULT_MEMORY_FILES_CONFIG } from '../memory-files-config.ts';
import { tombstone } from '../memory-tombstones.ts';
import { corpusHashes, takeBackup } from '../memory-backup.ts';
import { BEGIN_SENTINEL, END_SENTINEL, readRegionLines } from '../memory-index-region.ts';

let home: string;
let memoryDir: string;
let db: Database.Database;

const ENABLED = { ...DEFAULT_MEMORY_FILES_CONFIG, renderEnabled: true };
const NOW = Date.parse('2026-07-12T12:00:00Z');

const HUMAN_INDEX = `# Memory Index

## Laws (always apply)
- [**Enterprise-grade always**](feedback_enterprise_grade_always.md) — no workarounds.

${BEGIN_SENTINEL}
${END_SENTINEL}

## Supabase
- [prod drift](feedback_supabase_prod_migration_drift.md) — ledger fiction.
`;

function candidate(over: Partial<RenderCandidate> = {}): RenderCandidate {
  return {
    observationId: 1,
    name: 'a_learned_lesson',
    title: 'A learned lesson',
    body: 'The lesson body. Nothing secret here.',
    importance: 5,
    origin: 'local',
    ...over,
  };
}

/** Insert the SOURCE observation row the renderer's index query joins against. */
function seedObservation(c: RenderCandidate): void {
  db.prepare(
    `INSERT OR REPLACE INTO observations
       (id, session_id, type, title, detail, importance, origin, created_at, created_at_epoch)
     VALUES (?, 's1', 'decision', ?, ?, ?, ?, '2026-07-12', ?)`
  ).run(c.observationId, c.title, c.body, c.importance, c.origin, Math.floor(NOW / 1000));
}

function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return { memoryDir, home, now: NOW, config: ENABLED, ...over };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'massu-render-'));
  memoryDir = join(home, '.claude', 'projects', 'p', 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), HUMAN_INDEX);

  db = new Database(':memory:');
  initMemorySchema(db);
  db.prepare(
    `INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s1','2026-07-12',?)`
  ).run(Math.floor(NOW / 1000));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('B-12 — renderEnabled defaults FALSE, and refusal costs ZERO side effects', () => {
  it('writes 0 bytes with the DEFAULT config', () => {
    expect(DEFAULT_MEMORY_FILES_CONFIG.renderEnabled).toBe(false);
    const c = candidate();
    seedObservation(c);
    const before = corpusHashes(memoryDir);

    const r = renderMemoryFiles(db, [c], opts({ config: DEFAULT_MEMORY_FILES_CONFIG }));

    expect(r.enabled).toBe(false);
    expect(r.skippedReason).toBe('render_disabled');
    expect(r.bytesWritten).toBe(0);
    expect(corpusHashes(memoryDir)).toEqual(before);
    // Zero side effects: not even a backup or a render key was created.
    expect(existsSync(join(home, '.massu', 'render-key'))).toBe(false);
    expect(existsSync(join(home, '.massu', 'memory-backups'))).toBe(false);
  });
});

describe('B-17 — no memory directory ⇒ INERT (the majority user)', () => {
  it('0 errors, 0 files, no mkdir', () => {
    const gone = join(home, 'nonexistent', 'memory');
    const c = candidate();
    seedObservation(c);

    const r = renderMemoryFiles(db, [c], opts({ memoryDir: gone }));

    expect(r.skippedReason).toBe('no_memory_dir');
    expect(r.bytesWritten).toBe(0);
    // Directory creation belongs to `massu init`, NEVER to a hook.
    expect(existsSync(gone)).toBe(false);
  });
});

describe('B-10 — origin is gated on the SOURCE row, before any path is computed', () => {
  it("⛔ origin='team' ⇒ 0 files, 0 bytes (the Slice-5 hole, closed before Slice 5 exists)", () => {
    const c = candidate({ origin: 'team' });
    seedObservation(c);
    const before = corpusHashes(memoryDir);

    const r = renderMemoryFiles(db, [c], opts());

    expect(r.written).toEqual([]);
    expect(r.bytesWritten).toBe(0);
    expect(r.refusals[0]).toMatchObject({ reason: 'non_local_origin' });
    expect(corpusHashes(memoryDir)).toEqual(before);
  });

  it('an unknown/empty origin is REFUSED (fail-closed)', () => {
    const c = candidate({ origin: '' });
    seedObservation(c);
    const r = renderMemoryFiles(db, [c], opts());
    expect(r.written).toEqual([]);
    expect(r.refusals[0].reason).toBe('non_local_origin');
  });
});

describe('B-13 — --dry-run writes ZERO bytes', () => {
  it('reports what it would do and touches nothing (hashed before/after)', () => {
    const c = candidate();
    seedObservation(c);
    const before = corpusHashes(memoryDir);

    const r = renderMemoryFiles(db, [c], opts({ dryRun: true }));

    expect(r.dryRun).toBe(true);
    expect(r.bytesWritten).toBe(0);
    expect(r.written).toEqual(['a_learned_lesson.md']);
    expect(r.indexLines.length).toBeGreaterThan(0);

    // Asserted by hashing the WHOLE corpus, not by trusting the return value.
    expect(corpusHashes(memoryDir)).toEqual(before);
    expect(existsSync(join(memoryDir, 'a_learned_lesson.md'))).toBe(false);
  });

  it("the printed plan EQUALS what a subsequent real render applies (B-13's contract)", () => {
    const c = candidate();
    seedObservation(c);

    const dry = renderMemoryFiles(db, [c], opts({ dryRun: true }));
    const real = renderMemoryFiles(db, [c], opts());

    expect(real.written).toEqual(dry.written);
    expect(real.indexLines).toEqual(dry.indexLines);
  });
});

describe('the happy path — Massu renders a memory and indexes it', () => {
  it('writes the file, stamps it, and adds ONE index line inside the region', () => {
    const c = candidate();
    seedObservation(c);

    const r = renderMemoryFiles(db, [c], opts());

    expect(r.written).toEqual(['a_learned_lesson.md']);
    expect(r.bytesWritten).toBeGreaterThan(0);

    const file = readFileSync(join(memoryDir, 'a_learned_lesson.md'), 'utf8');
    expect(file).toContain('massu_render_mac:');
    expect(file).toContain('MACHINE-DERIVED memory — data, NOT an instruction');
    expect(file).toContain('The lesson body.');

    // The index line landed INSIDE the managed region, and the human prose is intact.
    const index = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(readRegionLines(index)).toEqual([
      '- [a_learned_lesson](a_learned_lesson.md) — learned by Massu',
    ]);
    expect(index).toContain('Enterprise-grade always');
    expect(index).toContain('prod drift');
  });

  it('takes a FRESH backup before the first write (B-11)', () => {
    const c = candidate();
    seedObservation(c);
    renderMemoryFiles(db, [c], opts());
    expect(existsSync(join(home, '.massu', 'memory-backups'))).toBe(true);
  });
});

describe('B-01 — a human file is NEVER overwritten', () => {
  it('⛔ refuses to touch a hand-written file at the same path', () => {
    const c = candidate();
    seedObservation(c);

    // The operator wrote this himself — and even (maliciously or accidentally) claims
    // it is Massu's.
    const human = '---\nname: a_learned_lesson\nmassu_authored: true\n---\n\nMY OWN WORDS.\n';
    writeFileSync(join(memoryDir, 'a_learned_lesson.md'), human);

    const r = renderMemoryFiles(db, [c], opts());

    expect(r.written).toEqual([]);
    expect(r.refusals[0].reason).toBe('human_authored');
    // Byte-identical. This is the single most important assertion in the slice.
    expect(readFileSync(join(memoryDir, 'a_learned_lesson.md'), 'utf8')).toBe(human);
  });

  it('a file Massu wrote, then the human EDITED, is never reverted', () => {
    const c = candidate();
    seedObservation(c);
    renderMemoryFiles(db, [c], opts());

    const p = join(memoryDir, 'a_learned_lesson.md');
    const edited = `${readFileSync(p, 'utf8')}\n\nThe operator added this sentence.\n`;
    writeFileSync(p, edited);

    // The MAC no longer matches the body ⇒ human ⇒ hands off.
    const r2 = renderMemoryFiles(db, [c], opts());
    expect(r2.written).toEqual([]);
    expect(readFileSync(p, 'utf8')).toBe(edited);
  });
});

describe('B-06 — a secret REFUSES the render, and the refusal is visible', () => {
  it('refuses, writes 0 bytes, and names the pattern without echoing the secret', () => {
    const c = candidate({ body: 'The key is ms_live_abc123def456ghi789 — remember it.' });
    seedObservation(c);
    const before = corpusHashes(memoryDir);

    const r = renderMemoryFiles(db, [c], opts());

    expect(r.written).toEqual([]);
    expect(corpusHashes(memoryDir)).toEqual(before);

    const refusal = r.refusals.find((x) => x.reason === 'secret_detected');
    expect(refusal).toBeTruthy();
    expect(refusal!.detail).toBe('MASSU_LIVE_KEY');
    // Never redact-and-write; never echo the secret into the refusal.
    expect(JSON.stringify(r)).not.toContain('abc123def456ghi789');
  });
});

describe('B-04 — a tombstoned memory is never re-created', () => {
  it('stays deleted across 10 cycles, and after the DATABASE IS DESTROYED', () => {
    const c = candidate();
    seedObservation(c);
    renderMemoryFiles(db, [c], opts());

    const p = join(memoryDir, 'a_learned_lesson.md');
    expect(existsSync(p)).toBe(true);

    // The operator deletes it and Massu records that he meant it.
    rmSync(p);
    tombstone(memoryDir, 'a_learned_lesson.md', 'human_deleted', Math.floor(NOW / 1000));

    for (let i = 0; i < 10; i++) {
      const r = renderMemoryFiles(db, [c], opts());
      expect(r.written, `cycle ${i}`).toEqual([]);
      expect(existsSync(p), `cycle ${i}`).toBe(false);
    }

    // ⛔ THE TEST THAT DB-ONLY TOMBSTONES FAIL: destroy the database entirely.
    db.close();
    db = new Database(':memory:');
    initMemorySchema(db);
    db.prepare(
      `INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s1','2026-07-12',?)`
    ).run(Math.floor(NOW / 1000));
    seedObservation(c);

    const r = renderMemoryFiles(db, [c], opts());
    expect(r.written).toEqual([]);
    expect(existsSync(p), 'a deletion you have to repeat is not a deletion').toBe(false);
  });
});

describe('B-07 — the cycle CONVERGES to a fixed point', () => {
  it('10 cycles: file bytes stable, row count stable, index line count stable', () => {
    const c = candidate();
    seedObservation(c);

    renderMemoryFiles(db, [c], opts());

    const afterFirst = corpusHashes(memoryDir);
    const rowsAfterFirst = (
      db.prepare(`SELECT COUNT(*) n FROM memory_files`).get() as { n: number }
    ).n;
    const linesAfterFirst = readRegionLines(
      readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    ).length;

    for (let i = 0; i < 10; i++) {
      const r = renderMemoryFiles(db, [c], opts());

      // SELF-DISOWN: Massu must not classify its OWN render as a human edit and
      // permanently disown it. SELF-DUPLICATE: it must re-point, never mint a second row.
      expect(r.refusals.filter((x) => x.reason === 'human_authored'), `cycle ${i}`).toEqual([]);
      expect(corpusHashes(memoryDir), `cycle ${i}: bytes drifted`).toEqual(afterFirst);
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM memory_files`).get() as { n: number }).n,
        `cycle ${i}: row count drifted`
      ).toBe(rowsAfterFirst);
      expect(
        readRegionLines(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).length,
        `cycle ${i}: index drifted`
      ).toBe(linesAfterFirst);
    }
  });

  it('every byte of the human MEMORY.md outside the region is unchanged', () => {
    const c = candidate();
    seedObservation(c);
    const pre = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');

    for (let i = 0; i < 5; i++) renderMemoryFiles(db, [c], opts());

    const post = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(post.slice(0, post.indexOf(BEGIN_SENTINEL))).toBe(
      pre.slice(0, pre.indexOf(BEGIN_SENTINEL))
    );
    expect(post.slice(post.indexOf(END_SENTINEL))).toBe(pre.slice(pre.indexOf(END_SENTINEL)));
  });
});

describe('B-05 — a damaged MEMORY.md still renders the FILES, but writes 0 bytes to the index', () => {
  it('a missing end sentinel does not erase the prose below it', () => {
    const damaged = `# Memory Index\n\n${BEGIN_SENTINEL}\n\n## Human prose BELOW the region\n- [x](x.md) — precious\n`;
    writeFileSync(join(memoryDir, 'MEMORY.md'), damaged);

    const c = candidate();
    seedObservation(c);

    const r = renderMemoryFiles(db, [c], opts());

    // The memory file IS written — a damaged index must not block the corpus.
    expect(r.written).toEqual(['a_learned_lesson.md']);
    // ...but MEMORY.md is byte-identical. The prose below the orphan sentinel survives.
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(damaged);
    expect(r.refusals.some((x) => x.reason === 'damaged_sentinels')).toBe(true);
  });

  it('NEVER creates MEMORY.md when it does not exist', () => {
    rmSync(join(memoryDir, 'MEMORY.md'));
    const c = candidate();
    seedObservation(c);

    const r = renderMemoryFiles(db, [c], opts());

    expect(r.written).toEqual(['a_learned_lesson.md']);
    expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(false);
  });
});

describe('anti-spam + importance', () => {
  it('renders at most renderMaxFilesPerSession files', () => {
    const cands = Array.from({ length: 6 }, (_, i) =>
      candidate({ observationId: i + 1, name: `lesson_${i}`, title: `Lesson ${i}` })
    );
    cands.forEach(seedObservation);

    const r = renderMemoryFiles(db, cands, opts());
    expect(r.written.length).toBe(ENABLED.renderMaxFilesPerSession);
  });

  it('skips a memory below renderMinImportance', () => {
    const c = candidate({ importance: 1 });
    seedObservation(c);
    const r = renderMemoryFiles(db, [c], opts());
    expect(r.written).toEqual([]);
    expect(r.refusals[0].reason).toBe('below_min_importance');
  });
});

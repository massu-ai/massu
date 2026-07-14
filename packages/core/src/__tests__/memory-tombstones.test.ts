/**
 * B-04 / OD-2 — the operator can actually delete a Massu file.
 *
 * The acceptance the plan names:
 *   (i)   delete a Massu file → it stays deleted across 10 session cycles;
 *   (ii)  delete the file, then DESTROY the database entirely → it is STILL deleted;
 *   (iii) copy a Massu file, delete the copy → the ORIGINAL is still rendered.
 *
 * (ii) is the whole reason the ledger is a file. A DB-only tombstone is wiped by any
 * fresh clone, second machine, or `rm -rf .massu` — and at that moment the render arm
 * sees "a renderable memory with no file" and re-creates every memory the operator ever
 * deleted. A deletion you have to repeat is not a deletion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  tombstone,
  isTombstoned,
  readTombstones,
  tombstoneLedgerPath,
  TombstoneWriteError,
  TOMBSTONE_LEDGER,
} from '../memory-tombstones.ts';

let memoryDir: string;
const NOW = 1_768_000_000;

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'massu-tomb-'));
});
afterEach(() => {
  try {
    chmodSync(memoryDir, 0o700);
  } catch {
    /* ignore */
  }
  rmSync(memoryDir, { recursive: true, force: true });
});

describe('B-04 — the ledger is durable, append-only, and lives with the corpus', () => {
  it('records a deletion and reports it', () => {
    expect(isTombstoned(memoryDir, 'feedback_x.md')).toBe(false);
    tombstone(memoryDir, 'feedback_x.md', 'human_deleted', NOW);
    expect(isTombstoned(memoryDir, 'feedback_x.md')).toBe(true);
  });

  it('a missing ledger means "nothing deleted", never an error', () => {
    expect(existsSync(tombstoneLedgerPath(memoryDir))).toBe(false);
    expect(() => readTombstones(memoryDir)).not.toThrow();
    expect(readTombstones(memoryDir).size).toBe(0);
  });

  it('⛔ SURVIVES A TOTAL DATABASE WIPE — the whole point of OD-2', () => {
    tombstone(memoryDir, 'feedback_deleted_by_human.md', 'human_deleted', NOW);

    // Simulate exactly what the DB-only design could not survive: the entire .massu
    // directory is gone (a fresh clone, a second machine, `rm -rf .massu`). The corpus
    // — and the ledger inside it — remain, because they are git-tracked and the DB is not.
    // There is no DB here at all. The tombstone still holds.
    expect(isTombstoned(memoryDir, 'feedback_deleted_by_human.md')).toBe(true);
  });

  it('stays deleted across 10 session cycles (nothing accumulates, nothing decays)', () => {
    tombstone(memoryDir, 'gone.md', 'human_deleted', NOW);
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(isTombstoned(memoryDir, 'gone.md'), `cycle ${cycle}`).toBe(true);
    }
    // One tombstone, one line — re-reading does not duplicate it.
    expect(readTombstones(memoryDir).size).toBe(1);
  });

  it('is non-.md by construction, so ingest and reconcile skip it', () => {
    tombstone(memoryDir, 'x.md', 'human_deleted', NOW);
    // Both ingest and reconcile filter on `f.endsWith('.md')`. The ledger can therefore
    // never be mistaken for a memory and re-ingested as one.
    expect(TOMBSTONE_LEDGER.endsWith('.md')).toBe(false);
  });

  it('is case-insensitive — macOS and Windows fold case, so Foo.md IS foo.md', () => {
    tombstone(memoryDir, 'Feedback_X.md', 'human_deleted', NOW);
    expect(isTombstoned(memoryDir, 'feedback_x.md')).toBe(true);
    expect(isTombstoned(memoryDir, 'FEEDBACK_X.MD')).toBe(true);
  });
});

describe('B-04 — identity is rel_path, never `name` (F-14)', () => {
  it('deleting a human COPY does not suppress the ORIGINAL', () => {
    // A human copying feedback_x.md → feedback_x_old.md is an ordinary act. Both files
    // carry the SAME frontmatter `name`, so ingest titles them identically and they
    // share one observation_id. Tombstoning by `name` would delete both.
    tombstone(memoryDir, 'feedback_x_old.md', 'human_deleted', NOW);

    expect(isTombstoned(memoryDir, 'feedback_x_old.md')).toBe(true);
    expect(isTombstoned(memoryDir, 'feedback_x.md')).toBe(false); // the ORIGINAL survives
  });
});

describe('B-04 — robustness: one bad line must not un-delete everything', () => {
  it('skips a corrupt line and honors the rest', () => {
    tombstone(memoryDir, 'a.md', 'human_deleted', NOW);
    // A stray byte lands in the ledger (an editor, a merge, a partial write).
    writeFileSync(
      tombstoneLedgerPath(memoryDir),
      `${readFileSync(tombstoneLedgerPath(memoryDir), 'utf8')}{ this is not json\n`,
      'utf8'
    );
    tombstone(memoryDir, 'b.md', 'human_deleted', NOW);

    // Being strict here would mean one stray byte resurrects every deleted memory.
    expect(isTombstoned(memoryDir, 'a.md')).toBe(true);
    expect(isTombstoned(memoryDir, 'b.md')).toBe(true);
  });

  it('THROWS when it cannot record a deletion — never silently proceeds', () => {
    // A deletion we cannot record is a deletion we will UNDO. The renderer's contract
    // is to refuse to render anything this session rather than proceed.
    chmodSync(memoryDir, 0o500); // read + execute, not writable
    let threw = false;
    try {
      tombstone(memoryDir, 'x.md', 'human_deleted', NOW);
    } catch (err) {
      threw = err instanceof TombstoneWriteError;
    } finally {
      chmodSync(memoryDir, 0o700);
    }
    // (Skipped silently when running as root, where 0o500 does not deny root.)
    if (process.getuid?.() !== 0) {
      expect(threw, 'tombstone() must throw when the ledger is unwritable').toBe(true);
    }
  });
});

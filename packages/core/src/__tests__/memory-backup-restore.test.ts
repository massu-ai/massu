/**
 * B-11 — backups that are REAL: outside git, bounded, fresh, and restorable.
 *
 * An untested restore path is not a backup; it is a folder you hope is right.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  takeBackup,
  listBackups,
  hasFreshBackup,
  restoreBackup,
  corpusHashes,
  backupsRoot,
  newestMtimeMs,
  BackupError,
  DEFAULT_RETENTION,
} from '../memory-backup.ts';

let home: string;
let memoryDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'massu-bk-home-'));
  memoryDir = join(home, '.claude', 'projects', 'proj', 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n- [a](a.md) — hook\n');
  writeFileSync(join(memoryDir, 'feedback_a.md'), '---\nname: a\n---\n\nThe body of A.\n');
  writeFileSync(join(memoryDir, 'feedback_b.md'), '---\nname: b\n---\n\nThe body of B.\n');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const T0 = Date.parse('2026-07-12T10:00:00Z');

describe('B-11 — backups live OUTSIDE the memory dir and outside git', () => {
  it('writes to ~/.massu/memory-backups/<iso>/, never inside the corpus', () => {
    const info = takeBackup(memoryDir, T0, home);
    expect(info.dir.startsWith(backupsRoot(home))).toBe(true);
    // The memory dir is git-tracked and pushed. A snapshot inside it would duplicate the
    // corpus in the operator's repo forever.
    expect(info.dir.startsWith(memoryDir)).toBe(false);
  });

  it('the stamp has no colon — a colon is not a legal Windows filename character', () => {
    const info = takeBackup(memoryDir, T0, home);
    expect(info.stamp).not.toContain(':');
  });
});

describe('B-11 — the gate checks FRESHNESS, not existence', () => {
  it('⛔ a backup taken BEFORE the operator edited a file does NOT satisfy the gate', () => {
    // This is the defect: "a backup exists" is satisfied forever by one backup taken
    // before render #1, and every subsequent write is then unprotected while the gate
    // reports green.
    takeBackup(memoryDir, T0, home);
    expect(hasFreshBackup(memoryDir, home)).toBe(true);

    // The operator now edits a memory. The backup no longer contains what we are about
    // to modify.
    const f = join(memoryDir, 'feedback_a.md');
    writeFileSync(f, '---\nname: a\n---\n\nThe operator rewrote this by hand.\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);

    expect(hasFreshBackup(memoryDir, home)).toBe(false);
  });

  it('no backups at all ⇒ not fresh', () => {
    expect(hasFreshBackup(memoryDir, home)).toBe(false);
  });

  it('a backup taken AFTER the newest change satisfies the gate', () => {
    const newest = newestMtimeMs(memoryDir);
    takeBackup(memoryDir, newest + 5_000, home);
    expect(hasFreshBackup(memoryDir, home)).toBe(true);
  });
});

describe('B-11 — retention is bounded', () => {
  it('never exceeds N entries', () => {
    for (let i = 0; i < DEFAULT_RETENTION + 5; i++) {
      takeBackup(memoryDir, T0 + i * 1000, home, DEFAULT_RETENTION);
    }
    expect(listBackups(home).length).toBeLessThanOrEqual(DEFAULT_RETENTION);
  });

  it('prunes the OLDEST, keeping the newest', () => {
    for (let i = 0; i < 3; i++) takeBackup(memoryDir, T0 + i * 1000, home, 2);
    const kept = listBackups(home);
    expect(kept.length).toBe(2);
    // Newest first.
    expect(kept[0].createdMs).toBeGreaterThanOrEqual(kept[1].createdMs);
  });
});

describe('B-11 — restore reproduces the corpus BYTE-IDENTICALLY', () => {
  it('restores every file byte-for-byte over a corrupted corpus (asserted by hash)', () => {
    const before = corpusHashes(memoryDir);
    takeBackup(memoryDir, T0, home);

    // Catastrophe: a bad write truncates one memory and mangles another.
    writeFileSync(join(memoryDir, 'feedback_a.md'), '');
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'CORRUPTED\n');

    expect(corpusHashes(memoryDir)).not.toEqual(before);

    const res = restoreBackup(memoryDir, { home });
    expect(res.dryRun).toBe(false);
    expect(res.filesRestored).toBe(3);

    // By hash, not by eyeball.
    expect(corpusHashes(memoryDir)).toEqual(before);
    expect(readFileSync(join(memoryDir, 'feedback_a.md'), 'utf8')).toContain('The body of A.');
  });

  it('backs up the tombstone ledger too — a restore that loses it un-deletes everything', () => {
    writeFileSync(
      join(memoryDir, '.massu-tombstones.jsonl'),
      '{"rel_path":"gone.md","tombstoned_at_epoch":1,"reason":"human_deleted"}\n'
    );
    takeBackup(memoryDir, T0 + 10_000, home);
    rmSync(join(memoryDir, '.massu-tombstones.jsonl'));

    restoreBackup(memoryDir, { home });

    // If backup only copied *.md, the ledger would be lost and every deleted memory
    // would come back on the next render.
    expect(readFileSync(join(memoryDir, '.massu-tombstones.jsonl'), 'utf8')).toContain('gone.md');
  });

  it('--dry-run writes ZERO bytes and reports what it would do', () => {
    takeBackup(memoryDir, T0, home);
    writeFileSync(join(memoryDir, 'feedback_a.md'), 'MANGLED');
    const before = corpusHashes(memoryDir);

    const res = restoreBackup(memoryDir, { home, dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.filesRestored).toBe(0);
    expect(res.wouldRestore).toEqual(expect.arrayContaining(['feedback_a.md', 'MEMORY.md']));
    expect(corpusHashes(memoryDir)).toEqual(before); // not one byte touched
  });

  it('restores from a NAMED stamp', () => {
    const first = takeBackup(memoryDir, T0, home);
    writeFileSync(join(memoryDir, 'feedback_a.md'), '---\nname: a\n---\n\nVERSION TWO\n');
    takeBackup(memoryDir, T0 + 60_000, home);

    restoreBackup(memoryDir, { home, from: first.stamp });
    expect(readFileSync(join(memoryDir, 'feedback_a.md'), 'utf8')).toContain('The body of A.');
  });

  it('restore is NOT a deletion primitive — it reports, but does not remove, extra files', () => {
    takeBackup(memoryDir, T0, home);
    writeFileSync(join(memoryDir, 'feedback_new.md'), '---\nname: new\n---\n\nWritten later.\n');

    const res = restoreBackup(memoryDir, { home });

    // Massu does not get a deletion primitive, not even inside `restore`. It tells the
    // operator which files are new; removing them is his call.
    expect(res.presentButNotInBackup).toContain('feedback_new.md');
    expect(readFileSync(join(memoryDir, 'feedback_new.md'), 'utf8')).toContain('Written later.');
  });

  it('throws a clear error when there is nothing to restore', () => {
    expect(() => restoreBackup(memoryDir, { home })).toThrow(BackupError);
    takeBackup(memoryDir, T0, home);
    expect(() => restoreBackup(memoryDir, { home, from: 'nope' })).toThrow(/no backup with stamp/);
  });

  it('refuses to back up a memory dir that does not exist', () => {
    expect(() => takeBackup(join(home, 'nope'), T0, home)).toThrow(BackupError);
  });
});

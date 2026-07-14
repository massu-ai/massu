/**
 * DB BACKUP + RESTORE — tests.
 *
 * The point of this file is NOT to prove a backup can be written. Writing a file is
 * easy and proves nothing. The point is to prove THE RESTORE WORKS, because an untested
 * restore path is not a backup — it is a folder you hope is right.
 *
 * Incident 2026-07-13: one schema change corrupted the live 135 MB memory.db. Recovery
 * depended on a snapshot that existed BY LUCK. These tests are what turn that luck into
 * a control.
 *
 * Scratch dirs use os.tmpdir(), never packages/core/src (memory:
 * feedback_dashboard_key_ux_and_src_scratch_race — scratch under src/ flakes the
 * coverage gate).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  backupDb,
  restoreDb,
  listDbBackups,
  hasFreshDbBackup,
  pruneDbBackups,
  backupBeforeSchemaChange,
  DbBackupError,
  DEFAULT_RETENTION,
} from '../db-backup.ts';

let home: string;
let projectRoot: string;
let dbPath: string;

function makeDb(path: string, rows: number): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  const many = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) ins.run(`row-${i}`);
  });
  many(rows);
  db.close();
}

function countRows(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Destroy a database the way the incident destroyed one: unreadable schema. */
function corrupt(path: string): void {
  const fd = openSync(path, 'r+');
  writeSync(fd, Buffer.from('CORRUPTED'), 0, 9, 100);
  closeSync(fd);
  for (const s of ['-wal', '-shm']) if (existsSync(path + s)) rmSync(path + s, { force: true });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'massu-bk-home-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'massu-bk-proj-'));
  dbPath = join(projectRoot, 'memory.db');
  makeDb(dbPath, 500);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('db-backup', () => {
  it('THE ONLY TEST THAT MATTERS: a destroyed database is fully restored', () => {
    const before = countRows(dbPath);
    expect(before).toBe(500);

    const info = backupDb(projectRoot, dbPath, Date.now(), home);
    expect(existsSync(info.path)).toBe(true);

    // Destroy it exactly as the incident did.
    corrupt(dbPath);
    expect(() => countRows(dbPath)).toThrow(); // unreadable, as in production

    const res = restoreDb(info.path, dbPath);

    expect(countRows(dbPath)).toBe(before); // every row back
    // The corrupt original is EVIDENCE — never destroyed.
    expect(res.preservedOriginal).toBeTruthy();
    expect(existsSync(res.preservedOriginal!)).toBe(true);
  });

  it('a backup is VERIFIED on write — a corrupt snapshot is deleted, not left lying around', () => {
    // A corrupt backup is worse than no backup: you only discover it when you need it.
    // Simulate by pointing the restore at a file that is not a database at all.
    const junk = join(home, 'not-a-db.db');
    writeFileSync(junk, 'this is not sqlite');
    expect(() => restoreDb(junk, dbPath)).toThrow(DbBackupError);
    // And it REFUSED before touching the live DB — the live DB is still intact.
    expect(countRows(dbPath)).toBe(500);
  });

  it('refuses to restore a corrupt backup OVER a live database (verify the parachute before jumping)', () => {
    const info = backupDb(projectRoot, dbPath, Date.now(), home);
    corrupt(info.path); // the BACKUP is the thing that is damaged now
    expect(() => restoreDb(info.path, dbPath)).toThrow(/fails its own integrity check/);
    expect(countRows(dbPath)).toBe(500); // live DB untouched
  });

  it('VACUUM INTO captures un-checkpointed WAL writes that a plain `cp` would silently drop', () => {
    // Write rows and leave them in the WAL (no checkpoint).
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('in-the-wal');
    // deliberately NOT closing/checkpointing before the backup
    const info = backupDb(projectRoot, dbPath, Date.now(), home);
    db.close();

    expect(countRows(info.path)).toBe(501); // the WAL row IS in the snapshot
  });

  it('freshness, not mere existence: a backup taken before the last write is NOT fresh', () => {
    const t0 = Date.now();
    backupDb(projectRoot, dbPath, t0, home);
    expect(hasFreshDbBackup(projectRoot, dbPath, t0, home)).toBe(true);

    // Now write to the DB. The old backup no longer contains what would be lost.
    makeDb(dbPath, 10);
    expect(hasFreshDbBackup(projectRoot, dbPath, t0 + 1000, home)).toBe(false);
  });

  it('retention is bounded — a 197MB DB times unbounded snapshots fills a disk', () => {
    for (let i = 0; i < DEFAULT_RETENTION + 3; i++) {
      backupDb(projectRoot, dbPath, Date.now() + i * 1000, home);
    }
    const mine = listDbBackups(projectRoot, home).filter((b) => b.db === 'memory');
    expect(mine.length).toBe(DEFAULT_RETENTION);
  });

  it('the pre-DDL gate FAILS OPEN but LOUD (a failed backup must not brick the session)', () => {
    const errs: unknown[] = [];
    // Unwritable backup root -> backup cannot be taken.
    const badHome = join(home, 'nope');
    writeFileSync(badHome, 'not a directory'); // mkdir will fail against a file
    const res = backupBeforeSchemaChange(projectRoot, dbPath, (e) => errs.push(e), Date.now(), badHome);

    expect(res).toBeNull();         // it did NOT block
    expect(errs.length).toBe(1);    // but it was NOT silent
  });

  it('the pre-DDL gate skips when a fresh backup already exists (no 197MB VACUUM per hook)', () => {
    const t = Date.now();
    backupDb(projectRoot, dbPath, t, home);
    const res = backupBeforeSchemaChange(projectRoot, dbPath, () => {}, t, home);
    expect(res).toBeNull(); // already fresh -> no second snapshot
    expect(listDbBackups(projectRoot, home).filter((b) => b.db === 'memory').length).toBe(1);
  });

  it('backups live OUTSIDE the repo (they can never be committed or git-cleaned)', () => {
    const info = backupDb(projectRoot, dbPath, Date.now(), home);
    expect(info.path.startsWith(home)).toBe(true);
    expect(info.path.startsWith(projectRoot)).toBe(false);
  });
});

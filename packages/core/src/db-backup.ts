/**
 * DATABASE BACKUP + RESTORE — real backups for every store Massu owns.
 *
 * WHY THIS EXISTS (incident 2026-07-13):
 * Adding ONE table to the live 135 MB `memory.db` corrupted it — "malformed database
 * schema (hook_health) - invalid rootpage". Every query failed. 251,956 recorded tool
 * calls and 29 sessions became unreadable.
 *
 * It was recovered ONLY because a copy happened to exist: I had snapshotted the DB
 * earlier in the same session for an unrelated reason. **"We got lucky" is not a
 * control.** SQLite's own `.recover` was tried and was WORSE — it salvaged 184,089 of
 * 251,956 rows (27% loss) and produced a still-malformed FTS5 index.
 *
 * Massu rewrites its schema (`initMemorySchema`) on EVERY open of the database, from
 * 10 of its 18 hooks. Until now, nothing anywhere backed those databases up.
 *
 * DESIGN — the four rules inherited from `memory-backup.ts` (B-11), which learned them
 * the hard way, plus one this incident adds:
 *
 *   1. OUTSIDE GIT. `~/.massu/db-backups/<project>/` — never inside the repo, so a
 *      backup can never be committed, pushed, or wiped by a `git clean`.
 *   2. BOUNDED. Retention caps growth; a 197 MB DB × unbounded snapshots fills a disk
 *      (this host hit 99.9% full once already).
 *   3. FRESH. "A backup exists" is satisfied forever by ONE backup taken years ago,
 *      while the gate reports green. Freshness is what matters: a backup that actually
 *      contains what is about to be modified.
 *   4. RESTORABLE. **An untested restore path is not a backup; it is a folder you hope
 *      is right.** `restoreDb()` ships with a row-identical test.
 *   5. (NEW) VERIFIED ON WRITE. A corrupt backup is worse than no backup, because you
 *      only discover it at the moment you need it. Every backup is `integrity_check`ed
 *      immediately after it is written, and a failing one is DELETED and raises.
 *
 * WHY `VACUUM INTO` AND NOT `cp`:
 * These databases run in WAL mode. A plain `cp` of the `.db` file captures only the last
 * CHECKPOINTED state and silently drops everything sitting in the `-wal` — you get a
 * backup that is quietly out of date. (My lucky snapshot was exactly such a `cp`; it
 * happened to be consistent, which is precisely the sort of thing one should not rely
 * on.) `VACUUM INTO` asks SQLite itself for a transactionally-consistent, defragmented
 * copy, WAL included. It is the only correct way to snapshot a live SQLite database.
 */

import type Database from 'better-sqlite3';
import { openDatabase } from './lib/sqlite-loader.ts';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, rmSync } from 'fs';
import { resolve, join, basename, dirname } from 'path';
import { homedir } from 'os';

/** Keep the last N backups per database. */
export const DEFAULT_RETENTION = 5;

/** A backup older than this no longer counts as "fresh" for the pre-DDL gate. */
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export class DbBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbBackupError';
  }
}

export interface DbBackupInfo {
  db: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** Backups live OUTSIDE every repo. Never inside `.massu/` (which lives in the repo). */
export function dbBackupsRoot(home: string = homedir()): string {
  return resolve(home, '.massu', 'db-backups');
}

/** One namespace per project, so two repos never overwrite each other's snapshots. */
export function projectBackupDir(projectRoot: string, home: string = homedir()): string {
  const slug = basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  return join(dbBackupsRoot(home), slug);
}

/** Sortable, filesystem-safe UTC stamp. */
export function backupStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

export function listDbBackups(projectRoot: string, home: string = homedir()): DbBackupInfo[] {
  const dir = projectBackupDir(projectRoot, home);
  if (!existsSync(dir)) return [];
  const out: DbBackupInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.db')) continue;
    const p = join(dir, f);
    const st = statSync(p);
    // "<db>-<stamp>.db" -> "<db>"
    const db = f.replace(/-\d{4}-\d{2}-\d{2}T.*$/, '');
    out.push({ db, path: p, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Is there a backup of `dbPath` newer than the database's own last modification?
 *
 * This is the freshness question that matters: not "does a backup exist" (a question
 * that is satisfied forever by one ancient file) but "does a backup contain what is
 * about to be modified".
 */
export function hasFreshDbBackup(
  projectRoot: string,
  dbPath: string,
  nowMs: number = Date.now(),
  home: string = homedir(),
): boolean {
  const name = basename(dbPath, '.db');
  const backups = listDbBackups(projectRoot, home).filter((b) => b.db === name);
  if (backups.length === 0) return false;
  const newest = backups[0];
  if (nowMs - newest.mtimeMs > FRESH_WINDOW_MS) return false;
  // A backup taken BEFORE the last write does not contain the last write.
  if (existsSync(dbPath) && statSync(dbPath).mtimeMs > newest.mtimeMs) return false;
  return true;
}

function integrityOk(dbPath: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = openDatabase(dbPath, { readonly: true });
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return rows.length === 1 && rows[0].integrity_check === 'ok';
  } catch {
    // Cannot even open it -> definitively not ok. (Not a swallow: the boolean IS the
    // signal, and every caller treats false as failure.)
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* SWALLOW-OK: closing a handle we are discarding; the verdict is already computed. */
    }
  }
}

/**
 * Take a transactionally-consistent, integrity-VERIFIED snapshot of one database.
 *
 * @throws {DbBackupError} if the snapshot cannot be taken, or if the snapshot it took
 *   fails its own integrity check (in which case the bad snapshot is deleted — a corrupt
 *   backup that sits there looking like a backup is the worst possible outcome).
 */
export function backupDb(
  projectRoot: string,
  dbPath: string,
  nowMs: number = Date.now(),
  home: string = homedir(),
): DbBackupInfo {
  if (!existsSync(dbPath)) {
    throw new DbBackupError(`cannot back up a database that does not exist: ${dbPath}`);
  }
  const dir = projectBackupDir(projectRoot, home);
  mkdirSync(dir, { recursive: true });

  const name = basename(dbPath, '.db');
  const dest = join(dir, `${name}-${backupStamp(nowMs)}.db`);

  let src: Database.Database | null = null;
  try {
    src = openDatabase(dbPath, { readonly: true });
    // VACUUM INTO — SQLite's own consistent-snapshot primitive. Includes the WAL.
    // A `cp` here would silently drop un-checkpointed writes.
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (err) {
    throw new DbBackupError(
      `VACUUM INTO failed for ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      src?.close();
    } catch {
      /* SWALLOW-OK: read-only handle being discarded; the snapshot is already written. */
    }
  }

  // RULE 5: verify the backup we just wrote. An unverified backup is a hope.
  if (!integrityOk(dest)) {
    try {
      unlinkSync(dest);
    } catch {
      /* SWALLOW-OK: best-effort cleanup of a file we are about to raise about. */
    }
    throw new DbBackupError(
      `the backup of ${dbPath} FAILED its own integrity check and was deleted. ` +
        `A corrupt backup is worse than none — you only discover it when you need it.`,
    );
  }

  pruneDbBackups(projectRoot, name, DEFAULT_RETENTION, home);
  const st = statSync(dest);
  return { db: name, path: dest, bytes: st.size, mtimeMs: st.mtimeMs };
}

/** Bounded retention: keep the newest `keep` snapshots of one database, delete the rest. */
export function pruneDbBackups(
  projectRoot: string,
  dbName: string,
  keep: number = DEFAULT_RETENTION,
  home: string = homedir(),
): number {
  const mine = listDbBackups(projectRoot, home).filter((b) => b.db === dbName);
  let removed = 0;
  for (const old of mine.slice(keep)) {
    try {
      unlinkSync(old.path);
      removed++;
    } catch {
      /* SWALLOW-OK: a snapshot we failed to delete is a disk-space issue, not a
         correctness one; retention is best-effort and re-runs every backup. */
    }
  }
  return removed;
}

/**
 * Restore a database from a backup.
 *
 * THE RESTORE PATH IS A FIRST-CLASS DELIVERABLE. An untested restore is not a backup.
 * The corrupt original is preserved next to the target as `<db>.corrupt-<stamp>` —
 * never destroyed, because it is evidence, and because a restore that turns out to be
 * wrong must be reversible.
 *
 * @throws {DbBackupError} if the backup is missing or fails integrity BEFORE we touch
 *   the live database. We verify the parachute before jumping.
 */
export function restoreDb(
  backupPath: string,
  dbPath: string,
  nowMs: number = Date.now(),
  home: string = homedir(),
): { restoredFrom: string; preservedOriginal: string | null } {
  if (!existsSync(backupPath)) {
    throw new DbBackupError(`backup not found: ${backupPath}`);
  }
  // Verify the backup BEFORE we disturb the live file. Restoring a corrupt backup over
  // a corrupt database leaves you with nothing at all.
  if (!integrityOk(backupPath)) {
    throw new DbBackupError(
      `REFUSING TO RESTORE: the backup at ${backupPath} fails its own integrity check.`,
    );
  }

  let preserved: string | null = null;
  if (existsSync(dbPath)) {
    // The corrupt original is EVIDENCE and is never destroyed — but it does NOT belong
    // beside the live database. The first version of this wrote it next to `.massu/memory.db`,
    // which dropped a 188 MB file inside the repo working tree and FAILED the deploy
    // pre-flight ("working tree has uncommitted changes"). A recovery artifact belongs
    // where the backups live: outside the repo, where it can never be committed, pushed,
    // or picked up by a gate that reasonably expects a clean tree.
    const dir = dirname(backupPath) || projectBackupDir(process.cwd(), home);
    mkdirSync(dir, { recursive: true });
    preserved = join(dir, `${basename(dbPath, '.db')}.corrupt-${backupStamp(nowMs)}.db`);
    copyFileSync(dbPath, preserved);
  }

  // Remove the sidecars too: a stale -wal/-shm against a restored .db is corruption.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  copyFileSync(backupPath, dbPath);

  if (!integrityOk(dbPath)) {
    throw new DbBackupError(
      `restore completed but the restored database fails integrity_check — original preserved at ${preserved}`,
    );
  }
  return { restoredFrom: backupPath, preservedOriginal: preserved };
}

/**
 * THE PRE-DDL GATE — the direct fix for the 2026-07-13 incident.
 *
 * Called immediately before a schema change is applied to a database. Takes a backup
 * first, unless a fresh one already exists.
 *
 * FAIL-OPEN, DELIBERATELY: if the backup cannot be taken we do NOT block the schema
 * change — blocking would make a full disk (or a read-only $HOME) brick every hook, and
 * Massu must never take the user's session down. But it is LOUD: the caller records a
 * durable hook-failure signal. Broken may never be quiet (G-2).
 *
 * @returns the backup taken, or null if one was already fresh / could not be taken.
 */
export function backupBeforeSchemaChange(
  projectRoot: string,
  dbPath: string,
  onError: (err: unknown) => void,
  nowMs: number = Date.now(),
  home: string = homedir(),
): DbBackupInfo | null {
  try {
    if (!existsSync(dbPath)) return null; // a brand-new DB has nothing to lose
    if (hasFreshDbBackup(projectRoot, dbPath, nowMs, home)) return null;
    return backupDb(projectRoot, dbPath, nowMs, home);
  } catch (err) {
    onError(err);
    return null;
  }
}

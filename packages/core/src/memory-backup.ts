/**
 * B-11 — backups that are real: outside git, bounded, FRESH, and RESTORABLE.
 *
 * The draft said "cp -a the memory dir to a timestamped snapshot" and "refuse to run
 * until a backup exists". Three defects, each fatal on its own:
 *
 *   1. "a backup EXISTS" is satisfied FOREVER by one backup taken before render #1.
 *      Every subsequent write is then unprotected, while the gate reports green. The
 *      gate must check FRESHNESS: a backup that actually contains what is about to be
 *      modified.
 *   2. A snapshot INSIDE the memory dir is git-tracked and pushed (the dir is
 *      whitelisted into git), duplicating the corpus in the operator's repo forever.
 *      Backups live at `~/.massu/memory-backups/` — outside the memory dir, outside
 *      every repo.
 *   3. `massu memory restore` did not exist. AN UNTESTED RESTORE PATH IS NOT A BACKUP;
 *      it is a folder you hope is right. It is a first-class deliverable here, with a
 *      byte-identical-restoration test.
 */
import {
  readdirSync,
  mkdirSync,
  copyFileSync,
  statSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';

/** Keep the last N backups. Never unbounded — this is the operator's disk. */
export const DEFAULT_RETENTION = 10;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export function backupsRoot(home: string = homedir()): string {
  return resolve(home, '.massu', 'memory-backups');
}

/** ISO-8601 with `:` replaced — a colon is not a legal filename character on Windows. */
export function backupStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/:/g, '-');
}

/** The newest mtime (ms) of any file in the memory dir. 0 if the dir is empty/absent. */
export function newestMtimeMs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      continue; // vanished mid-walk
    }
  }
  return newest;
}

export interface BackupInfo {
  stamp: string;
  dir: string;
  createdMs: number;
}

/** Every backup, newest first. */
export function listBackups(home: string = homedir()): BackupInfo[] {
  const root = backupsRoot(home);
  if (!existsSync(root)) return [];
  const out: BackupInfo[] = [];
  for (const stamp of readdirSync(root)) {
    const dir = join(root, stamp);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      out.push({ stamp, dir, createdMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.createdMs - a.createdMs);
}

/**
 * FRESHNESS, not existence (the whole point of B-11).
 *
 * A backup is fresh iff it was taken AFTER the newest change in the memory dir — i.e.
 * it actually contains the bytes we are about to modify. A backup from before the
 * operator's last edit does not protect that edit.
 */
export function hasFreshBackup(memoryDir: string, home: string = homedir()): boolean {
  const backups = listBackups(home);
  if (backups.length === 0) return false;
  const newestChange = newestMtimeMs(memoryDir);
  return backups[0].createdMs >= newestChange;
}

/**
 * Copy every file in the memory dir into `~/.massu/memory-backups/<iso>/`.
 * Flat by construction — the memory dir is flat.
 *
 * THROWS on failure. The renderer's contract: cannot back up ⇒ REFUSE TO RENDER.
 */
export function takeBackup(
  memoryDir: string,
  nowMs: number,
  home: string = homedir(),
  retention: number = DEFAULT_RETENTION
): BackupInfo {
  if (!existsSync(memoryDir)) {
    throw new BackupError(`memory directory does not exist: ${memoryDir}`);
  }

  const stamp = backupStamp(nowMs);
  const dir = join(backupsRoot(home), stamp);

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(memoryDir)) {
      const srcPath = join(memoryDir, entry);
      try {
        if (!statSync(srcPath).isFile()) continue;
      } catch {
        continue;
      }
      // Copy EVERYTHING, not just *.md — the tombstone ledger is part of the corpus's
      // meaning, and a restore that loses it un-deletes every deleted memory.
      copyFileSync(srcPath, join(dir, entry));
    }
  } catch (err) {
    throw new BackupError(`backup failed: ${(err as Error).message}`);
  }

  pruneBackups(home, retention);
  return { stamp, dir, createdMs: nowMs };
}

/** Bounded retention. Keep the newest `retention`; delete the rest. */
export function pruneBackups(home: string = homedir(), retention: number = DEFAULT_RETENTION): void {
  const backups = listBackups(home);
  for (const stale of backups.slice(Math.max(retention, 1))) {
    try {
      rmSync(stale.dir, { recursive: true, force: true });
    } catch {
      /* a backup we cannot prune is not a reason to fail a render */
    }
  }
}

/** sha256 of every file in a directory, for byte-identity assertions. */
export function corpusHashes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    try {
      if (!statSync(p).isFile()) continue;
      out.set(entry, createHash('sha256').update(readFileSync(p)).digest('hex'));
    } catch {
      continue;
    }
  }
  return out;
}

export interface RestoreResult {
  stamp: string;
  filesRestored: number;
  dryRun: boolean;
}

/**
 * Restore the memory dir from a backup.
 *
 * `--dry-run` writes ZERO bytes and reports what it would do. This is the path the
 * operator reaches for when something has gone wrong, so it must be inspectable before
 * it is destructive.
 *
 * Restores files FROM the backup; does not delete files that exist now but not in the
 * backup (that would make `restore` itself a deletion primitive, and Massu does not get
 * one). The operator can delete those himself, and the printed list tells him which.
 */
export function restoreBackup(
  memoryDir: string,
  opts: { from?: string; dryRun?: boolean; home?: string } = {}
): RestoreResult & { wouldRestore: string[]; presentButNotInBackup: string[] } {
  const home = opts.home ?? homedir();
  const backups = listBackups(home);
  if (backups.length === 0) throw new BackupError('no backups exist');

  const chosen = opts.from ? backups.find((b) => b.stamp === opts.from) : backups[0];
  if (!chosen) throw new BackupError(`no backup with stamp: ${opts.from}`);

  const wouldRestore: string[] = [];
  for (const entry of readdirSync(chosen.dir)) {
    try {
      if (statSync(join(chosen.dir, entry)).isFile()) wouldRestore.push(entry);
    } catch {
      continue;
    }
  }

  const currentFiles = existsSync(memoryDir)
    ? readdirSync(memoryDir).filter((e) => {
        try {
          return statSync(join(memoryDir, e)).isFile();
        } catch {
          return false;
        }
      })
    : [];
  const presentButNotInBackup = currentFiles.filter((f) => !wouldRestore.includes(f));

  if (opts.dryRun) {
    return {
      stamp: chosen.stamp,
      filesRestored: 0,
      dryRun: true,
      wouldRestore,
      presentButNotInBackup,
    };
  }

  mkdirSync(memoryDir, { recursive: true });
  let n = 0;
  for (const entry of wouldRestore) {
    copyFileSync(join(chosen.dir, entry), join(memoryDir, entry));
    n++;
  }

  return {
    stamp: chosen.stamp,
    filesRestored: n,
    dryRun: false,
    wouldRestore,
    presentButNotInBackup,
  };
}

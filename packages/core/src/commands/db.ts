/**
 * `massu db` — backup / list / restore every SQLite store Massu owns.
 *
 * WHY (incident 2026-07-13): adding one table corrupted the live 135 MB memory.db. It
 * was recovered only because a snapshot happened to exist, taken by luck. This is the
 * command that makes recovery a CONTROL instead of a coincidence.
 *
 * The automatic pre-DDL backup (memory-db.ts) covers the schema-change case. This CLI
 * covers everything else: taking a snapshot on demand, seeing what you have, and — the
 * part that actually matters — GETTING YOUR DATA BACK.
 */

import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import {
  backupDb,
  listDbBackups,
  restoreDb,
  DbBackupError,
  projectBackupDir,
  DEFAULT_RETENTION,
} from '../db-backup.ts';
import { getProjectRoot, getResolvedPaths } from '../config.ts';

export interface CliResult {
  exitCode: number;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Every store Massu owns. A backup that covers only some of them is not a backup. */
function allStores(): Array<{ name: string; path: string }> {
  const p = getResolvedPaths();
  return [
    { name: 'memory', path: p.memoryDbPath },
    { name: 'knowledge', path: p.knowledgeDbPath },
    { name: 'data', path: p.dataDbPath },
    { name: 'codegraph', path: p.codegraphDbPath },
  ];
}

function usage(): void {
  process.stdout.write(
    `massu db — backup and restore Massu's databases\n\n` +
      `  massu db backup            snapshot every store (verified, keeps last ${DEFAULT_RETENTION})\n` +
      `  massu db list              show the snapshots you have\n` +
      `  massu db restore <file>    restore a database from a snapshot\n` +
      `  massu db restore --latest <store>   restore a store from its newest snapshot\n\n` +
      `Snapshots live OUTSIDE your repo, at ~/.massu/db-backups/<project>/,\n` +
      `so they can never be committed, pushed, or wiped by a git clean.\n`,
  );
}

export async function handleDbSubcommand(args: string[]): Promise<CliResult> {
  const sub = args[0];
  const root = getProjectRoot();

  if (!sub || sub === '--help' || sub === '-h') {
    usage();
    return { exitCode: sub ? 0 : 1 };
  }

  // ---- backup ----
  if (sub === 'backup') {
    let failed = 0;
    let taken = 0;
    process.stdout.write(`Backing up Massu's databases (${basename(root)})\n\n`);
    for (const store of allStores()) {
      if (!existsSync(store.path)) {
        process.stdout.write(`  ${'—'} ${store.name.padEnd(10)} not present, skipped\n`);
        continue;
      }
      try {
        const info = backupDb(root, store.path);
        taken++;
        process.stdout.write(
          `  ✓ ${store.name.padEnd(10)} ${human(info.bytes).padStart(9)}  ${basename(info.path)}\n`,
        );
      } catch (err) {
        failed++;
        // A failed backup is LOUD. A backup system that fails quietly is worse than
        // none, because you will believe you are protected.
        process.stderr.write(
          `  ✗ ${store.name.padEnd(10)} FAILED: ${err instanceof DbBackupError ? err.message : String(err)}\n`,
        );
      }
    }
    process.stdout.write(
      `\n${taken} snapshot(s) written to ${projectBackupDir(root)}\n` +
        (failed ? `${failed} FAILED — see above.\n` : `Every snapshot passed its own integrity check.\n`),
    );
    return { exitCode: failed > 0 ? 1 : 0 };
  }

  // ---- list ----
  if (sub === 'list') {
    const backups = listDbBackups(root);
    if (backups.length === 0) {
      process.stdout.write(
        `No snapshots yet.\n\nRun:  massu db backup\n` +
          `(Massu also snapshots automatically before it changes a database's schema.)\n`,
      );
      return { exitCode: 0 };
    }
    process.stdout.write(`Snapshots in ${projectBackupDir(root)}:\n\n`);
    for (const b of backups) {
      const age = Date.now() - b.mtimeMs;
      const hrs = age / 3_600_000;
      const when = hrs < 1 ? `${Math.round(age / 60_000)}m ago` : hrs < 48 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`;
      process.stdout.write(
        `  ${b.db.padEnd(11)} ${human(b.bytes).padStart(9)}  ${when.padStart(9)}  ${basename(b.path)}\n`,
      );
    }
    process.stdout.write(`\nRestore with:  massu db restore --latest memory\n`);
    return { exitCode: 0 };
  }

  // ---- restore ----
  if (sub === 'restore') {
    let backupPath: string | undefined;
    let target: string | undefined;

    if (args[1] === '--latest') {
      const store = args[2];
      if (!store) {
        process.stderr.write(`massu db restore --latest <store>   (memory | knowledge | data | codegraph)\n`);
        return { exitCode: 1 };
      }
      const found = allStores().find((s) => s.name === store);
      if (!found) {
        process.stderr.write(`Unknown store "${store}". Known: ${allStores().map((s) => s.name).join(', ')}\n`);
        return { exitCode: 1 };
      }
      const newest = listDbBackups(root).filter((b) => b.db === basename(found.path, '.db'))[0];
      if (!newest) {
        process.stderr.write(`No snapshot found for "${store}". Run: massu db backup\n`);
        return { exitCode: 1 };
      }
      backupPath = newest.path;
      target = found.path;
    } else {
      backupPath = args[1];
      if (!backupPath) {
        usage();
        return { exitCode: 1 };
      }
      // Infer the target store from the snapshot's filename.
      const dbName = basename(backupPath).replace(/-\d{4}-\d{2}-\d{2}T.*$/, '');
      const found = allStores().find((s) => basename(s.path, '.db') === dbName);
      if (!found) {
        process.stderr.write(`Cannot tell which database "${basename(backupPath)}" belongs to.\n`);
        return { exitCode: 1 };
      }
      target = found.path;
    }

    try {
      const before = existsSync(target) ? statSync(target).size : 0;
      const res = restoreDb(backupPath, target);
      process.stdout.write(
        `Restored ${basename(target)}\n` +
          `  from : ${res.restoredFrom}\n` +
          `  size : ${human(before)} -> ${human(statSync(target).size)}\n` +
          (res.preservedOriginal
            ? `  the previous file was NOT destroyed — kept at:\n    ${res.preservedOriginal}\n`
            : '') +
          `  integrity_check: ok (verified before AND after the restore)\n`,
      );
      return { exitCode: 0 };
    } catch (err) {
      process.stderr.write(
        `RESTORE FAILED: ${err instanceof DbBackupError ? err.message : String(err)}\n`,
      );
      return { exitCode: 1 };
    }
  }

  process.stderr.write(`Unknown subcommand "${sub}".\n\n`);
  usage();
  return { exitCode: 1 };
}

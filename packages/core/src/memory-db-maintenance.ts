// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Memory database maintenance — plan 2026-07-23 P8-007.
//
// ONE implementation of the one-time repair of an existing massu database, called by
// `massu doctor --fix` (P8-008) and by the operator script
// `scripts/ops/convert-memory-db-to-incremental.sh`. It:
//   - holds the file EXCLUSIVELY for the whole run (checked through SQLite itself, no lsof);
//   - refuses unless free disk covers the measured peak;
//   - takes a verified backup, which massu never deletes;
//   - merges duplicate session_summaries rows into one per session (P8-009), losing no value;
//   - converts to auto_vacuum=INCREMENTAL with a VACUUM, which also returns the freed space;
//   - ASSERTS the end state and names any mismatch and the backup.
//
// inspectMemoryDb is read-only and is what `massu doctor` reports.
// ============================================================

import { existsSync, statSync, statfsSync } from 'fs';
import { dirname } from 'path';
import { openDatabase, type MassuDatabase } from './db-driver.ts';
import {
  SUMMARY_VALUE_COLUMNS,
  mergeSummaryRows,
  type SummaryRowValues,
} from './memory-db.ts';

/**
 * Free disk the repair needs, as a multiple of the database's DATA (live pages), not its
 * file size. The backup, VACUUM's temporary copy and the rollback journal are each about
 * the data's size. Measured 2026-11-25 PST on a synthetic 657 MB file holding 164 MB of
 * data, in this module's exact step order, sampling free space every 50 ms: 2.63x, 3.03x,
 * 3.92x. The spread is other work on the same disk (the sampler cannot attribute writes),
 * so the multiple is at or above the largest reading. Re-measuring with exclusive use of
 * the disk is an open item in the plan's CLAIM LEDGER.
 */
export const REPAIR_PEAK_DATA_MULTIPLE = 4;

export interface MemoryDbInspection {
  path: string;
  autoVacuum: number;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  freelist: number;
  fileBytes: number;
  dataBytes: number;
  /** Bytes a repair would return to the disk (free pages). */
  reclaimableBytes: number;
  /** Rows beyond the first for each session; null when the file has no session_summaries. */
  duplicateSummaryRows: number | null;
  /** True when a repair would change something. */
  needsRepair: boolean;
}

const one = (db: MassuDatabase, sql: string): unknown => {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
};

const hasTable = (db: MassuDatabase, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function readState(db: MassuDatabase) {
  const pageSize = Number(one(db, 'PRAGMA page_size'));
  const pageCount = Number(one(db, 'PRAGMA page_count'));
  const freelist = Number(one(db, 'PRAGMA freelist_count'));
  const autoVacuum = Number(one(db, 'PRAGMA auto_vacuum'));
  for (const [k, v] of Object.entries({ pageSize, pageCount, freelist, autoVacuum })) {
    if (!Number.isFinite(v)) throw new Error(`unreadable database state: ${k}=${String(v)}`);
  }
  const duplicateSummaryRows = hasTable(db, 'session_summaries')
    ? Number(one(db, 'SELECT COUNT(*) - COUNT(DISTINCT session_id) FROM session_summaries'))
    : null;
  return { pageSize, pageCount, freelist, autoVacuum, duplicateSummaryRows };
}

/** Read-only report of one database. Throws if the file is missing or unreadable. */
export function inspectMemoryDb(path: string): MemoryDbInspection {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
  const db = openDatabase(path, { readonly: true });
  try {
    const s = readState(db);
    const journalMode = String(one(db, 'PRAGMA journal_mode'));
    const dataBytes = (s.pageCount - s.freelist) * s.pageSize;
    return {
      path,
      autoVacuum: s.autoVacuum,
      journalMode,
      pageSize: s.pageSize,
      pageCount: s.pageCount,
      freelist: s.freelist,
      fileBytes: statSync(path).size,
      dataBytes,
      reclaimableBytes: s.freelist * s.pageSize,
      duplicateSummaryRows: s.duplicateSummaryRows,
      needsRepair: s.autoVacuum !== 2 || s.freelist > 0 || (s.duplicateSummaryRows ?? 0) > 0,
    };
  } finally {
    db.close();
  }
}

export type RepairStatus = 'no-op' | 'dry-run' | 'repaired' | 'refused' | 'failed';

export interface RepairResult {
  status: RepairStatus;
  /** 0 for no-op / dry-run / repaired, 1 for refused or failed. */
  exitCode: 0 | 1;
  lines: string[];
  backupPath?: string;
  sizeBefore?: number;
  sizeAfter?: number;
}

export interface RepairOptions {
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
  /** Free bytes on the volume holding `dir`. Injected so tests never fake it through the environment. */
  availableBytes?: (dir: string) => number;
  now?: Date;
  /** TEST SEAM: runs after the VACUUM, before the end-state proof, so tests can show the proof FIRES. */
  afterConvertForTest?: (db: MassuDatabase) => void;
}

function defaultAvailableBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tableCounts(db: MassuDatabase): Record<string, number> {
  const names = db
    // eslint-disable-next-line massu/no-unbounded-sql-all -- the repair proves the WHOLE file; a cap would truncate the proof silently
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return Object.fromEntries(
    names.map(({ name }) => [name, Number(one(db, `SELECT COUNT(*) FROM "${name.replace(/"/g, '""')}"`))]),
  );
}

type FullRow = SummaryRowValues & { id: number; session_id: string };
const ALL_SUMMARY_COLUMNS = [...SUMMARY_VALUE_COLUMNS, 'plan_progress'] as const;

/** Per session: what the ONE kept row must hold — every row merged oldest to newest. */
function expectedSummaries(db: MassuDatabase): Map<string, SummaryRowValues> {
  const out = new Map<string, SummaryRowValues>();
  // eslint-disable-next-line massu/no-unbounded-sql-all -- the repair proves the WHOLE file; a cap would truncate the proof silently
  const sessions = db.prepare('SELECT DISTINCT session_id FROM session_summaries').all() as Array<{ session_id: string }>;
  // eslint-disable-next-line massu/no-unbounded-sql-all -- the repair proves the WHOLE file; a cap would truncate the proof silently
  const rowsOf = db.prepare(
    'SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch ASC, id ASC',
  );
  for (const { session_id } of sessions) {
    const rows = rowsOf.all(session_id) as FullRow[];
    let acc: SummaryRowValues = pick(rows[0]);
    for (const r of rows.slice(1)) acc = mergeSummaryRows(acc, pick(r));
    out.set(session_id, acc);
  }
  return out;
}

function pick(r: FullRow): SummaryRowValues {
  return Object.fromEntries(ALL_SUMMARY_COLUMNS.map((c) => [c, r[c] ?? null])) as SummaryRowValues;
}

/** Fold each session's rows into its newest row and delete the rest. Returns rows deleted. */
function mergeDuplicateSummaries(db: MassuDatabase, expected: Map<string, SummaryRowValues>): number {
  const dups = db
    // eslint-disable-next-line massu/no-unbounded-sql-all -- the repair proves the WHOLE file; a cap would truncate the proof silently
    .prepare('SELECT session_id FROM session_summaries GROUP BY session_id HAVING COUNT(*) > 1')
    .all() as Array<{ session_id: string }>;
  const newestId = db.prepare(
    'SELECT id FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC, id DESC LIMIT 1',
  );
  const update = db.prepare(
    `UPDATE session_summaries SET ${ALL_SUMMARY_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  const del = db.prepare('DELETE FROM session_summaries WHERE session_id = ? AND id != ?');
  let deleted = 0;
  db.transaction(() => {
    for (const { session_id } of dups) {
      const keep = (newestId.get(session_id) as { id: number }).id;
      const row = expected.get(session_id)!;
      update.run(...ALL_SUMMARY_COLUMNS.map((c) => row[c]), keep);
      deleted += Number(del.run(session_id, keep).changes);
    }
  })();
  return deleted;
}

/**
 * Repair one database. Never throws for an expected condition: every refusal and failure
 * is a RepairResult with exitCode 1 and a line naming the cause (and the backup, once one
 * exists). An unexpected exception is also returned as `failed`.
 */
export function repairMemoryDb(path: string, opts: RepairOptions = {}): RepairResult {
  const lines: string[] = [];
  const say = (l: string) => lines.push(l);
  const end = (status: RepairStatus, extra: Partial<RepairResult> = {}): RepairResult => ({
    status,
    exitCode: status === 'refused' || status === 'failed' ? 1 : 0,
    lines,
    ...extra,
  });

  if (!existsSync(path)) {
    say(`REFUSED: no database at ${path}`);
    return end('refused');
  }
  const before = inspectMemoryDb(path);
  say(
    `database : ${path}\n` +
      `state    : auto_vacuum=${before.autoVacuum}, journal=${before.journalMode}, ` +
      `${(before.fileBytes / 1e6).toFixed(0)} MB file, ${(before.dataBytes / 1e6).toFixed(0)} MB data, ` +
      `${(before.reclaimableBytes / 1e6).toFixed(0)} MB reclaimable, ` +
      `duplicate summary rows ${before.duplicateSummaryRows ?? 'n/a (no session_summaries table)'}`,
  );
  if (!before.needsRepair) {
    say('RESULT: nothing to do — already auto_vacuum=INCREMENTAL, no free pages, no duplicate summaries (no-op).');
    return end('no-op');
  }
  // A file already out of WAL gives NO signal about other connections (the switch below
  // succeeds whoever holds it), e.g. after an interrupted run. Refuse rather than guess.
  if (before.journalMode.toLowerCase() !== 'wal') {
    say(
      `REFUSED: journal mode is '${before.journalMode}', not 'wal', so this run cannot tell whether another ` +
        'process has the file open. Close every massu session for this project, open it once with massu ' +
        '(which restores WAL), then re-run.',
    );
    return end('refused');
  }

  const dir = dirname(path);
  const need = before.dataBytes * REPAIR_PEAK_DATA_MULTIPLE;
  const avail = (opts.availableBytes ?? defaultAvailableBytes)(dir);
  say(
    `disk     : ${(avail / 1e9).toFixed(1)} GB free; the repair needs up to ${(need / 1e6).toFixed(0)} MB ` +
      `(${REPAIR_PEAK_DATA_MULTIPLE}x the data) and ends with about ${(before.reclaimableBytes / 1e6).toFixed(0)} MB more free`,
  );
  // Operator ruling 2026-11-25: this run ends SMALLER, so the 25% disk floor does not
  // apply. Reaching the peak is the only risk, and that is what is checked.
  if (avail < need) {
    say(`REFUSED: ${(avail / 1e6).toFixed(0)} MB free is less than the ${(need / 1e6).toFixed(0)} MB the repair may need at its peak.`);
    return end('refused');
  }
  const backupPath = `${path}.pre-maintenance-${stamp(opts.now ?? new Date())}`;
  if (existsSync(backupPath)) {
    say(`REFUSED: backup path already exists: ${backupPath}`);
    return end('refused');
  }
  if (opts.dryRun) {
    say(`would    : hold the file exclusively, back up to ${backupPath}, merge duplicate summaries, VACUUM to auto_vacuum=INCREMENTAL`);
    say('RESULT: dry run — every check passed; nothing was written.');
    return end('dry-run');
  }

  const db = openDatabase(path);
  let leftWal = false;
  let backupMade: string | undefined;
  try {
    db.pragma('busy_timeout = 0');
    // ORDER IS LOAD-BEARING (probed 2026-11-25): EXCLUSIVE first, then leave WAL — which
    // SQLite refuses while any other connection has the file open — then an empty
    // exclusive transaction to TAKE the lock, held until close. Reversed, another process
    // could reopen the file in WAL in the gap and write.
    db.pragma('locking_mode = EXCLUSIVE');
    try {
      const jm = db.prepare('PRAGMA journal_mode = DELETE').get() as Record<string, unknown> | undefined;
      const mode = jm ? String(Object.values(jm)[0]) : '';
      if (mode.toLowerCase() !== 'delete') {
        say(`FAIL: could not leave WAL (journal_mode returned '${mode}'); nothing was changed.`);
        return end('failed');
      }
      leftWal = true;
      db.exec('BEGIN EXCLUSIVE; COMMIT;');
    } catch (e) {
      if (/locked|busy/i.test(String((e as Error)?.message))) {
        say(
          'REFUSED: another process has this database open (SQLite: database is locked). ' +
            'Close every massu session for this project (the MCP server and hooks run inside them), then re-run.',
        );
        return end('refused');
      }
      throw e;
    }
    say('holders  : none — this run now holds the file exclusively');

    const countsBefore = tableCounts(db);
    const hasSummaries = hasTable(db, 'session_summaries');
    const expected = hasSummaries ? expectedSummaries(db) : new Map<string, SummaryRowValues>();

    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    backupMade = backupPath;
    const b = openDatabase(backupPath, { readonly: true });
    try {
      const ok = String(one(b, 'PRAGMA integrity_check'));
      if (ok !== 'ok') {
        say(`FAIL: backup integrity_check: ${ok}. The live database was not changed.`);
        return end('failed', { backupPath });
      }
      if (JSON.stringify(tableCounts(b)) !== JSON.stringify(countsBefore)) {
        say('FAIL: backup row counts differ from the live database. The live database was not changed.');
        return end('failed', { backupPath });
      }
    } finally {
      b.close();
    }
    say(`backup   : ${backupPath} (${(statSync(backupPath).size / 1e6).toFixed(0)} MB, integrity ok, ${Object.keys(countsBefore).length} tables match) — massu never deletes it`);

    const deleted = hasSummaries ? mergeDuplicateSummaries(db, expected) : 0;
    if (hasSummaries) say(`summaries: ${deleted} duplicate row(s) merged into ${expected.size} session row(s)`);

    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    opts.afterConvertForTest?.(db);

    // ---- the end state, asserted ----
    const s = readState(db);
    const ok = String(one(db, 'PRAGMA integrity_check'));
    const countsAfter = tableCounts(db);
    const problems: string[] = [];
    if (s.autoVacuum !== 2) problems.push(`auto_vacuum is ${s.autoVacuum}, expected 2`);
    if (ok !== 'ok') problems.push(`integrity_check: ${ok}`);
    if (s.freelist !== 0) problems.push(`freelist_count is ${s.freelist}, expected 0`);
    for (const t of Object.keys({ ...countsBefore, ...countsAfter })) {
      const want = t === 'session_summaries' ? expected.size : countsBefore[t];
      if (countsAfter[t] !== want) problems.push(`${t}: ${countsBefore[t]} rows before, ${countsAfter[t]} after, expected ${want}`);
    }
    if (hasSummaries) {
      const kept = db.prepare('SELECT * FROM session_summaries WHERE session_id = ?');
      for (const [sid, want] of expected) {
        const got = kept.get(sid) as FullRow | undefined;
        const bad = got ? ALL_SUMMARY_COLUMNS.filter((c) => (got[c] ?? null) !== want[c]) : ['<row missing>'];
        if (bad.length) problems.push(`session ${sid}: ${bad.join(', ')} differ from the merge of its rows`);
        if (problems.length > 20) break;
      }
    }
    if (problems.length) {
      say(`FAIL: the end state is wrong — restore from ${backupPath}:`);
      for (const p of problems.slice(0, 20)) say(`  - ${p}`);
      return end('failed', { backupPath });
    }
    const totalTables = Object.keys(countsAfter).length;
    say(
      `repaired : auto_vacuum=2, integrity ok, freelist 0, ${totalTables} tables checked` +
        (hasSummaries ? `, ${expected.size} sessions each match the merge of their rows` : ''),
    );
    const sizeAfter = statSync(path).size;
    say(`size     : ${(before.fileBytes / 1e6).toFixed(0)} MB -> ${(sizeAfter / 1e6).toFixed(0)} MB`);
    say(`RESULT: repaired. The backup is kept: ${backupPath}`);
    return end('repaired', { backupPath, sizeBefore: before.fileBytes, sizeAfter });
  } catch (e) {
    say(`FAIL: ${(e as Error)?.message ?? String(e)}${backupMade ? ` — restore from ${backupMade}` : ' — nothing was changed'}`);
    return end('failed', backupMade ? { backupPath: backupMade } : {});
  } finally {
    if (leftWal) {
      try {
        db.prepare('PRAGMA journal_mode = WAL').get();
      } catch (e) {
        say(`FAIL: could not restore journal_mode=WAL: ${(e as Error)?.message}. Opening the file with massu restores it.`);
      }
    }
    db.close();
  }
}

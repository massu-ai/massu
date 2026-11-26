// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-07-23 P8-007 — the ONE memory-database repair (doctor --fix, `massu memory
 * repair`, and the operator script all call it). Carries every case the bash script's test
 * had, re-pointed at the module, plus the summaries merge and the holder check through
 * SQLite itself. Runs on both engines.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';

const paths = vi.hoisted(() => ({ memoryDbPath: '', dataDbPath: '', knowledgeDbPath: '' }));
vi.mock('../config.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.ts')>();
  return { ...real, getResolvedPaths: () => ({ ...real.getResolvedPaths(), ...paths }) };
});

import { openDatabase } from '../db-driver.ts';
import { legacyMemoryStore } from './helpers/legacy-memory-store.ts';
import { inspectMemoryDb, repairMemoryDb, REPAIR_PEAK_DATA_MULTIPLE } from '../memory-db-maintenance.ts';

const roots: string[] = [];
afterEach(() => {
  delete process.env.MASSU_DB_ENGINE;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const PLENTY = () => 1e15;

function legacyStore(): string {
  return legacyMemoryStore(roots, (p) => { paths.memoryDbPath = p; });
}

/** Another process holding an idle connection — the shape of a live massu MCP server. */
// Windows refuses to delete a file another process still has open, so release() must WAIT for the
// holder to exit: a kill that returns at once leaves afterEach's rmSync racing the dying child (EBUSY).
async function holdOpen(path: string): Promise<() => Promise<void>> {
  const child = spawn(
    process.execPath,
    ['--no-warnings', '-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(path)});d.prepare('SELECT 1').get();process.stdout.write('ready\\n');setInterval(()=>{},1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((res, rej) => {
    child.stdout!.on('data', (b) => String(b).includes('ready') && res());
    child.on('exit', (c) => rej(new Error(`holder exited ${c}`)));
  });
  return () =>
    new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) return res();
      child.removeAllListeners('exit');
      child.once('exit', () => res());
      child.kill('SIGKILL');
    });
}

for (const engine of ['node-sqlite', 'better-sqlite3'] as const) {
  describe(`memory-db-maintenance [${engine}]`, () => {
    const setEngine = () => {
      if (engine === 'better-sqlite3') process.env.MASSU_DB_ENGINE = 'better-sqlite3';
      else delete process.env.MASSU_DB_ENGINE;
    };

    it('inspect is read-only and reports what a repair would change', () => {
      setEngine();
      const path = legacyStore();
      const h = sha(path);
      const r = inspectMemoryDb(path);
      expect(sha(path)).toBe(h);
      expect(r.autoVacuum).toBe(0);
      expect(r.journalMode).toBe('wal');
      expect(r.freelist).toBeGreaterThan(0);
      expect(r.duplicateSummaryRows).toBe(2);
      expect(r.needsRepair).toBe(true);
    });

    it('dry run checks everything and writes NOTHING', () => {
      setEngine();
      const path = legacyStore();
      const h = sha(path);
      const r = repairMemoryDb(path, { dryRun: true, availableBytes: PLENTY });
      expect(r.status).toBe('dry-run');
      expect(r.exitCode).toBe(0);
      expect(sha(path)).toBe(h);
      expect(readdirSync(join(path, '..')).filter((f) => f.includes('pre-maintenance'))).toEqual([]);
    });

    it('repairs: mode 2, freelist 0, rows kept, one summary per session with nothing lost, valid backup kept', () => {
      setEngine();
      const path = legacyStore();
      const r = repairMemoryDb(path, { availableBytes: PLENTY });
      expect(r.status, r.lines.join('\n')).toBe('repaired');
      expect(r.sizeAfter!).toBeLessThan(r.sizeBefore!);
      expect(existsSync(r.backupPath!)).toBe(true);

      const after = inspectMemoryDb(path);
      expect(after.autoVacuum).toBe(2);
      expect(after.freelist).toBe(0);
      expect(after.journalMode).toBe('wal'); // restored
      expect(after.duplicateSummaryRows).toBe(0);
      expect(after.needsRepair).toBe(false);

      const db = openDatabase(path, { readonly: true });
      try {
        const s1 = db.prepare("SELECT * FROM session_summaries WHERE session_id = 's1'").all() as Array<Record<string, string>>;
        expect(s1).toHaveLength(1);
        expect(s1[0].request).toBe('third'); // newest by (epoch, id)
        expect(s1[0].next_steps).toBe('keep these next steps'); // not blanked by later empty values
        expect(JSON.parse(s1[0].plan_progress)).toEqual({ A: 'complete', B: 'in_progress', snapshot_type: 'pre_compact' });
        expect((db.prepare("SELECT request FROM session_summaries WHERE session_id = 's2'").get() as { request: string }).request).toBe('only');
        expect(Number((db.prepare('SELECT COUNT(*) AS n FROM legacy_seed').get() as { n: number }).n)).toBe(1000);
      } finally {
        db.close();
      }
      // the backup is the database as it was: still 4 summary rows, still mode 0
      const b = inspectMemoryDb(r.backupPath!);
      expect(b.duplicateSummaryRows).toBe(2);
    });

    it('a repair whose end state is wrong FAILS and names the table and the backup (the proof fires)', () => {
      setEngine();
      const path = legacyStore();
      const r = repairMemoryDb(path, {
        availableBytes: PLENTY,
        afterConvertForTest: (db) => db.exec('DELETE FROM legacy_seed WHERE rowid = (SELECT max(rowid) FROM legacy_seed)'),
      });
      expect(r.status).toBe('failed');
      expect(r.exitCode).toBe(1);
      const text = r.lines.join('\n');
      expect(text).toContain('legacy_seed: 1000 rows before, 999 after');
      expect(text).toContain(r.backupPath!);
    });

    it('a repair that altered a merged summary FAILS and names the session', () => {
      setEngine();
      const path = legacyStore();
      const r = repairMemoryDb(path, {
        availableBytes: PLENTY,
        afterConvertForTest: (db) => db.exec("UPDATE session_summaries SET next_steps = NULL WHERE session_id = 's1'"),
      });
      expect(r.status).toBe('failed');
      expect(r.lines.join('\n')).toContain('session s1: next_steps differ');
    });

    it('is idempotent: a repaired database is a reported no-op that changes nothing', () => {
      setEngine();
      const path = legacyStore();
      expect(repairMemoryDb(path, { availableBytes: PLENTY }).status).toBe('repaired');
      const h = sha(path);
      const r = repairMemoryDb(path, { availableBytes: PLENTY });
      expect(r.status).toBe('no-op');
      expect(r.exitCode).toBe(0);
      expect(sha(path)).toBe(h);
    });

    it('refuses while another process has the database open, and changes nothing', async () => {
      setEngine();
      const path = legacyStore();
      const release = await holdOpen(path);
      try {
        const before = inspectMemoryDb(path);
        const r = repairMemoryDb(path, { availableBytes: PLENTY });
        expect(r.status, r.lines.join('\n')).toBe('refused');
        expect(r.lines.join('\n')).toContain('another process has this database open');
        const after = inspectMemoryDb(path);
        expect(after.autoVacuum).toBe(before.autoVacuum);
        expect(after.duplicateSummaryRows).toBe(2);
        expect(after.journalMode).toBe('wal');
        expect(readdirSync(join(path, '..')).filter((f) => f.includes('pre-maintenance'))).toEqual([]);
      } finally {
        await release();
      }
    });

    it('refuses when free disk is below the peak, and writes nothing', () => {
      setEngine();
      const path = legacyStore();
      const h = sha(path);
      const need = inspectMemoryDb(path).dataBytes * REPAIR_PEAK_DATA_MULTIPLE;
      const r = repairMemoryDb(path, { availableBytes: () => need - 1 });
      expect(r.status).toBe('refused');
      expect(r.lines.join('\n')).toContain('less than');
      expect(sha(path)).toBe(h);
    });

    it('does NOT apply the 25% disk floor: exactly the peak free is enough (operator ruling 2026-11-25)', () => {
      setEngine();
      const path = legacyStore();
      const need = inspectMemoryDb(path).dataBytes * REPAIR_PEAK_DATA_MULTIPLE;
      expect(repairMemoryDb(path, { availableBytes: () => need }).status).toBe('repaired');
    });

    it('refuses a file that is not in WAL mode (no holder signal), and a missing file', () => {
      setEngine();
      const path = legacyStore();
      const db = openDatabase(path);
      db.prepare('PRAGMA journal_mode = DELETE').get();
      db.close();
      const r = repairMemoryDb(path, { availableBytes: PLENTY });
      expect(r.status).toBe('refused');
      expect(r.lines.join('\n')).toContain("not 'wal'");
      expect(repairMemoryDb(join(path, '..', 'absent.db')).status).toBe('refused');
    });
  });
}

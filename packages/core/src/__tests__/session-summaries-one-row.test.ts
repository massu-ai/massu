// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-07-23 P8-009 — session_summaries keeps ONE row per session, and no write ever
 * loses a plan status or blanks a filled column. Incident 2026-11-21: every write INSERTed a
 * full snapshot (one store reached 431 MB), and a later partial snapshot could hide an earlier `complete`.
 * Runs on both engines.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const paths = vi.hoisted(() => ({ memoryDbPath: '', dataDbPath: '', knowledgeDbPath: '' }));
vi.mock('../config.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.ts')>();
  return { ...real, getResolvedPaths: () => ({ ...real.getResolvedPaths(), ...paths }) };
});

import { openDatabase } from '../db-driver.ts';
import {
  getMemoryDb,
  createSession,
  addSummary,
  getSessionSummaries,
  getCrossTaskProgress,
  linkSessionToTask,
  getLatestSummaryRow,
  mergePlanProgress,
  mergeSummaryRows,
  isEmptySummaryValue,
  SUMMARY_VALUE_COLUMNS,
  type SummaryRowValues,
} from '../memory-db.ts';

const roots: string[] = [];
afterEach(() => {
  delete process.env.MASSU_DB_ENGINE;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function freshDb() {
  const d = mkdtempSync(join(tmpdir(), 'massu-summaries-'));
  roots.push(d);
  paths.memoryDbPath = join(d, 'memory.db');
  return getMemoryDb();
}

const rowCount = (db: ReturnType<typeof getMemoryDb>, sid: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE session_id = ?').get(sid) as { n: number }).n;

/** Deterministic PRNG so a failing sequence is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

for (const engine of ['node-sqlite', 'better-sqlite3'] as const) {
  describe(`session_summaries one row per session [${engine}]`, () => {
    const setEngine = () => {
      if (engine === 'better-sqlite3') process.env.MASSU_DB_ENGINE = 'better-sqlite3';
      else delete process.env.MASSU_DB_ENGINE;
    };

    it('N writes for one session leave exactly one row', () => {
      setEngine();
      const db = freshDb();
      try {
        createSession(db, 's1');
        for (let i = 0; i < 25; i++) addSummary(db, 's1', { request: `turn ${i}`, completed: `done ${i}` });
        expect(rowCount(db, 's1')).toBe(1);
        expect(getLatestSummaryRow(db, 's1')?.request).toBe('turn 24');
      } finally {
        db.close();
      }
    });

    it('a later in_progress snapshot never hides an earlier complete', () => {
      setEngine();
      const db = freshDb();
      try {
        createSession(db, 's1');
        addSummary(db, 's1', { planProgress: { 'P1-001': 'complete' } });
        addSummary(db, 's1', { planProgress: { 'P1-001': 'in_progress', 'P1-002': 'in_progress', snapshot_type: 'pre_compact' } });
        const pp = JSON.parse(getLatestSummaryRow(db, 's1')!.plan_progress!);
        expect(pp).toEqual({ 'P1-001': 'complete', 'P1-002': 'in_progress', snapshot_type: 'pre_compact' });
      } finally {
        db.close();
      }
    });

    it('a backfill-shaped partial write blanks no filled column', () => {
      setEngine();
      const db = freshDb();
      try {
        createSession(db, 's1');
        addSummary(db, 's1', {
          request: 'r', investigated: 'i', decisions: 'd', completed: 'c', failedAttempts: 'f', nextSteps: 'n',
          filesCreated: ['a.ts'], filesModified: ['b.ts'], verificationResults: { tests: 'pass' },
          planProgress: { X: 'complete' },
        });
        // backfill-sessions.ts:154 writes three text columns and empty arrays/objects for the rest
        addSummary(db, 's1', { request: 'r2', completed: 'c2', decisions: 'd2' });
        const row = getLatestSummaryRow(db, 's1')!;
        expect(row.request).toBe('r2');
        expect(row.completed).toBe('c2');
        expect(row.investigated).toBe('i');
        expect(row.failed_attempts).toBe('f');
        expect(row.next_steps).toBe('n');
        expect(JSON.parse(row.files_created!)).toEqual(['a.ts']);
        expect(JSON.parse(row.files_modified!)).toEqual(['b.ts']);
        expect(JSON.parse(row.verification_results!)).toEqual({ tests: 'pass' });
        expect(JSON.parse(row.plan_progress!)).toEqual({ X: 'complete' });
      } finally {
        db.close();
      }
    });

    it('two rows in the same second: the higher id is newest, and writes merge into it', () => {
      setEngine();
      const db = freshDb();
      try {
        createSession(db, 's1');
        // Two legacy rows (an old INSERT-only version) with the SAME epoch.
        const ins = db.prepare(
          "INSERT INTO session_summaries (session_id, request, next_steps, plan_progress, created_at, created_at_epoch) VALUES ('s1', ?, ?, '{}', 'x', 1000)",
        );
        ins.run('older', 'keep me');
        ins.run('newer', null);
        expect(getLatestSummaryRow(db, 's1')?.request).toBe('newer');
        addSummary(db, 's1', { completed: 'c' });
        expect(rowCount(db, 's1')).toBe(2); // the writer merges; only doctor --fix deletes duplicates
        const newest = getLatestSummaryRow(db, 's1')!;
        expect(newest.request).toBe('newer');
        expect(newest.completed).toBe('c');
      } finally {
        db.close();
      }
    });

    it('getSessionSummaries returns each session once, newest first', () => {
      setEngine();
      const db = freshDb();
      try {
        createSession(db, 'a');
        createSession(db, 'b');
        const ins = db.prepare(
          "INSERT INTO session_summaries (session_id, request, plan_progress, created_at, created_at_epoch) VALUES (?, ?, '{}', 'x', ?)",
        );
        for (let i = 0; i < 5; i++) ins.run('a', `a${i}`, 100 + i);
        ins.run('b', 'b0', 50);
        const out = getSessionSummaries(db, 10);
        expect(out.map((r) => r.session_id)).toEqual(['a', 'b']);
        expect(out[0].request).toBe('a4');
      } finally {
        db.close();
      }
    });

    it('adapter .immediate() takes the write lock at BEGIN; plain (deferred) does not', () => {
      setEngine();
      const db = freshDb();
      const other = openDatabase(paths.memoryDbPath);
      try {
        other.pragma('busy_timeout = 0');
        const otherCanWrite = () => {
          try {
            other.exec('BEGIN IMMEDIATE');
            other.exec('ROLLBACK');
            return true;
          } catch {
            return false;
          }
        };
        let deferredSaw = false;
        let immediateSaw = true;
        db.transaction(() => { deferredSaw = otherCanWrite(); })();
        db.transaction(() => { immediateSaw = otherCanWrite(); }).immediate();
        expect(deferredSaw).toBe(true); // positive control: the probe can see a free lock
        expect(immediateSaw).toBe(false);
      } finally {
        other.close();
        db.close();
      }
    });

    it('getCrossTaskProgress does not depend on the order rows were read', () => {
      setEngine();
      const db = freshDb();
      try {
        createSession(db, 's1');
        linkSessionToTask(db, 's1', 'T');
        const ins = db.prepare(
          "INSERT INTO session_summaries (session_id, plan_progress, created_at, created_at_epoch) VALUES ('s1', ?, 'x', ?)",
        );
        ins.run(JSON.stringify({ snapshot_type: 'older-value', A: 'complete' }), 100);
        ins.run(JSON.stringify({ snapshot_type: 'pre_compact', A: 'in_progress' }), 200);
        expect(getCrossTaskProgress(db, 'T')).toEqual({ snapshot_type: 'pre_compact', A: 'complete' });
      } finally {
        db.close();
      }
    });
  });
}

describe('mergePlanProgress / mergeSummaryRows (pure)', () => {
  const STATUSES = ['complete', 'in_progress', 'pending', 'pre_compact', 'other'];
  const RANK: Record<string, number> = { complete: 3, in_progress: 2, pending: 1 };

  it('property: no status is ever lost and the best known status always survives (500 random sequences)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      let acc: Record<string, string> = {};
      const best: Record<string, number> = {};
      const seen = new Set<string>();
      const n = 1 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) {
        const write: Record<string, string> = {};
        const keys = 1 + Math.floor(r() * 4);
        for (let k = 0; k < keys; k++) {
          const key = `K${Math.floor(r() * 5)}`;
          const v = STATUSES[Math.floor(r() * STATUSES.length)];
          write[key] = v; // a key drawn twice keeps only its last value, as a real write would
        }
        for (const [key, v] of Object.entries(write)) {
          seen.add(key);
          best[key] = Math.max(best[key] ?? 0, RANK[v] ?? 0);
        }
        acc = mergePlanProgress(acc, write);
      }
      for (const key of seen) {
        expect(acc[key], `seed ${seed} key ${key}`).toBeDefined();
        expect(RANK[acc[key]] ?? 0, `seed ${seed} key ${key}`).toBe(best[key]);
      }
    }
  });

  it('known statuses beat other values in both directions; two other values: newer wins', () => {
    expect(mergePlanProgress({ k: 'complete' }, { k: 'pre_compact' })).toEqual({ k: 'complete' });
    expect(mergePlanProgress({ k: 'pre_compact' }, { k: 'pending' })).toEqual({ k: 'pending' });
    expect(mergePlanProgress({ k: 'a' }, { k: 'b' })).toEqual({ k: 'b' });
    expect(mergePlanProgress({ k: 'in_progress' }, { k: 'pending' })).toEqual({ k: 'in_progress' });
  });

  it('isEmptySummaryValue treats null, blank, [] and {} as empty and nothing else', () => {
    for (const v of [null, undefined, '', '  ', '[]', '{}']) expect(isEmptySummaryValue(v)).toBe(true);
    for (const v of ['0', 'x', '["a"]', '{"a":1}']) expect(isEmptySummaryValue(v)).toBe(false);
  });

  it('mergeSummaryRows covers every value column (a column added later cannot be silently dropped)', () => {
    const older = Object.fromEntries([...SUMMARY_VALUE_COLUMNS, 'plan_progress'].map((c) => [c, `old-${c}`])) as SummaryRowValues;
    older.plan_progress = '{"A":"complete"}';
    const empty = Object.fromEntries([...SUMMARY_VALUE_COLUMNS, 'plan_progress'].map((c) => [c, null])) as SummaryRowValues;
    const merged = mergeSummaryRows(older, empty);
    for (const c of SUMMARY_VALUE_COLUMNS) expect(merged[c], c).toBe(`old-${c}`);
    expect(JSON.parse(merged.plan_progress!)).toEqual({ A: 'complete' });
  });

  it('an unreadable plan_progress is kept verbatim, never replaced by an empty merge', () => {
    const base = Object.fromEntries([...SUMMARY_VALUE_COLUMNS].map((c) => [c, null]));
    const merged = mergeSummaryRows(
      { ...base, plan_progress: '{not json' } as SummaryRowValues,
      { ...base, plan_progress: '{}' } as SummaryRowValues,
    );
    expect(merged.plan_progress).toBe('{not json');
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * D-C (plan-memory-ingestion-decision-noise-fix): expire ingestion noise, never delete.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession } from '../memory-db.ts';
import { countNoise, sampleNoise, pruneNoiseObservations } from '../memory-prune-noise.ts';

let db: Database.Database;

function insertObs(row: {
  session: string;
  type: string;
  title: string;
  epoch: number;
  importance?: number;
}): number {
  const iso = new Date(row.epoch * 1000).toISOString();
  const r = db
    .prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, created_at, created_at_epoch, valid_from_epoch, ingested_at_epoch)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
    )
    .run(row.session, row.type, row.title, row.importance ?? 5, iso, row.epoch, row.epoch, row.epoch);
  return Number(r.lastInsertRowid);
}

function liveCount(): number {
  return (db.prepare(`SELECT COUNT(*) n FROM observations WHERE COALESCE(expired_at_epoch,0)=0`).get() as { n: number }).n;
}
function totalCount(): number {
  return (db.prepare(`SELECT COUNT(*) n FROM observations`).get() as { n: number }).n;
}

describe('memory-prune-noise (D-C)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    initMemorySchema(db);
    createSession(db, 's1');
  });
  afterEach(() => db.close());

  it('counts D-A and free-text decisions as noise but keeps a [memory-file] re-ingest', () => {
    insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: /**', epoch: 1000 });
    insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: ---', epoch: 1001 });
    // A bare free-text 'decision' observation (regex auto-extraction) — now noise: genuine
    // decisions are STRUCTURED architecture_decisions rows via massu_adr_create.
    insertObs({ session: 's1', type: 'decision', title: 'Now I am at the D-B decision point', epoch: 1002 });
    // A [memory-file] re-ingest of a hand-written memory is a CURATED memory — never noise.
    const keepId = insertObs({ session: 's1', type: 'decision', title: '[memory-file] native-loader', epoch: 1003 });

    const c = countNoise(db);
    expect(c.toolResponseDecision).toBe(2);
    expect(c.freeTextDecision).toBe(1);
    expect(c.sameInstantDuplicate).toBe(0);

    pruneNoiseObservations(db, { dryRun: false, now: 1 });
    const keepRow = db.prepare(`SELECT COALESCE(expired_at_epoch,0) e FROM observations WHERE id=?`).get(keepId) as { e: number };
    expect(keepRow.e).toBe(0); // the [memory-file] row stays live
  });

  it('counts same-instant duplicates, keeping the earliest id (which stays live after prune)', () => {
    const first = insertObs({ session: 's1', type: 'file_change', title: 'Edited: x.ts', epoch: 2000 });
    insertObs({ session: 's1', type: 'file_change', title: 'Edited: x.ts', epoch: 2000 });
    insertObs({ session: 's1', type: 'file_change', title: 'Edited: x.ts', epoch: 2000 });
    // same title but DIFFERENT epoch is NOT a same-instant duplicate
    insertObs({ session: 's1', type: 'file_change', title: 'Edited: x.ts', epoch: 2001 });

    expect(countNoise(db).sameInstantDuplicate).toBe(2); // 2 of the 3-group are dupes
    pruneNoiseObservations(db, { dryRun: false, now: 1 });
    const firstRow = db.prepare(`SELECT COALESCE(expired_at_epoch,0) e FROM observations WHERE id=?`).get(first) as { e: number };
    expect(firstRow.e).toBe(0); // earliest kept live
    // exactly one live row remains for the 3-group's (title,epoch)
    const liveGroup = (db.prepare(`SELECT COUNT(*) n FROM observations WHERE title='Edited: x.ts' AND created_at_epoch=2000 AND COALESCE(expired_at_epoch,0)=0`).get() as { n: number }).n;
    expect(liveGroup).toBe(1);
  });

  it('a row that is BOTH junk and a duplicate is counted once (no double count)', () => {
    insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: /**', epoch: 3000 });
    insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: /**', epoch: 3000 });
    const c = countNoise(db);
    // Mutually-exclusive classes: the 2nd row is D-A AND a duplicate, counted once (as D-A).
    expect(c.total).toBe(c.toolResponseDecision + c.freeTextDecision + c.sameInstantDuplicate);
    expect(c.toolResponseDecision).toBe(2);
    expect(c.sameInstantDuplicate).toBe(0);
  });

  it('dry-run counts but expires nothing', () => {
    insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: /**', epoch: 4000 });
    const before = liveCount();
    const res = pruneNoiseObservations(db, { dryRun: true });
    expect(res.counts.total).toBe(1);
    expect(res.expired).toBe(0);
    expect(liveCount()).toBe(before); // untouched
  });

  it('apply EXPIRES the noise (never deletes) and leaves curated memories live', () => {
    const junk = insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: ---', epoch: 5000 });
    const ftJunk = insertObs({ session: 's1', type: 'decision', title: 'We decided to ship R1 then R2', epoch: 5001 }); // free-text = noise
    const keepMemFile = insertObs({ session: 's1', type: 'decision', title: '[memory-file] r1-then-r2', epoch: 5002 }); // curated
    const keepLesson = insertObs({ session: 's1', type: 'failed_attempt', title: 'Do not rebuild --build-from-source', epoch: 5003 }); // not a decision at all
    const total0 = totalCount();

    const res = pruneNoiseObservations(db, { dryRun: false, now: 9999 });
    expect(res.expired).toBe(2); // D-A junk + the free-text decision
    // CR-61: expired, NOT deleted — total row count unchanged.
    expect(totalCount()).toBe(total0);
    expect((db.prepare(`SELECT expired_at_epoch e FROM observations WHERE id=?`).get(junk) as { e: number }).e).toBe(9999);
    expect((db.prepare(`SELECT COALESCE(expired_at_epoch,0) e FROM observations WHERE id=?`).get(ftJunk) as { e: number }).e).toBe(9999);
    expect((db.prepare(`SELECT COALESCE(expired_at_epoch,0) e FROM observations WHERE id=?`).get(keepMemFile) as { e: number }).e).toBe(0);
    expect((db.prepare(`SELECT COALESCE(expired_at_epoch,0) e FROM observations WHERE id=?`).get(keepLesson) as { e: number }).e).toBe(0);
  });

  it('is idempotent — a second apply finds nothing new', () => {
    insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: /**', epoch: 6000 });
    pruneNoiseObservations(db, { dryRun: false, now: 100 });
    const second = pruneNoiseObservations(db, { dryRun: false, now: 200 });
    expect(second.counts.total).toBe(0);
    expect(second.expired).toBe(0);
  });

  it('sampleNoise is bounded by the limit', () => {
    for (let i = 0; i < 25; i++) insertObs({ session: 's1', type: 'decision', title: 'Architecture decision: /**', epoch: 7000 + i });
    expect(sampleNoise(db, 10).length).toBe(10);
  });
});

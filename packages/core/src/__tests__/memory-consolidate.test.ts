// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Consolidation engine tests (P8-002, plan-living-memory-slice-3).
//
// The properties that MUST hold, because getting them wrong destroys the
// operator's memory rather than merely failing:
//   * COLD START: a fresh counter must expire NOTHING.
//   * ORDERING: expire must never consume an importance value the same pass
//     just wrote (demote-then-expire in one breath).
//   * IDEMPOTENCY: a second run must mutate nothing.
//   * UNIVERSALITY: the whole pass must work with no LLM and no network.
//   * SECURITY: a lesson must never be distilled from raw pasted text, and
//     nothing credential-shaped may be stored.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

import {
  initMemorySchema,
  createSession,
  addObservation,
  recordRecallHits,
  armUsageCounter,
  setMemoryMeta,
  USAGE_COUNTER_ARMED_KEY,
  CONSOLIDATION_LESSON_EVIDENCE,
} from '../memory-db.ts';
import { runConsolidation } from '../memory-consolidate.ts';
import { DEFAULT_CONSOLIDATION_CONFIG, type ConsolidationConfig } from '../consolidation-config.ts';
import { extractiveSummary, redactSecrets, isSummarizableSignal } from '../memory-llm.ts';

const DAY = 86400;

function cfg(over: Partial<ConsolidationConfig> = {}): ConsolidationConfig {
  // No llmEndpoint => the ENTIRE suite runs the zero-LLM, zero-network path.
  // That is deliberate: it is the path every downloader gets.
  return { ...DEFAULT_CONSOLIDATION_CONFIG, ...over };
}

/** Insert an observation at an arbitrary age. */
function seedObs(
  db: Database.Database,
  sessionId: string,
  type: string,
  title: string,
  ageDays: number,
  importance: number,
  evidence?: string,
): number {
  const epoch = Math.floor(Date.now() / 1000) - ageDays * DAY;
  const r = db
    .prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, evidence, created_at, created_at_epoch)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(sessionId, type, title, importance, evidence ?? null, new Date(epoch * 1000).toISOString(), epoch);
  return Number(r.lastInsertRowid);
}

describe('consolidation engine', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'massu-consolidate-'));
    db = new Database(join(dir, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
    createSession(db, 'S2');
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('COLD START: a fresh store expires NOTHING, however old and unused its memories are', async () => {
    // This is the failure that would have destroyed the operator's history: the
    // usage counter is brand new, so nothing has "ever been retrieved".
    for (let i = 0; i < 50; i++) {
      seedObs(db, 'S1', 'file_change', `Ancient note ${i}`, 200, 1);
    }
    armUsageCounter(db); // armed NOW -> warmup has not elapsed

    const res = await runConsolidation(db, { config: cfg(), projectRoot: dir });

    expect(res.expired).toBe(0);
    expect(res.warmingUp).toBe(true);
    const live = db
      .prepare('SELECT COUNT(*) c FROM observations WHERE expired_at IS NULL')
      .get() as { c: number };
    expect(live.c).toBe(50);
  });

  it('after warmup, expires ONLY the genuinely dead weight — and expires, never deletes', async () => {
    const now = Math.floor(Date.now() / 1000);
    setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * DAY)); // warmed up

    const dead = seedObs(db, 'S1', 'file_change', 'Nobody ever needed this', 200, 1);
    const decision = seedObs(db, 'S1', 'decision', 'A real decision', 200, 1);
    const useful = seedObs(db, 'S1', 'file_change', 'Old but actually used', 200, 1);
    const lesson = seedObs(db, 'S1', 'discovery', 'Distilled lesson', 200, 1, CONSOLIDATION_LESSON_EVIDENCE);
    recordRecallHits(db, 'other-session', [{ source: 'observation', id: useful }], now);

    const res = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });

    expect(res.expired).toBe(1);

    const state = (id: number): string | null =>
      (db.prepare('SELECT expired_at FROM observations WHERE id = ?').get(id) as {
        expired_at: string | null;
      }).expired_at;

    expect(state(dead)).not.toBeNull();     // retired
    expect(state(decision)).toBeNull();     // protected type
    expect(state(useful)).toBeNull();       // proved useful
    expect(state(lesson)).toBeNull();       // a distilled lesson must not die

    // Nothing was DELETED — history stays answerable.
    const total = db.prepare('SELECT COUNT(*) c FROM observations').get() as { c: number };
    expect(total.c).toBe(4);
  });

  it('ORDERING: a row demoted this pass cannot also be expired by the same pass', async () => {
    const now = Math.floor(Date.now() / 1000);
    setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * DAY));

    // importance 3 (the DEFAULT) sits above the floor of 2. Reweight will
    // demote it to 2. If expire ran AFTER reweight, this row would be retired
    // in the same breath — the pass manufacturing its own expiry condition.
    const id = seedObs(db, 'S1', 'file_change', 'Default-importance, old, unused', 200, 3);

    const first = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });
    expect(first.expired).toBe(0); // survived: it was only demoted

    const after = db.prepare('SELECT importance, expired_at FROM observations WHERE id = ?').get(id) as {
      importance: number; expired_at: string | null;
    };
    expect(after.importance).toBe(2);
    expect(after.expired_at).toBeNull();

    // Only on a LATER pass (a full cadence window later, during which a
    // retrieval could have rescued it) does it become eligible.
    const second = await runConsolidation(db, {
      config: cfg(), projectRoot: dir, nowEpochSec: now + 2 * DAY,
    });
    expect(second.expired).toBe(1);
  });

  it('IDEMPOTENT: an immediate second run mutates nothing', async () => {
    const now = Math.floor(Date.now() / 1000);
    setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * DAY));
    for (let i = 0; i < 10; i++) seedObs(db, 'S1', 'file_change', `Note ${i}`, 200, 3);

    await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });

    const snapshot = () =>
      JSON.stringify(
        db.prepare('SELECT id, importance, expired_at FROM observations ORDER BY id').all(),
      );
    const before = snapshot();

    // Same clock => the reweight watermark must suppress a second demotion,
    // AND the grace period must stop the freshly-demoted rows from being
    // expired at the floor. (This assertion caught a real bug: without the
    // grace period, run 2 expired all 10 rows a minute after run 1 demoted
    // them — "value-aware" in name only.)
    const second = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });

    expect(second.reweighted).toBe(0);
    expect(second.expired).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('GRACE PERIOD: a demoted row survives a full cadence window before it can expire', async () => {
    const now = Math.floor(Date.now() / 1000);
    setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * DAY));
    const id = seedObs(db, 'S1', 'file_change', 'Old, unused, default importance', 200, 3);

    await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now }); // demote 3->2

    // A retrieval DURING the grace window rescues it permanently.
    recordRecallHits(db, 'rescue-session', [{ source: 'observation', id }], now + 3600);

    const later = await runConsolidation(db, {
      config: cfg(), projectRoot: dir, nowEpochSec: now + 2 * DAY,
    });
    expect(later.expired).toBe(0);
    const row = db.prepare('SELECT expired_at FROM observations WHERE id = ?').get(id) as {
      expired_at: string | null;
    };
    expect(row.expired_at).toBeNull();
  });

  it('SINGLE WRITER: a concurrent pass is a no-op (it cannot skip rows via a shared cursor)', async () => {
    const now = Math.floor(Date.now() / 1000);
    setMemoryMeta(db, 'consolidate_lease', `999999:${now + 3600}`); // lease held

    const res = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });
    expect(res.skipped).toBe('lease-held');
    expect(res.expired).toBe(0);
  });

  it('dry-run writes nothing', async () => {
    const now = Math.floor(Date.now() / 1000);
    setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * DAY));
    seedObs(db, 'S1', 'file_change', 'Dead weight', 200, 1);

    const before = JSON.stringify(db.prepare('SELECT * FROM observations').all());
    await runConsolidation(db, { config: cfg(), projectRoot: dir, dryRun: true, nowEpochSec: now });
    expect(JSON.stringify(db.prepare('SELECT * FROM observations').all())).toBe(before);
  });

  it('UNIVERSALITY: distills a session lesson with NO model and NO network', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTurn = now - 6 * DAY; // older than summarizeAfterDays (5)

    db.prepare(
      `INSERT INTO conversation_turns (session_id, turn_number, user_prompt, created_at, created_at_epoch)
       VALUES ('S1', 1, 'the login command hangs', ?, ?)`,
    ).run(new Date(oldTurn * 1000).toISOString(), oldTurn);

    addObservation(db, 'S1', 'failed_attempt', 'Fail-fast on non-TTY broke piping a key in', null, {
      importance: 5,
    });
    addObservation(db, 'S1', 'bugfix', 'Bounded the stdin read to 2s with a 64KB cap', null, {
      importance: 4,
    });

    // cfg() has NO llmEndpoint -> the extractive path, offline.
    const res = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });

    expect(res.summarized).toBe(1);
    expect(res.summaryTier).toBe('extractive');

    const lesson = db
      .prepare(`SELECT detail FROM observations WHERE evidence = ? LIMIT 1`)
      .get(CONSOLIDATION_LESSON_EVIDENCE) as { detail: string };
    expect(lesson.detail).toContain('Fail-fast on non-TTY');
    expect(lesson.detail).toContain('64KB cap');
  });

  it('SECURITY: a session whose only material is harness noise produces NO lesson, not a junk one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTurn = now - 6 * DAY;
    db.prepare(
      `INSERT INTO conversation_turns (session_id, turn_number, user_prompt, created_at, created_at_epoch)
       VALUES ('S2', 1, '<command-name>/clear</command-name>', ?, ?)`,
    ).run(new Date(oldTurn * 1000).toISOString(), oldTurn);
    // S2 has NO observations -> nothing curated to distill.

    const res = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });

    expect(res.summarized).toBe(0);
    const lessons = db
      .prepare(`SELECT COUNT(*) c FROM observations WHERE evidence = ?`)
      .get(CONSOLIDATION_LESSON_EVIDENCE) as { c: number };
    expect(lessons.c).toBe(0);

    // "nothing worth saying" is NOT the same fact as "a lesson was destroyed":
    // S2 (noise only, but its turns still exist) is 'no_signal' and is NOT
    // counted as missed. S1 — which has no turns at all — IS a real loss.
    const status = db
      .prepare(`SELECT consolidated_status s FROM sessions WHERE session_id='S2'`)
      .get() as { s: string };
    expect(status.s).toBe('no_signal');
    expect(res.sessionsMissed).toBe(1); // S1 only
  });

  it('reports sessionsMissed when a transcript was destroyed before it could be distilled', async () => {
    const now = Math.floor(Date.now() / 1000);
    // S1/S2 have no conversation_turns at all -> their lessons are unrecoverable.
    const res = await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now });
    expect(res.sessionsMissed).toBe(2);
  });
});

describe('extractive summarizer (the default, model-free path)', () => {
  it('selects real sentences and never invents text', () => {
    const out = extractiveSummary(
      [
        { text: 'bugfix: bounded the stdin read to 2 seconds with a 64KB cap', weight: 5 },
        { text: 'ok thanks', weight: 1 },
        { text: 'failed_attempt: refusing to run without a TTY broke piping a key in', weight: 4 },
      ],
      500,
    );
    expect(out).toContain('64KB cap');
    expect(out).toContain('piping a key in');
    expect(out).not.toContain('ok thanks'); // filtered as noise
  });

  it('drops harness noise', () => {
    expect(isSummarizableSignal('<command-name>/clear</command-name>')).toBe(false);
    expect(isSummarizableSignal('ok')).toBe(false);
    expect(isSummarizableSignal('bugfix: bounded the stdin read to 2s with a 64KB cap')).toBe(true);
  });
});

describe('secret redaction', () => {
  it('redacts credential shapes that must never enter durable memory', () => {
    expect(redactSecrets('Saved API key ms_live_abc123def456ghi to disk')).not.toContain('ms_live_abc123def456ghi');
    expect(redactSecrets('token sk-abcdefghijklmnopqrst')).toContain('[REDACTED]');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED_AWS_KEY]');
    // Ordinary engineering prose is untouched.
    expect(redactSecrets('bounded the stdin read to 2s')).toBe('bounded the stdin read to 2s');
  });
});

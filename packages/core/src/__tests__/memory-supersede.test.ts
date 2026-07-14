// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-living-memory-slice-2-temporal-model P7-001: supersede/contradiction gate.
// Covers the pure judge (ADD/UPDATE/NOOP + replacement signal), markRecordSuperseded
// (UPDATE-not-DELETE + idempotent + self-supersede-safe), config resolution, and
// the fail-open behavior of the orchestrator when embeddings are unavailable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession, addObservation, markRecordSuperseded } from '../memory-db.ts';
import {
  hasReplacementSignal,
  judgeContradiction,
  resolveContradictionConfig,
  supersedeIfContradicted,
  runSessionSupersedeSweep,
  type ContradictionConfig,
  type ScoredCandidate,
} from '../memory-supersede.ts';

function mkDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  createSession(db, 's1');
  return db;
}

const CFG: ContradictionConfig = {
  enabled: true,
  similarityThreshold: 0.6, // calibrated to all-MiniLM-L6-v2 (see RESULTS report)
  dedupThreshold: 0.93,
  gatedTypes: ['decision', 'cr_violation', 'failed_attempt'],
  annotateSuperseded: false,
  budgetMs: 800,
};

describe('hasReplacementSignal (P7-001)', () => {
  it.each([
    'we switched from Vercel to the massu-deploy script',
    'use the script instead of Vercel',
    'Vercel is no longer used',
    'this replaces the old approach',
    'correction: we now use X',
    'reverted to the previous design',
  ])('detects replacement language: %s', (t) => {
    expect(hasReplacementSignal(t)).toBe(true);
  });

  it.each([
    'we deploy the website with Vercel',
    'the login page renders a form',
    'added a new dashboard chart',
  ])('does NOT flag neutral statements: %s', (t) => {
    expect(hasReplacementSignal(t)).toBe(false);
  });
});

describe('judgeContradiction (P7-001)', () => {
  const cand = (id: number, cosine: number): ScoredCandidate => ({ id, source: 'observation', cosine });

  it('ADD when there are no candidates', () => {
    expect(judgeContradiction('anything', [], CFG).op).toBe('ADD');
  });

  it('NOOP when the top candidate is a near-duplicate (>= dedupThreshold)', () => {
    const v = judgeContradiction('deploy with vercel', [cand(1, 0.99)], CFG);
    expect(v.op).toBe('NOOP');
    expect(v.targetId).toBe(1);
  });

  it('UPDATE when related (>= similarity, < dedup) AND replacement signal present', () => {
    const v = judgeContradiction('we switched from Vercel to the script instead', [cand(7, 0.88)], CFG);
    expect(v.op).toBe('UPDATE');
    expect(v.targetId).toBe(7);
  });

  it('ADD when related but no replacement signal (both may coexist)', () => {
    const v = judgeContradiction('we deploy the website with Vercel', [cand(7, 0.88)], CFG);
    expect(v.op).toBe('ADD');
  });

  it('ADD when the top candidate is below the similarity threshold', () => {
    const v = judgeContradiction('we switched from X to Y instead', [cand(7, 0.5)], CFG);
    expect(v.op).toBe('ADD');
  });

  it('picks the highest-cosine candidate as the supersede target', () => {
    const v = judgeContradiction('replaced the old thing instead of keeping it', [cand(1, 0.83), cand(2, 0.9), cand(3, 0.85)], CFG);
    expect(v.op).toBe('UPDATE');
    expect(v.targetId).toBe(2);
  });
});

describe('markRecordSuperseded (P7-001) — UPDATE, never DELETE', () => {
  let db: Database.Database;
  beforeEach(() => { db = mkDb(); });
  afterEach(() => { db.close(); });

  it('expires + links the old row without deleting it', () => {
    const oldId = addObservation(db, 's1', 'decision', 'deploy with Vercel', 'we deploy with Vercel');
    const newId = addObservation(db, 's1', 'decision', 'deploy with script', 'we switched to the script');
    const ok = markRecordSuperseded(db, 'observations', oldId, newId, 1800000000);
    expect(ok).toBe(true);
    const row = db.prepare(`SELECT id, valid_to, expired_at, expired_at_epoch, valid_to_epoch, superseded_by FROM observations WHERE id=?`).get(oldId) as Record<string, unknown>;
    // Row STILL EXISTS (not deleted)
    expect(row).toBeTruthy();
    expect(row.id).toBe(oldId);
    expect(row.expired_at).not.toBeNull();
    expect(row.valid_to).not.toBeNull();
    expect(row.expired_at_epoch).toBe(1800000000);
    expect(row.valid_to_epoch).toBe(1800000000);
    expect(row.superseded_by).toBe(newId);
  });

  it('flips architecture_decisions.status to superseded', () => {
    db.prepare(`INSERT INTO architecture_decisions (session_id, title, decision, status, created_at, valid_from_epoch, ingested_at_epoch) VALUES ('s1','t','d','accepted',datetime('now'),1,1)`).run();
    const oldId = Number((db.prepare(`SELECT id FROM architecture_decisions ORDER BY id DESC LIMIT 1`).get() as { id: number }).id);
    markRecordSuperseded(db, 'architecture_decisions', oldId, oldId + 999, 1800000000);
    const row = db.prepare(`SELECT status, expired_at FROM architecture_decisions WHERE id=?`).get(oldId) as { status: string; expired_at: string | null };
    expect(row.status).toBe('superseded');
    expect(row.expired_at).not.toBeNull();
  });

  it('is idempotent — a second call on an already-expired row is a no-op', () => {
    const oldId = addObservation(db, 's1', 'decision', 'a', 'a');
    expect(markRecordSuperseded(db, 'observations', oldId, oldId + 1, 100)).toBe(true);
    expect(markRecordSuperseded(db, 'observations', oldId, oldId + 2, 200)).toBe(false);
    // Original supersede link preserved
    const row = db.prepare(`SELECT superseded_by, expired_at_epoch FROM observations WHERE id=?`).get(oldId) as { superseded_by: number; expired_at_epoch: number };
    expect(row.superseded_by).toBe(oldId + 1);
    expect(row.expired_at_epoch).toBe(100);
  });

  it('never supersedes a row by itself', () => {
    const id = addObservation(db, 's1', 'decision', 'x', 'x');
    expect(markRecordSuperseded(db, 'observations', id, id, 100)).toBe(false);
  });
});

describe('resolveContradictionConfig (P7-001)', () => {
  it('returns safe defaults', () => {
    const cfg = resolveContradictionConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.similarityThreshold).toBeGreaterThan(0);
    expect(cfg.gatedTypes).toContain('decision');
    expect(cfg.gatedTypes).not.toContain('file_change'); // hot type excluded
  });
});

describe('supersedeIfContradicted / sweep — fail-open (P7-001)', () => {
  let db: Database.Database;
  const prev = process.env.MASSU_DISABLE_EMBEDDINGS;
  beforeEach(() => { db = mkDb(); process.env.MASSU_DISABLE_EMBEDDINGS = '1'; });
  afterEach(() => { db.close(); if (prev === undefined) delete process.env.MASSU_DISABLE_EMBEDDINGS; else process.env.MASSU_DISABLE_EMBEDDINGS = prev; });

  it('returns ADD (supersedes nothing) when the embedder is disabled', async () => {
    const id = addObservation(db, 's1', 'decision', 'x', 'we switched to x instead');
    const res = await supersedeIfContradicted(db, null, { text: 'we switched to x instead', source: 'observation', newId: id, config: CFG });
    expect(res.op).toBe('ADD');
    expect(res.superseded).toBeNull();
  });

  it('disabled config short-circuits to ADD without touching the DB', async () => {
    const id = addObservation(db, 's1', 'decision', 'x', 'x');
    const res = await supersedeIfContradicted(db, null, { text: 'x', source: 'observation', newId: id, config: { ...CFG, enabled: false } });
    expect(res.op).toBe('ADD');
  });

  it('runSessionSupersedeSweep is a no-op with disabled config', async () => {
    const res = await runSessionSupersedeSweep(db, 's1', { config: { ...CFG, enabled: false } });
    expect(res.superseded).toBe(0);
  });

  it('runSessionSupersedeSweep supersedes nothing when embedder is off (fail-open)', async () => {
    addObservation(db, 's1', 'decision', 'deploy with vercel', 'we deploy with vercel');
    addObservation(db, 's1', 'decision', 'deploy with script', 'we switched to the script instead');
    const res = await runSessionSupersedeSweep(db, 's1', { config: CFG });
    expect(res.superseded).toBe(0); // no embeddings → no contradiction detected
  });
});

// Real-model E2E: the full embed → hybridSearch → cosine → supersede pipeline.
// Gated behind MASSU_RUN_EMBED_MODEL_TEST=1 (loads the bundled WASM model).
const RUN_MODEL = process.env.MASSU_RUN_EMBED_MODEL_TEST === '1';
describe.runIf(RUN_MODEL)('supersede pipeline with real embeddings (P6-001 E2E)', () => {
  it('a contradicting correction supersedes the semantically-related prior', async () => {
    const prev = process.env.MASSU_DISABLE_EMBEDDINGS;
    delete process.env.MASSU_DISABLE_EMBEDDINGS;
    const db = mkDb();
    try {
      const { embedMissingObservations } = await import('../memory-db.ts');
      const oldId = addObservation(db, 's1', 'decision', 'Deploy via Vercel', 'We deploy the marketing website using Vercel.');
      const newId = addObservation(db, 's1', 'decision', 'Deploy via script', 'We switched from Vercel to the massu-deploy script instead for deploying the website.');
      await embedMissingObservations(db, { budgetMs: 20000 });
      const res = await runSessionSupersedeSweep(db, 's1', { config: CFG, budgetMs: 20000 });
      expect(res.superseded).toBeGreaterThanOrEqual(1);
      const oldRow = db.prepare(`SELECT expired_at, superseded_by FROM observations WHERE id=?`).get(oldId) as { expired_at: string | null; superseded_by: number | null };
      expect(oldRow.expired_at).not.toBeNull();
      expect(oldRow.superseded_by).toBe(newId);
      // successor stays live
      const newRow = db.prepare(`SELECT expired_at FROM observations WHERE id=?`).get(newId) as { expired_at: string | null };
      expect(newRow.expired_at).toBeNull();
    } finally {
      db.close();
      if (prev !== undefined) process.env.MASSU_DISABLE_EMBEDDINGS = prev;
    }
  });
});

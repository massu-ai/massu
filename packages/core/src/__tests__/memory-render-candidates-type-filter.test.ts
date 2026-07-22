// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * D-D (plan-memory-ingestion-decision-noise-fix): only genuine lesson/knowledge memories
 * become durable render candidates — NOT session telemetry.
 *
 * The WS3 render dry-run showed that, with no type filter, `loadRenderCandidates` returned
 * telemetry — "VR-TYPE: PASS", "Tests: FAIL", "Commit: Unknown commit" — which the renderer
 * would have written as `vr-type-pass.md` / `tests-fail.md` / `commit-*.md`. Importance is
 * not a memory-worthiness signal (a passing type-check is importance-5 telemetry); the TYPE
 * is. These assert the telemetry types can never reach the renderer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, createSession, addObservation } from '../memory-db.ts';
import { loadRenderCandidates, RENDERABLE_MEMORY_TYPES } from '../memory-render-candidates.ts';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
  createSession(db, 's1');
});
afterEach(() => db.close());

describe('D-D — render candidates are memory-worthy types only', () => {
  it('excludes telemetry types even at high importance', () => {
    // Telemetry — must NEVER become a durable file, whatever the importance.
    addObservation(db, 's1', 'vr_check', 'VR-TYPE: PASS', 'x', { importance: 5 });
    addObservation(db, 's1', 'feature', 'Commit: shipped X', 'x', { importance: 5 });
    addObservation(db, 's1', 'pattern_compliance', 'Pattern Scanner: FAIL', 'x', { importance: 4 });
    addObservation(db, 's1', 'file_change', 'Edited: a.ts', 'x', { importance: 5 });
    addObservation(db, 's1', 'discovery', 'Found a thing', 'x', { importance: 5 });

    expect(loadRenderCandidates(db)).toEqual([]);
  });

  it('includes genuine lesson/knowledge memories', () => {
    addObservation(db, 's1', 'decision', 'We chose X over Y for latency', 'because…', { importance: 5 });
    addObservation(db, 's1', 'failed_attempt', 'Do not rebuild --build-from-source', 'SIGKILL', { importance: 5 });
    addObservation(db, 's1', 'incident_near_miss', 'Almost pushed a RED gate', 'caught', { importance: 4 });
    addObservation(db, 's1', 'cr_violation', 'CR-63 uncovered claim', 'fixed', { importance: 4 });

    const titles = loadRenderCandidates(db).map((c) => c.title).sort();
    expect(titles).toEqual(
      ['CR-63 uncovered claim', 'Almost pushed a RED gate', 'Do not rebuild --build-from-source', 'We chose X over Y for latency'].sort(),
    );
  });

  it('every returned candidate has a memory-worthy type', () => {
    for (const t of ['decision', 'failed_attempt', 'incident_near_miss', 'cr_violation', 'vr_check', 'feature', 'file_change']) {
      addObservation(db, 's1', t, `title-${t}`, 'd', { importance: 5 });
    }
    // (We assert via titles since RenderCandidate doesn't carry type; the query filters it.)
    const titles = new Set(loadRenderCandidates(db).map((c) => c.title));
    for (const t of RENDERABLE_MEMORY_TYPES) expect(titles.has(`title-${t}`), `${t} should be a candidate`).toBe(true);
    for (const t of ['vr_check', 'feature', 'file_change']) expect(titles.has(`title-${t}`), `${t} must be excluded`).toBe(false);
  });
});

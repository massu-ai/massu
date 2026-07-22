// Slice 5 — B-03 + M3 structural drift-guards for the trust-critical sync half.
//
//  (1) B-03: shared-memory-sync.ts (the verify→pending→accept half) imports NO
//      concrete transport and makes NO global network call. The transport is a
//      PARAMETER, so the local and cloud paths run the SAME verify/accept code and
//      the local path can never rot into a weaker parallel mechanism. Greps code AND
//      comments (the team-rule-sync HARD-INVARIANT posture).
//  (2) M3: ACCEPTED_OBSERVATION_TYPES equals the observations.type CHECK vocabulary,
//      so accept's pre-validation can never drift from what the DB will accept (an
//      unknown type must be REFUSED before the transaction, never thrown mid-write).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ACCEPTED_OBSERVATION_TYPES } from '../shared-memory-sync.ts';

const SRC = join(__dirname, '..');
const SYNC = join(SRC, 'shared-memory-sync.ts');
const MEMORY_DB = join(SRC, 'memory-db.ts');

describe('Slice 5 B-03 — sync half is transport-agnostic', () => {
  const src = readFileSync(SYNC, 'utf-8');

  it('names no concrete transport class (code or comments)', () => {
    expect(src).not.toMatch(/\bLocalFsTransport\b/);
    expect(src).not.toMatch(/\bCloudTeamTransport\b/);
  });

  it('makes no global network call and no CommonJS require', () => {
    // A bare `fetch(` NOT preceded by a dot/word char (so `transport.fetchSince(` is
    // allowed — it is a method on the INJECTED transport, not the global fetch).
    expect(src).not.toMatch(/(^|[^.\w])fetch\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/); // no dynamic import of a transport either
  });

  it('imports the transport only as a TYPE (erased at runtime)', () => {
    expect(src).toMatch(/import\s+type\s*\{[^}]*SharedMemoryTransport[^}]*\}\s*from\s*'\.\/shared-memory-transport\.ts'/);
    // and never as a value import from that module
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*'\.\/shared-memory-transport\.ts'/);
  });

  it('B-08: import runs in the session-END sweep, NEVER the recall hot path', () => {
    const recall = readFileSync(join(SRC, 'hooks', 'memory-recall.ts'), 'utf-8');
    expect(recall).not.toMatch(/importSharedMemories/); // crypto+I/O off the 8s recall budget
    const sessionEnd = readFileSync(join(SRC, 'hooks', 'session-end.ts'), 'utf-8');
    expect(sessionEnd).toMatch(/importSharedMemories/); // it is wired HERE
  });
});

describe('Slice 5 M3 — accepted type vocabulary matches the DB CHECK', () => {
  it('ACCEPTED_OBSERVATION_TYPES equals observations.type CHECK(type IN (...))', () => {
    const db = readFileSync(MEMORY_DB, 'utf-8');
    // Grab the FIRST observations `type ... CHECK(type IN ( ... ))` block.
    const m = db.match(/type\s+TEXT\s+NOT\s+NULL\s+CHECK\(type\s+IN\s*\(([\s\S]*?)\)\s*\)/);
    expect(m, 'observations.type CHECK not found').toBeTruthy();
    const checkTypes = new Set((m![1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1)));
    expect(checkTypes.size).toBeGreaterThan(0);
    expect([...ACCEPTED_OBSERVATION_TYPES].sort()).toEqual([...checkTypes].sort());
  });
});

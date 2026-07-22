// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-living-memory-slice-2-temporal-model P7-003: no-hard-delete drift-guard.
//
// Bug class made impossible: a future code path hard-DELETEs a memory record
// (observation / architecture_decision) as a "correction" instead of superseding
// it (setting valid_to/expired_at/superseded_by). Supersede-don't-delete is the
// invariant; hard deletion loses "what did we believe on date X" and the audit
// trail. This test scans ALL source and fails when a `DELETE FROM observations`
// or `DELETE FROM architecture_decisions` appears outside a small, reviewed
// allowlist — forcing a future author to supersede, or to consciously extend the
// allowlist with a reviewer. The regex is DOTALL + case-insensitive so it catches
// multi-line deletes (e.g. `DELETE FROM observations\n WHERE …`).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename } from 'path';

const SRC_ROOT = join(__dirname, '..');

// Files where a hard delete of these tables is a REVIEWED, legitimate operation
// (retention pruning; memory-file projection reconcile). Anything else must
// supersede. Keep this list minimal — adding to it is a deliberate review act.
const ALLOWLIST = new Set<string>([
  // EMPTY — and it stays empty (Slice 4, A-12).
  //
  // 'memory-db.ts' was allowlisted for pruneOldObservations()'s blanket 90-day
  // hard delete. Slice 3 converted it to a supersede-EXPIRE.
  // 'memory-file-ingest.ts' was the LAST entry, for the reconcile of
  // [memory-file] projection rows. Slice 4 converted it to an EXPIRE too.
  //
  // No code in Massu may hard-delete a memory. Full stop. Re-introducing one is
  // now a test failure, not a review discussion.
]);

// The supersede module must NEVER contain a hard delete of these tables.
const FORBIDDEN_IN = new Set<string>(['memory-supersede.ts']);

// `sessions` is included deliberately (P5-003). observations, session_summaries
// and user_prompts all carry `ON DELETE CASCADE` from sessions, and
// PRAGMA foreign_keys is ON — so a DELETE FROM sessions silently hard-deletes
// memory through the back door, completely invisibly to a regex that only
// watches the two tables directly. No production code does this today; this
// closes the door before someone walks through it.
// `memory_files` (Slice 4, A-02) holds the ONLY full-fidelity copy of the memory
// corpus — the whole file bytes, not the 500-char projection. Leaving it out of
// this regex would have made the slice's headline claim ("no code in Massu can
// hard-delete a memory") FALSE by construction: a `DELETE FROM memory_files`
// would pass this guard even with an empty allowlist.
// `shared_memory_pending` (Slice 5, S-3) holds the ONLY copy of an imported-but-not-
// yet-accepted cross-repo record — its verbatim signed envelope bytes. Revocation
// EXPIRES it (`expired_at_epoch`, B-07); a `DELETE FROM shared_memory_pending` would
// destroy the sole copy of a memory and pass this guard, again making the headline
// claim false as specified. B-07 uses UPDATE, never DELETE.
const DELETE_RE =
  /DELETE\s+FROM\s+(observations|architecture_decisions|sessions|memory_files|shared_memory_pending)\b/gis;

/**
 * Scan CODE, not prose.
 *
 * `session-start.ts` documents the exact SQL that used to wipe the projection —
 * quoting the banned statement is how the next reader understands WHY it is
 * banned. A guard that fires on its own incident write-up teaches people to
 * delete the write-up, which is the opposite of what it is for. The ban is on
 * EXECUTING the delete, not on naming it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // A transient file (e.g. a SQLite -journal sidecar from a test running in
    // parallel) can vanish between readdir and stat. A source-scanning guard
    // must never die because of a file that is not source.
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      walk(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('no-hard-delete-memory drift-guard (P7-003)', () => {
  const files = walk(SRC_ROOT);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every hard DELETE of observations/architecture_decisions is in the reviewed allowlist', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const content = stripComments(readFileSync(f, 'utf-8'));
      DELETE_RE.lastIndex = 0;
      if (DELETE_RE.test(content) && !ALLOWLIST.has(basename(f))) {
        offenders.push(relative(SRC_ROOT, f));
      }
    }
    expect(
      offenders,
      `Un-allowlisted hard DELETE of a temporal memory store found in: ${offenders.join(', ')}. ` +
        `Supersede (set valid_to/expired_at/superseded_by) instead of deleting, or add the file to the reviewed ALLOWLIST.`,
    ).toEqual([]);
  });

  it('the supersede module never hard-deletes a memory store (UPDATE only)', () => {
    for (const f of files) {
      if (!FORBIDDEN_IN.has(basename(f))) continue;
      const content = stripComments(readFileSync(f, 'utf-8'));
      DELETE_RE.lastIndex = 0;
      expect(DELETE_RE.test(content), `${basename(f)} must not contain DELETE FROM observations/architecture_decisions`).toBe(false);
      // Belt-and-suspenders: no bare DELETE FROM at all in the supersede path.
      expect(/DELETE\s+FROM/i.test(content), `${basename(f)} must not contain any DELETE FROM`).toBe(false);
    }
  });

  it('the ALLOWLIST is EMPTY — no file in src/ may hard-delete a memory', () => {
    // The slice's headline invariant, locked. Re-adding an entry is a deliberate
    // review act and must fail here first.
    //
    // NOTE this assertion exists because the companion test below CANNOT carry
    // it: `for (const name of ALLOWLIST)` over an empty Set executes zero
    // assertions and passes VACUOUSLY. The plan originally claimed that test
    // made an empty allowlist "self-enforcing" — it does not. The real
    // enforcement is the un-allowlisted-delete test above, plus this line.
    expect(
      [...ALLOWLIST],
      'the no-hard-delete ALLOWLIST must stay EMPTY (Slice 4, A-12)',
    ).toEqual([]);
  });

  it('the allowlisted files really do contain the deletes they are allowlisted for', () => {
    // Guards against a stale allowlist entry (drift the other direction).
    // hasAssertions() is what stops this from silently going vacuous: with an
    // empty ALLOWLIST the loop body never runs, so without this the test would
    // "pass" while asserting nothing at all.
    expect.hasAssertions();
    expect(ALLOWLIST.size, 'allowlist size is the loop bound').toBe(0);
    for (const name of ALLOWLIST) {
      const f = files.find((x) => basename(x) === name);
      expect(f, `allowlisted file ${name} exists`).toBeTruthy();
      const content = stripComments(readFileSync(f!, 'utf-8'));
      DELETE_RE.lastIndex = 0;
      expect(DELETE_RE.test(content), `${name} still contains an allowlisted delete (else remove it from ALLOWLIST)`).toBe(true);
    }
  });
});

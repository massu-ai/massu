// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * "massu can index THIS repository's real knowledge base."
 *
 * ⛔ WHY THIS IS ITS OWN FILE. `knowledge-tools.test.ts` used to make this claim as a side
 * effect of its `beforeAll`, by indexing the live tree before exercising the 12 tool
 * handlers. That conflated two questions with different failure modes:
 *
 *   - do the HANDLERS behave correctly?            answered against a fixed corpus, so the
 *                                                  oracle does not move (that file)
 *   - can the INDEXER read this repo's real docs?  answered here, against the live tree
 *
 * Bundling them made the handler tests a function of how much documentation the team had
 * written, and the expected answers (`CR-1`, `VR-BUILD`) changed whenever the docs did — a
 * test whose oracle is supplied by the system under test agrees with itself.
 *
 * ⛔ AND IT ASSERTS COUNTS, NEVER A DURATION. The temptation here is "the live index must
 * finish in N ms". That asserts the MACHINE (G27): measured 2026-09-20, the same call took
 * 1.1s on a quiet box and blew a 30,000ms budget under the pre-push battery's parallelism —
 * twice, months apart. Nothing about the code changed between those readings. A count does
 * not move with load, and it catches the failure that actually matters: an indexer that
 * silently stops seeing a category of file.
 *
 * The timeout below is the SECOND detection path only, for an implementation that never
 * finishes — not the property.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { initKnowledgeSchema } from '../knowledge-db.ts';
import {
  indexAllKnowledge,
  discoverMarkdownFiles,
  getKnowledgePaths,
} from '../knowledge-indexer.ts';
import { report } from './helpers/report.ts';

const DB_PATH = resolve(tmpdir(), `massu-live-corpus-${process.pid}.db`);
let db: Database.Database;
let stats: { filesIndexed: number; chunksCreated: number; edgesCreated: number };

function cleanup(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Discovery over every knowledge root, exactly as the indexer sees them.
 */
function snapshotDiscoverable(): Set<string> {
  const paths = getKnowledgePaths();
  const out = new Set<string>();
  for (const root of [paths.claudeDir, paths.memoryDir, paths.plansDir, paths.docsDir]) {
    let found: string[] = [];
    try {
      found = discoverMarkdownFiles(root);
    } catch {
      /* a root may not exist in every checkout; the M1 floor below catches an empty union */
    }
    for (const f of found) out.add(f);
  }
  return out;
}

/**
 * TWO SNAPSHOTS, BRACKETING THE INDEX RUN — and the reason is a real failure.
 *
 * The corpus is LIVE. It spans this repo's `.claude/` and `docs/` AND a memory directory
 * outside the repo, and indexing several hundred files takes seconds while the rest of the
 * suite runs in parallel workers. Comparing a count taken at index time against a discovery
 * taken later therefore compares two DIFFERENT filesystem states.
 *
 * Measured 2026-09-22: this reported `indexed 798 of 799` on one run and 798/798 on the next
 * three, with an at-rest set-difference of exactly ZERO in both directions. So the earlier
 * reading of it — that discovery and the indexer's post-filter list are different sets by
 * construction — was WRONG. They are the same set. What differed was the moment of
 * observation.
 *
 * That is two states collapsed into one failing value: `the indexer regressed` and `the
 * corpus moved under me` were indistinguishable, and the second is not a defect at all.
 * Bracketing indexing with a before/after snapshot separates them, and BOTH branches keep a
 * live assertion — a moving corpus never becomes a silent pass.
 */
let discoverableBefore: Set<string>;
let discoverableAfter: Set<string>;

beforeAll(() => {
  cleanup();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initKnowledgeSchema(db);
  discoverableBefore = snapshotDiscoverable();
  stats = indexAllKnowledge(db);
  discoverableAfter = snapshotDiscoverable();
}, 300_000);

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  cleanup();
});

describe('the live knowledge corpus is indexable', () => {
  it('indexes EVERY file it can discover (M1 — the denominator is derived, not guessed)', () => {
    // ⛔ THIS ASSERTED `> 100` FILES AND `> 1000` CHUNKS, AND THAT WAS A CLAIM ABOUT THE
    // ENVIRONMENT, NOT THE CODE (CR-68).
    //
    // The live corpus is whatever `getKnowledgePaths()` resolves to, and that differs by
    // checkout: the internal repo carries private documentation roots that the PUBLISHED
    // MIRROR does not. Measured 2026-09-21 — this file SYNCS to the mirror, and the
    // pre-push Sync Check provisions an ephemeral mirror and runs the suite there:
    //
    // (Those roots are named in the incident, not here: this file is PUBLIC, and the leak
    // guard flagged the first draft of this very comment for naming them. A comment that
    // explains a private-path defect must describe the shape, never the paths.)
    //
    //     massu-internal   passes
    //     ephemeral mirror  `expected 58 to be greater than 100`   -> push BLOCKED
    //
    // A hardcoded floor is also WEAKER than it looks in the repo where it passes: with a
    // corpus of several hundred files, `> 100` stays green while the indexer silently
    // stops seeing whole directories — the exact failure this test exists to catch.
    //
    // So the denominator is DERIVED, from the indexer's OWN discovery function rather than
    // a walk re-implemented here (a test that re-implements its subject drifts into
    // agreeing with its subject's bugs). The property becomes absolute: everything
    // discoverable was indexed, in any checkout, at any corpus size.
    const paths = getKnowledgePaths();
    const roots = [paths.claudeDir, paths.memoryDir, paths.plansDir, paths.docsDir];
    const discoverable = new Set<string>();
    for (const root of roots) for (const f of discoverMarkdownFiles(root)) discoverable.add(f);

    report(
      `[live-corpus] roots=${roots.length} discoverable=${discoverable.size} ` +
        `indexed=${stats.filesIndexed} chunks=${stats.chunksCreated}`,
    );

    // M1 — a corpus of zero makes every assertion below vacuous, and "indexed 0 of 0" is
    // exactly what a broken read returns.
    expect(
      discoverable.size,
      'no markdown was discoverable under any knowledge root — this sweep is blind',
    ).toBeGreaterThan(0);

    // Compare SETS, never counts. `798 of 799` names nothing, so every occurrence cost a
    // fresh investigation; a subtraction names the file and ends it.
    const indexed = new Set(stats.indexedPaths);
    const list = (s: string[]) => s.map((f) => `\n    ${f}`).join('');

    const appeared = [...discoverableAfter].filter((f) => !discoverableBefore.has(f));
    const vanished = [...discoverableBefore].filter((f) => !discoverableAfter.has(f));
    const corpusMoved = appeared.length > 0 || vanished.length > 0;

    if (!corpusMoved) {
      // The corpus held still, so the property is EXACT in both directions.
      const missed = [...discoverableBefore].filter((f) => !indexed.has(f));
      const alien = [...indexed].filter((f) => !discoverableBefore.has(f));
      expect(
        missed,
        `the indexer skipped ${missed.length} discoverable file(s):${list(missed)}`,
      ).toEqual([]);
      expect(
        alien,
        `the indexer indexed ${alien.length} file(s) discovery cannot see:${list(alien)}`,
      ).toEqual([]);
    } else {
      // The corpus MOVED while indexing ran. That is a provable, named state — not a
      // mystery and not a pass. Two real assertions still hold and are made here.
      report(
        `[live-corpus] corpus MOVED during indexing: +${appeared.length} -${vanished.length}` +
          `${list([...appeared, ...vanished])}`,
      );
      const stable = [...discoverableBefore].filter((f) => discoverableAfter.has(f));
      const missedStable = stable.filter((f) => !indexed.has(f));
      expect(
        missedStable,
        `the indexer skipped ${missedStable.length} file(s) present in BOTH snapshots, so a ` +
          `moving corpus does not explain them:${list(missedStable)}`,
      ).toEqual([]);
      const union = new Set([...discoverableBefore, ...discoverableAfter]);
      const alien = [...indexed].filter((f) => !union.has(f));
      expect(
        alien,
        `the indexer indexed ${alien.length} file(s) discoverable at NEITHER ` +
          `observation:${list(alien)}`,
      ).toEqual([]);
    }

    // Chunks scale with the corpus, so the only environment-free claim is that real
    // content came out of real files.
    expect(stats.chunksCreated).toBeGreaterThan(discoverable.size);
  });

  it('extracts canonical rules from this repo\'s own CLAUDE.md', () => {
    const rules = db.prepare('SELECT COUNT(*) AS n FROM knowledge_rules').get() as { n: number };
    expect(rules.n).toBeGreaterThan(0);
  });

  it('extracts verification types', () => {
    const vrs = db.prepare('SELECT COUNT(*) AS n FROM knowledge_verifications').get() as { n: number };
    expect(vrs.n).toBeGreaterThan(0);
  });

  it('builds cross-reference edges', () => {
    expect(stats.edgesCreated).toBeGreaterThan(0);
  });

  it('indexes every asset CATEGORY, so a whole class cannot go silently missing', () => {
    // The failure this is really for: a path predicate changes and one category stops
    // being walked. Totals stay large, so a bare file count would not notice.
    const rows = db
      .prepare('SELECT chunk_type, COUNT(*) AS n FROM knowledge_chunks GROUP BY chunk_type')
      .all() as Array<{ chunk_type: string; n: number }>;
    const byType = new Map(rows.map((r) => [r.chunk_type, r.n]));
    expect(byType.size).toBeGreaterThan(1);
    for (const [type, n] of byType) {
      expect(n, `chunk_type '${type}' indexed 0 rows`).toBeGreaterThan(0);
    }
  });
});

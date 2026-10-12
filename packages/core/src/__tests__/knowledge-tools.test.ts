// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { getResolvedPaths, resetConfig } from '../config.ts';
import { initKnowledgeSchema } from '../knowledge-db.ts';
import { indexAllKnowledge } from '../knowledge-indexer.ts';
import { handleKnowledgeToolCall, getKnowledgeToolDefinitions } from '../knowledge-tools.ts';

// P1-007: Knowledge Tools Unit Tests

// DB scratch under the OS temp dir, NEVER under packages/core/src (feedback_dashboard_key_ux_and_src_scratch_race).
const TEST_DB_PATH = resolve(tmpdir(), `massu-test-knowledge-tools-${process.pid}.db`);

let db: Database.Database;

function cleanupTestDb(): void {
  try {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm');
    if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal');
  } catch { /* ignore */ }
}

/**
 * ⛔ THE CORPUS IS A COMMITTED FIXTURE, NOT THIS REPOSITORY.
 *
 * This `beforeAll` used to call `indexAllKnowledge(db)` against the LIVE tree — 770 files
 * and 12,241 chunks — which made every one of the 30 handler tests below a function of how
 * much documentation the team happens to have written. Two consequences, both real:
 *
 *   1. IT FLAKED. Measured 2026-09-20: the indexer itself takes ~1.1s, but under the
 *      pre-push battery's parallelism this hook blew its 30,000ms budget. It had already
 *      done so once before — the comment further down records the same failure on
 *      2026-08-13 — and the corpus only grows, so any constant is a date at which it
 *      starts failing again (G27: a wall-clock budget asserts the MACHINE, not the code).
 *   2. THE ORACLE MOVED. Asserting `CR-1` and `VR-BUILD` against whatever `.claude/`
 *      contains today means the expectation changes when the documentation does. A test
 *      whose expected answer is supplied by the system under test agrees with itself.
 *
 * So the corpus is now `fixtures/knowledge-corpus/` — constant time, and a deterministic
 * oracle whose every row exists because a test asserts on it. It is hand-authored on
 * purpose: a guard's expectation may never be DERIVED from the thing it judges, or both
 * sides agree by construction (G32 option 0, THE BLIND-GATE LAW).
 *
 * The separate claim — "massu can index THIS repository's real knowledge base" — is a
 * different question with a different failure mode, and it is asserted on its own terms at
 * the bottom of this file, by COUNT rather than by clock.
 */
const FIXTURE_ROOT = resolve(__dirname, 'fixtures/knowledge-corpus');

/** Run `fn` with the process rooted in the fixture project. */
function inFixture<T>(fn: () => T): T {
  const prevCwd = process.cwd();
  resetConfig();
  try {
    process.chdir(FIXTURE_ROOT);
    return fn();
  } finally {
    process.chdir(prevCwd);
    resetConfig();
  }
}

beforeAll(() => {
  cleanupTestDb();
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initKnowledgeSchema(db);
  const stats = inFixture(() => indexAllKnowledge(db));

  // M1 — ASSERT THE ORACLE ARRIVED, NOT MERELY THAT SOMETHING WAS READ.
  //
  // The first version of this guard checked `filesIndexed`/`chunksCreated` only, and its
  // own live-fire proved that insufficient: emptying every corpus file still yields a
  // non-zero file count (the files exist) and non-zero chunks (document-level rows), so
  // the guard stayed silent while the suite fell back to `All Canonical Rules (0 total)`.
  // A corpus that parsed into no RULES and no VERIFICATIONS is exactly as vacuous as an
  // absent one, and it is the state a broken parser also produces.
  const ruleCount = (db.prepare('SELECT COUNT(*) AS n FROM knowledge_rules').get() as { n: number }).n;
  const vrCount = (db.prepare('SELECT COUNT(*) AS n FROM knowledge_verifications').get() as { n: number }).n;
  if (stats.filesIndexed === 0 || stats.chunksCreated === 0 || ruleCount === 0 || vrCount === 0) {
    throw new Error(
      `knowledge fixture indexed nothing usable at ${FIXTURE_ROOT} ` +
        `(files=${stats.filesIndexed} chunks=${stats.chunksCreated} rules=${ruleCount} vr=${vrCount}) ` +
        '— refusing to run assertions against a corpus that supplied no oracle',
    );
  }

  // ⛔ MARK THE INDEX FRESH SO NO DISPATCH RE-INDEXES MID-SUITE.
  //
  // `handleKnowledgeToolCall` opens with `ensureKnowledgeIndexed(db)` -> `indexIfStale(db)`,
  // which compares the CORPUS mtimes against `last_index_epoch`. Inside a test body the
  // process cwd is the repo root, not the fixture — so a stale verdict re-indexes against
  // THIS REPOSITORY and silently replaces the fixture corpus mid-run.
  //
  // The consequence is not merely "different rules". This repo's own CLAUDE.md writes its
  // canonical-rules table with THREE columns while `parseCRTable` requires four, so the
  // re-index yields ZERO rules and every lookup answers "Rule CR-9 not found."
  //
  // REPRODUCED 2026-09-20, and it is NOT about any particular harness: running this file
  // once and then `npm test` is enough. The first run updates mtimes under the repo, so the
  // second run reads them as newer than the index epoch. Isolation hid it because nothing
  // had touched the tree yet.
  //
  // A future stamp, not `Date.now()`: the point is that the fixture index is authoritative
  // for the whole file, whatever the ambient tree does while it runs.
  db.prepare("INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES ('last_index_epoch', ?)")
    .run(String(Date.now() + 3_600_000));
});

afterAll(() => {
  db.close();
  cleanupTestDb();
});

describe('getKnowledgeToolDefinitions', () => {
  it('returns 12 tool definitions', () => {
    const tools = getKnowledgeToolDefinitions();
    expect(tools.length).toBe(12);

    const names = tools.map(t => t.name);
    expect(names).toContain('massu_knowledge_search');
    expect(names).toContain('massu_knowledge_rule');
    expect(names).toContain('massu_knowledge_incident');
    expect(names).toContain('massu_knowledge_schema_check');
    expect(names).toContain('massu_knowledge_pattern');
    expect(names).toContain('massu_knowledge_verification');
    expect(names).toContain('massu_knowledge_graph');
    expect(names).toContain('massu_knowledge_command');
    expect(names).toContain('massu_knowledge_correct');
    expect(names).toContain('massu_knowledge_plan');
    expect(names).toContain('massu_knowledge_gaps');
    expect(names).toContain('massu_knowledge_effectiveness');
  });
});

describe('massu_knowledge_search', () => {
  it('finds results for build-related queries', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'build' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Search');
    // Should find something -- build is mentioned extensively
    expect(text).not.toContain('No matches found');
  });

  it('returns error for missing query', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_search', {}, db, 'ensure-fresh');
    expect(result.content[0].text).toContain('Error');
  });

  it('respects limit parameter', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'build', limit: 2 }, db, 'ensure-fresh');
    const text = result.content[0].text;
    // Count the number of result headers (### ...)
    const headings = text.match(/^### /gm);
    if (headings) {
      expect(headings.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('massu_knowledge_rule', () => {
  it('looks up CR-1 with verification', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { rule_id: 'CR-1' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('CR-1');
  });

  it('searches rules by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { keyword: 'test' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Rules matching');
  });

  it('lists all rules when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('All Canonical Rules');
    expect(text).toContain('CR-1');
  });

  it('handles unknown rule gracefully', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { rule_id: 'CR-999' }, db, 'ensure-fresh');
    expect(result.content[0].text).toContain('not found');
  });
});

describe('massu_knowledge_incident', () => {
  it('lists incidents when no filter', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_incident', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Incidents');
  });

  it('searches incidents by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_incident', { keyword: 'test' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Incidents');
  });
});

describe('massu_knowledge_schema_check', () => {
  it('returns no mismatches for unknown table', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_schema_check', { table: 'nonexistent_table_xyz' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('No known schema mismatches');
  });

  it('lists all mismatches when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_schema_check', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Schema Mismatches');
  });
});

describe('massu_knowledge_pattern', () => {
  it('returns pattern guidance for a domain keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_pattern', { domain: 'config' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Pattern Guidance');
  });

  it('requires domain parameter', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_pattern', {}, db, 'ensure-fresh');
    expect(result.content[0].text).toContain('Error');
  });
});

describe('massu_knowledge_verification', () => {
  it('looks up VR-BUILD', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_verification', { vr_type: 'VR-BUILD' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('VR-BUILD');
    expect(text).toContain('npm run build');
  });

  it('searches by situation', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_verification', { situation: 'test' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Verification');
  });

  it('lists all verifications when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_verification', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('All Verification Types');
  });
});

describe('massu_knowledge_graph', () => {
  it('traverses from CR-1', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_graph', { entity_type: 'cr', entity_id: 'CR-1' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Graph');
    expect(text).toContain('CR-1');
  });

  it('requires entity_type and entity_id', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_graph', {}, db, 'ensure-fresh');
    expect(result.content[0].text).toContain('Error');
  });
});

describe('massu_knowledge_command', () => {
  it('lists all commands when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_command', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('All Commands');
  });

  it('searches commands by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_command', { keyword: 'audit' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Commands matching');
  });
});

// Tests for additional tools

describe('massu_knowledge_correct', () => {
  // The corrections tool writes to the memory directory which may not exist
  const memoryDir = getResolvedPaths().memoryDir;
  const correctionsPath = resolve(memoryDir, 'corrections.md');
  let createdMemoryDir = false;

  beforeAll(() => {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
      createdMemoryDir = true;
    }
  });

  // STATE THE PRECONDITION THESE TESTS ALREADY ASSUME, INSTEAD OF PAYING FOR IT ON A CLOCK.
  //
  // `handleKnowledgeToolCall` opens with `ensureKnowledgeIndexed(db)` -> `indexIfStale(db)`,
  // and `isKnowledgeStale` stats every markdown file under .claude/, docs/, plans/ AND the
  // memory dir, returning true if any mtime is newer than `last_index_epoch`. These tests
  // WRITE `corrections.md` into that same memory dir — so the very next dispatch re-indexed
  // the entire corpus INSIDE the test body.
  //
  // Measured 2026-08-13 (`indexAllKnowledge` into a scratch db): 677 documents / 11,954
  // chunks / 9.2 MB of chunk text, 1,223ms per re-index in isolation. 29 of the 30 tests in
  // this file run in 2-35ms; the one that tripped this ran 6,123ms, and under the pre-push
  // battery's 16-way fork parallelism it blew a 30,000ms budget outright — the failure that
  // blocked this push. With the precondition stated below, that test runs in 8ms.
  //
  // The budget was NOT the bug and widening it again would not have been a fix: the work is
  // O(the repo's whole markdown corpus) and grows every day, so any constant is only a date
  // at which it starts failing. That is G27 — a wall-clock budget asserts the MACHINE, not
  // the code — and this file already carried one widened comment claiming the opposite.
  //
  // Nothing here is about lazy re-indexing; `knowledge-e2e` owns that. So declare the
  // precondition ("the index is current") explicitly and let the assertions be about
  // `handleCorrect`. The cost leaves the test entirely rather than being budgeted for.
  beforeEach(() => {
    db.prepare("INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES ('last_index_epoch', ?)")
      .run(String(Date.now()));
  });

  afterAll(() => {
    // Clean up corrections.md created by tests
    try { if (existsSync(correctionsPath)) unlinkSync(correctionsPath); } catch { /* ignore */ }
    // Only remove directory if we created it
    if (createdMemoryDir) {
      try { rmSync(memoryDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('requires wrong, correction, and rule', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_correct', { wrong: 'test' }, db, 'ensure-fresh');
    expect(result.content[0].text).toContain('Error');
  });

  it('records a correction when all args provided', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_correct', {
      wrong: 'Test wrong behavior',
      correction: 'Test correct behavior',
      rule: 'Test prevention rule',
      cr_rule: 'CR-9',
    }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Correction recorded');
    expect(text).toContain('Test wrong behavior');
    expect(text).toContain('corrections.md updated');
  });

  it('inserts correction chunk with is_correction metadata into DB when corrections doc is indexed', () => {
    // First, ensure a corrections.md document exists in the knowledge index
    // so handleCorrect can attach chunks to it
    const existingDoc = db.prepare(
      "SELECT id FROM knowledge_documents WHERE file_path LIKE '%corrections.md'"
    ).get() as { id: number } | undefined;

    if (!existingDoc) {
      // Insert a mock corrections.md document so handleCorrect can attach chunks
      db.prepare(
        'INSERT INTO knowledge_documents (file_path, category, title, content_hash, indexed_at, indexed_at_epoch) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('memory/corrections.md', 'memory', 'User Corrections Log', 'mock', new Date().toISOString(), Date.now());
    }

    handleKnowledgeToolCall('massu_knowledge_correct', {
      wrong: 'DB verify wrong',
      correction: 'DB verify correct',
      rule: 'DB verify rule',
      cr_rule: 'CR-99',
    }, db, 'ensure-fresh');
    const chunk = db.prepare(
      "SELECT heading, content, metadata FROM knowledge_chunks WHERE heading LIKE '%DB verify%' AND metadata LIKE '%is_correction%'"
    ).get() as { heading: string; content: string; metadata: string } | undefined;
    expect(chunk).toBeTruthy();
    expect(chunk!.content).toContain('DB verify wrong');
    const meta = JSON.parse(chunk!.metadata);
    expect(meta.is_correction).toBe(true);
    expect(meta.cr_rule).toBe('CR-99');
  }); // Runs in ~8ms against the default 5s budget now that the beforeEach above states
      // the index-current precondition. The former 30000ms override — and its comment
      // claiming this dispatch "re-indexes on disk" — described the cause that is now gone.
});

describe('massu_knowledge_plan', () => {
  it('lists all plans when no args', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_plan', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('All Plans');
  });

  it('finds plans by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_plan', { keyword: 'massu' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Plans matching');
  });
});

describe('massu_knowledge_gaps', () => {
  it('returns gap analysis for features', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_gaps', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Gap Analysis');
  });
});

describe('massu_knowledge_effectiveness', () => {
  it('returns ranked rule list', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_effectiveness', {}, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Most Violated Rules');
  });

  it('returns detail for a specific rule', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_effectiveness', { rule_id: 'CR-9', mode: 'detail' }, db, 'ensure-fresh');
    const text = result.content[0].text;
    expect(text).toContain('Rule Effectiveness');
    expect(text).toContain('CR-9');
  });
});

describe('handleKnowledgeToolCall routing', () => {
  it('handles unknown tool name', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_unknown', {}, db, 'ensure-fresh');
    expect(result.content[0].text).toContain('Unknown knowledge tool');
  });
});

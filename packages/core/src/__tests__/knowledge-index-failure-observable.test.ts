// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2 of `plan-2026-08-13-implicit-reindex-inside-tool-dispatch`: an indexing failure at the
 * knowledge chokepoint must be DISTINGUISHABLE from a successful rebuild.
 *
 * Before this, `ensureKnowledgeIndexed` swallowed every exception in a bare `catch` and its
 * boolean was discarded at the only site that called it — so a corrupt DB, a permissions
 * error and an FTS5 failure produced byte-identical output to a healthy rebuild, and the
 * dispatch answered from a stale index without saying so.
 *
 * Every assertion that the failure signal is PRESENT is paired with a control asserting it
 * is ABSENT on the uninjected path. Without that pair, "the banner appeared" is equally
 * consistent with a banner that always appears, and "the injection worked" with an
 * injection that never fired.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

/** Flipped per-test; the mock reads it at call time so one module instance serves both paths. */
let indexShouldThrow = false;
const indexIfStaleCalls = vi.fn();

vi.mock('../knowledge-indexer.ts', () => ({
  indexIfStale: (...args: unknown[]) => {
    indexIfStaleCalls(...args);
    if (indexShouldThrow) throw new Error('INJECTED: FTS5 index rebuild failed');
  },
}));

import { handleKnowledgeToolCall } from '../knowledge-tools.ts';

const BANNER = 'KNOWLEDGE INDEX NOT REFRESHED';
const FAILURE_KEY = 'knowledge-tools:ensure-indexed';

let scratch: string;
let failureLog: string;
let db: Database.Database;

/** A knowledge DB with enough schema for `hasData` and a search to run. */
function makeKnowledgeDb(withRows: boolean): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL,
      heading TEXT, content TEXT NOT NULL, chunk_type TEXT NOT NULL, metadata TEXT);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(heading, content);
  `);
  if (withRows) {
    d.prepare('INSERT INTO knowledge_documents (file_path, category, title) VALUES (?,?,?)')
      .run('.claude/patterns/x.md', 'patterns', 'X');
    d.prepare('INSERT INTO knowledge_chunks (document_id, heading, content, chunk_type, metadata) VALUES (1,?,?,?,?)')
      .run('Heading', 'widget content', 'section', '{}');
    d.prepare("INSERT INTO knowledge_fts (rowid, heading, content) VALUES (1,'Heading','widget content')").run();
  }
  return d;
}

const textOf = (r: { content: { text: string }[] }) => r.content.map(c => c.text).join('\n');

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'massu-kfail-'));
  // The failure channel appends to a real file. Redirect it — the suite's
  // hook-log-untouched guard asserts the OPERATOR's log is not written by a test run.
  failureLog = join(scratch, 'hook-failures.jsonl');
  mkdirSync(join(scratch, '.massu'), { recursive: true });
  process.env.MASSU_HOOK_FAILURE_LOG = failureLog;
  indexShouldThrow = false;
  indexIfStaleCalls.mockClear();
});

afterEach(() => {
  db?.close();
  delete process.env.MASSU_HOOK_FAILURE_LOG;
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe('an indexing failure is observable at the knowledge chokepoint', () => {
  it('CONTROL: a successful rebuild produces NO failure signal', () => {
    db = makeKnowledgeDb(true);
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'ensure-fresh');

    // The injection is armed but not firing — proof the mock is wired and reachable.
    expect(indexIfStaleCalls).toHaveBeenCalledTimes(1);
    expect(textOf(result)).not.toContain(BANNER);
    expect(existsSync(failureLog)).toBe(false);
  });

  it('an injected throw CHANGES the observable output', () => {
    db = makeKnowledgeDb(true);
    const healthy = textOf(handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'ensure-fresh'));

    indexShouldThrow = true;
    const degraded = textOf(handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'ensure-fresh'));

    // The property P2 exists to establish: the two are DISTINGUISHABLE.
    expect(degraded).not.toBe(healthy);
    expect(degraded).toContain(BANNER);
    // …and still answers, because loud is not fatal.
    expect(degraded).toContain('widget');
  });

  it('binds and RECORDS the error instead of discarding it', () => {
    db = makeKnowledgeDb(true);
    indexShouldThrow = true;
    handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'ensure-fresh');

    expect(existsSync(failureLog)).toBe(true);
    const rec = JSON.parse(readFileSync(failureLog, 'utf-8').trim().split('\n')[0]);
    expect(rec.hook).toBe(FAILURE_KEY);
    // The bound error's MESSAGE, not a generic placeholder — a bare `catch` could not do this.
    expect(rec.error).toContain('INJECTED: FTS5 index rebuild failed');
  });

  it('warns on the early no-data return too, not only the search path', () => {
    // The reason the dispatch was split: a per-case edit would have decorated the tool
    // handlers and missed `hasData`'s early return and the unknown-tool default (CR-74).
    db = makeKnowledgeDb(false);
    indexShouldThrow = true;
    const degraded = textOf(handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'ensure-fresh'));

    expect(degraded).toContain(BANNER);
    expect(degraded).toContain('No knowledge indexed yet');
  });

  it('warns on the unknown-tool default too', () => {
    db = makeKnowledgeDb(true);
    indexShouldThrow = true;
    const degraded = textOf(handleKnowledgeToolCall('massu_knowledge_nope', {}, db, 'ensure-fresh'));

    expect(degraded).toContain(BANNER);
    expect(degraded).toContain('Unknown knowledge tool');
  });

  it('CONTROL: none of the above paths banner when indexing succeeds', () => {
    // The must-stay-silent half. A banner that always appears carries no information.
    db = makeKnowledgeDb(false);
    expect(textOf(handleKnowledgeToolCall('massu_knowledge_search', { query: 'w' }, db, 'ensure-fresh')))
      .not.toContain(BANNER);
    db.close();

    db = makeKnowledgeDb(true);
    expect(textOf(handleKnowledgeToolCall('massu_knowledge_nope', {}, db, 'ensure-fresh'))).not.toContain(BANNER);
    expect(existsSync(failureLog)).toBe(false);
  });
});

describe('P3 — the rebuild is a declared decision, not a side effect of dispatching', () => {
  it("'use-existing' performs NO rebuild — asserted by operation count", () => {
    // Operation count, not elapsed time: a timing assertion here would assert the machine
    // and fail in both directions (G27). Counting indexIfStale invocations IS the property.
    db = makeKnowledgeDb(true);
    handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'use-existing');
    expect(indexIfStaleCalls).toHaveBeenCalledTimes(0);
  });

  it("POSITIVE CONTROL: 'ensure-fresh' on the same input DOES rebuild", () => {
    // Without this, "0 calls" is equally consistent with a mock that is never reachable.
    db = makeKnowledgeDb(true);
    handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'ensure-fresh');
    expect(indexIfStaleCalls).toHaveBeenCalledTimes(1);
  });

  it("'use-existing' still answers from the index it has", () => {
    db = makeKnowledgeDb(true);
    const out = textOf(handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'use-existing'));
    expect(out).toContain('widget');
    expect(out).not.toContain(BANNER);
  });

  it("a failing index cannot even be reached under 'use-existing'", () => {
    // The declaration is load-bearing: the branch that could throw is not entered at all,
    // so there is nothing to swallow and nothing to warn about.
    db = makeKnowledgeDb(true);
    indexShouldThrow = true;
    const out = textOf(handleKnowledgeToolCall('massu_knowledge_search', { query: 'widget' }, db, 'use-existing'));
    expect(out).not.toContain(BANNER);
    expect(existsSync(failureLog)).toBe(false);
    expect(indexIfStaleCalls).toHaveBeenCalledTimes(0);
  });
});

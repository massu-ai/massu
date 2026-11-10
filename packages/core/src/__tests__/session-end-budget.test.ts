// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The session-end hook runs in the BACKGROUND (`async: true`) at the end of every turn,
 * so it must bound and serialize itself. Each case below pins one part of that, and each
 * was RED against the code it replaced:
 *
 *   1. drainSyncQueue honours a deadline, and DEFERS (retry_count untouched) rather than
 *      attempting an item it has no time for. RED before: no deadline parameter existed.
 *   2. A failed drain does not queue a SECOND copy of the item. RED before: syncToCloud
 *      re-enqueued the payload while the drain also bumped the original's retry_count.
 *   3. storeSessionCost keeps ONE row per session and accumulates. RED before: a plain
 *      INSERT hit `session_id UNIQUE` on the second turn and the hook swallowed it, so a
 *      576M-token session stored 0 tokens.
 *   4. A half-written final transcript line is not counted past. RED before: the cursor
 *      moved over it and the line was never read again.
 *   5. The memory_meta lease is atomic and releasable only by its holder.
 *   6. Two runs of one session never overlap: the second hands off and the first reruns.
 *   7. End to end, the BUILT hook records full-session cost over a growing transcript.
 *   (massu init emitting `async: true`: init-background-hooks.test.ts — it needs the
 *   real config module, which this file mocks.)
 *
 * Plan: plan-2026-07-23-hook-latency-silent-loss-fixes, P3 (operator decision 2026-11-09).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

vi.mock('../config.ts', () => ({
  getConfig: vi.fn(() => ({
    cloud: {
      enabled: true,
      apiKey: 'ms_live_test_key_12345', // gitleaks:allow — fake fixture key
      endpoint: 'https://test.invalid/functions/v1',
      sync: { memory: true, analytics: true, audit: true },
    },
    toolPrefix: 'massu',
    project: { name: 'test', root: '/tmp/test' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: {} },
    domains: [],
    rules: [],
  })),
  getProjectRoot: vi.fn(() => '/tmp/test'),
  getResolvedPaths: vi.fn(() => ({ memoryDbPath: ':memory:' })),
  resetConfig: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { drainSyncQueue, MIN_SYNC_ATTEMPT_MS } = await import('../cloud-sync.ts');
const { storeSessionCost } = await import('../cost-tracker.ts');
const { parseTranscriptFrom } = await import('../transcript-parser.ts');
const { tryAcquireMetaLease, releaseMetaLease, getMemoryMeta } = await import('../memory-db.ts');
const { runCoalesced } = await import('../hooks/session-end.ts');
const { repriceStoredSessions } = await import('../cost-reprice.ts');

function queueDb(n: number): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pending_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
  const ins = db.prepare('INSERT INTO pending_sync (payload) VALUES (?)');
  for (let i = 0; i < n; i++) ins.run(JSON.stringify({ sessions: [{ local_session_id: `s${i}`, summary: 'x', ended_at: 'now' }] }));
  return db;
}
const rows = (db: Database.Database) =>
  db.prepare('SELECT id, retry_count FROM pending_sync ORDER BY id').all() as Array<{ id: number; retry_count: number }>;

function metaDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

describe('drainSyncQueue under a deadline', () => {
  beforeEach(() => mockFetch.mockReset());

  it('attempts while the floor is met, then DEFERS the rest with retry_count untouched, and never duplicates', async () => {
    const db = queueDb(5);
    // Each attempt takes ~600 ms and is refused (4xx, not retried).
    mockFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 600));
      return { ok: false, status: 401, statusText: 'Unauthorized' };
    });
    const res = await drainSyncQueue(db, Date.now() + MIN_SYNC_ATTEMPT_MS + 900);
    expect(res.attempted).toBe(2);
    expect(res.deferred).toBe(3);
    const after = rows(db);
    expect(after).toHaveLength(5); // the old code queued a second copy of each failure: 7
    expect(after.map((r) => r.retry_count)).toEqual([1, 1, 0, 0, 0]);
    db.close();
  });

  it('a sub-floor budget attempts NOTHING and changes NOTHING', async () => {
    const db = queueDb(3);
    const before = rows(db);
    const res = await drainSyncQueue(db, Date.now() + MIN_SYNC_ATTEMPT_MS - 1000);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res).toEqual({ attempted: 0, deferred: 3 });
    expect(rows(db)).toEqual(before);
    db.close();
  });

  it('control: with no deadline every item is attempted (the deadline is what defers)', async () => {
    const db = queueDb(3);
    mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const res = await drainSyncQueue(db);
    expect(res).toEqual({ attempted: 3, deferred: 0 });
    expect(rows(db)).toHaveLength(3);
    db.close();
  });
});

function costDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE session_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL DEFAULT 'my-project', input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0.0, model TEXT,
    duration_minutes REAL NOT NULL DEFAULT 0.0, tool_calls INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    cost_status TEXT NOT NULL DEFAULT 'unknown', unpriced_models TEXT NOT NULL DEFAULT '',
    priced_responses INTEGER NOT NULL DEFAULT 0, unpriced_responses INTEGER NOT NULL DEFAULT 0,
    pricing_version INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}
const costSlice = (n: number) => ({
  inputTokens: n, outputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: n / 10,
  pricedResponses: 1, unpricedResponses: 0, unpricedModels: [], model: 'm', lastMessageId: null,
});

describe('storeSessionCost keeps one row per session', () => {
  it("'add' accumulates onto the single row; a second turn no longer throws", () => {
    const db = costDb();
    storeSessionCost(db, 's', costSlice(10), 'replace');
    storeSessionCost(db, 's', costSlice(5), 'add');
    const r = db.prepare('SELECT COUNT(*) n, SUM(total_tokens) t, SUM(estimated_cost_usd) c FROM session_costs').get() as { n: number; t: number; c: number };
    expect(r).toEqual({ n: 1, t: 30, c: 1.5 });
    db.close();
  });

  it("'replace' overwrites (repairs a row the old code froze at its first turn)", () => {
    const db = costDb();
    storeSessionCost(db, 's', costSlice(0));
    storeSessionCost(db, 's', costSlice(100), 'replace');
    expect(db.prepare('SELECT total_tokens t FROM session_costs').get()).toEqual({ t: 200 });
    db.close();
  });
});

describe('repriceStoredSessions', () => {
  const line = (id: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', id, model: 'claude-sonnet-4-6', content: [],
    usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + '\n';

  it('reprices rows that have a transcript, marks the rest unknown, skips busy ones, and survives a bad transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reprice-'));
    try {
      const db = costDb();
      for (const sid of ['has', 'gone', 'busy', 'broken']) {
        db.prepare('INSERT INTO session_costs (session_id) VALUES (?)').run(sid); // old row: version 0, 0 tokens
      }
      writeFileSync(join(dir, 'has.jsonl'), line('a') + line('a') + line('b')); // 2 responses, one repeated
      tryAcquireMetaLease(db, 'session_end_lease:busy', 600);
      const res = await repriceStoredSessions(db, {
        findTranscript: (sid) => (sid === 'has' ? join(dir, 'has.jsonl') : sid === 'broken' ? join(dir, 'missing-dir', 'x.jsonl') : null),
      });
      expect(res).toEqual({ repriced: 1, markedUnknown: 1, busy: 1, failed: 1, remaining: 2 });
      const rows = Object.fromEntries((db.prepare('SELECT session_id, cost_status, input_tokens, estimated_cost_usd FROM session_costs').all() as Array<Record<string, unknown>>)
        .map((r) => [r.session_id, r]));
      expect(rows.has).toMatchObject({ cost_status: 'priced', input_tokens: 2_000_000 });
      expect(rows.has.estimated_cost_usd as number).toBeCloseTo(6, 6);
      expect(rows.gone).toMatchObject({ cost_status: 'unknown' });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseTranscriptFrom and a line still being written', () => {
  it('does not count a final unparseable line, and reads it whole next time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-partial-'));
    try {
      const f = join(dir, 't.jsonl');
      const user = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
      writeFileSync(f, `${user('a')}\n${user('b')}\n{"type":"user","mess`);
      const first = await parseTranscriptFrom(f, 0);
      expect(first.totalLines).toBe(2);
      writeFileSync(f, `${user('a')}\n${user('b')}\n${user('c')}\n`);
      const second = await parseTranscriptFrom(f, first.totalLines);
      expect(second.entries).toHaveLength(1);
      expect(second.totalLines).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory_meta lease', () => {
  it('is won once, refused while live, retaken after expiry, and released only by its holder', () => {
    const db = metaDb();
    expect(tryAcquireMetaLease(db, 'k', 60, 1000)).toBe(true);
    expect(tryAcquireMetaLease(db, 'k', 60, 1001)).toBe(false);
    expect(tryAcquireMetaLease(db, 'k', 60, 1061)).toBe(true); // expired at 1060
    db.prepare("UPDATE memory_meta SET value = '999999999:99999999999' WHERE key = 'k'").run();
    releaseMetaLease(db, 'k'); // not ours
    expect(getMemoryMeta(db, 'k')).toBe('999999999:99999999999');
    db.prepare("UPDATE memory_meta SET value = ? WHERE key = 'k'").run(`${process.pid}:99999999999`);
    releaseMetaLease(db, 'k');
    expect(getMemoryMeta(db, 'k')).toBe('');
    db.close();
  });
});

describe('runCoalesced', () => {
  it('a second run of the same session hands off, and the first runs once more', async () => {
    const db = metaDb();
    let outerRuns = 0;
    let innerRuns = 0;
    let handOff: string | undefined;
    const outcome = await runCoalesced(db, 'sess', 1000, async () => {
      outerRuns++;
      if (outerRuns === 1) {
        handOff = await runCoalesced(db, 'sess', 1000, async () => { innerRuns++; });
      }
    });
    expect(handOff).toBe('handed-off');
    expect(innerRuns).toBe(0);
    expect(outerRuns).toBe(2);
    expect(outcome).toBe('ran');
    expect(getMemoryMeta(db, 'session_end_lease:sess')).toBe('');
    db.close();
  });

  it('another session is not blocked by this one', async () => {
    const db = metaDb();
    let other: string | undefined;
    await runCoalesced(db, 'a', 1000, async () => {
      other = await runCoalesced(db, 'b', 1000, async () => {});
    });
    expect(other).toBe('ran');
    db.close();
  });
});

describe('the built session-end hook, end to end', () => {
  const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const HOOK = join(CORE, 'dist', 'hooks', 'session-end.js');
  let work: string;
  afterEach(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it('records FULL-session cost across turns of a growing transcript', () => {
    expect(existsSync(HOOK), `${HOOK} missing — run npm run build:hooks`).toBe(true);
    work = mkdtempSync(join(tmpdir(), 'session-end-e2e-'));
    const proj = join(work, 'proj');
    mkdirSync(join(proj, '.massu'), { recursive: true });
    mkdirSync(join(work, 'home'));
    writeFileSync(join(proj, 'massu.config.yaml'), 'project:\n  name: e2e\n  root: .\ncloud:\n  enabled: false\n');
    const t = join(work, 't.jsonl');
    const turn = (n: number) => JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', id: `msg_${n}`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: `turn ${n}` }],
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + '\n';
    const env = { ...process.env, HOME: join(work, 'home'), CLAUDE_PROJECT_DIR: proj, MASSU_SESSION_END_BUDGET_MS: '20000' };
    delete env.MASSU_API_KEY;
    const runHook = () => spawnSync(process.execPath, [HOOK], {
      cwd: proj, env, encoding: 'utf-8', timeout: 60_000,
      input: JSON.stringify({ session_id: 'e2e-sess', transcript_path: t, cwd: proj, hook_event_name: 'Stop' }),
    });

    // Response 2 is written as two lines, and the first run ends between them.
    writeFileSync(t, turn(1) + turn(2));
    expect(runHook().status).toBe(0);
    appendFileSync(t, turn(2) + turn(3));
    expect(runHook().status).toBe(0);

    const db = new Database(join(proj, '.massu', 'memory.db'), { readonly: true });
    try {
      const r = db.prepare("SELECT COUNT(*) n, SUM(input_tokens) i, SUM(output_tokens) o, MAX(cost_status) s, SUM(estimated_cost_usd) c FROM session_costs WHERE session_id = 'e2e-sess'").get() as Record<string, number | string>;
      expect(r).toMatchObject({ n: 1, i: 300, o: 30, s: 'priced' });
      expect(r.c as number).toBeCloseTo((300 * 3 + 30 * 15) / 1_000_000, 12);
    } finally {
      db.close();
    }
  });
});

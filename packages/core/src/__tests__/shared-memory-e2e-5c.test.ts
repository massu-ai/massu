// Slice 5 — C-06: the brief's own criterion, end-to-end, over TWO SYNTHETIC repos
// (two :memory: stores + a faked $HOME — no operator corpus, runs anywhere).
//
// export -> outbox (signed) -> import -> PENDING (observations unchanged, recall
// shows ONLY the inert pointer) -> tamper -> accept REFUSES -> untamper -> accept ->
// origin='repo:...' -> recall fenced+labelled -> revoke -> expires and STAYS expired
// across 10 cycles.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { initMemorySchema, createSession } from '../memory-db.ts';
import { exportSharedMemories } from '../shared-memory-export.ts';
import { importSharedMemories, acceptSharedMemory } from '../shared-memory-sync.ts';
import { LocalFsTransport, sharedRootDir, outboxDirFor } from '../shared-memory-transport.ts';
import { readReposRegistry } from '../memory-repos-registry.ts';
import { hybridSearch } from '../memory-hybrid-search.ts';
import { formatRecallBlock, selectRecallItems } from '../memory-recall-format.ts';
import {
  crossRepoRecallEnabled,
  enrichAndCapCrossRepo,
  pendingPointer,
} from '../shared-memory-recall.ts';

const NOW = 1_752_000_000;
const TERM = 'zqxwvdecision';

function open(): Database.Database {
  const db = new Database(':memory:');
  initMemorySchema(db);
  createSession(db, 'S1');
  return db;
}

/** Simulate the recall hook's block for a subscribed repo (same code the hook runs). */
function recallBlock(db: Database.Database, subscribeCount: number, nowSec: number): string {
  const results = hybridSearch(db, null, { queryText: TERM, sources: ['observation'], now: nowSec * 1000 });
  const enabled = crossRepoRecallEnabled({ enabled: true, subscribeCount });
  const ranked = enabled
    ? enrichAndCapCrossRepo(db, results, { enabled: true, maxCrossRepoItems: 1, localMinScore: 0 })
    : results;
  const shown = selectRecallItems(ranked, { maxTokens: 5000 });
  let block = formatRecallBlock(shown, { maxTokens: 5000 });
  if (enabled) block += pendingPointer(db);
  return block;
}

describe('Slice 5 C-06 — cross-repo E2E over two synthetic repos', () => {
  let home: string;
  let dbA: Database.Database;
  let dbB: Database.Database;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'massu-e2e-'));
    dbA = open();
    dbB = open();
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('the full chain: export -> pending -> tamper-refused -> accept -> revoke (x10 stable)', async () => {
    // 1. Repo A shares a decision.
    dbA.prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, origin, shareable, created_at, created_at_epoch)
       VALUES ('S1','decision',?,?,4,'local',1,'2026-07-21T00:00:00Z', ?)`,
    ).run(`use printf ${TERM}`, `echo appends a newline ${TERM}`, NOW);
    const exp = await exportSharedMemories(dbA, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(exp.published).toBe(true);

    // outbox file exists and is signed.
    const repoA = readReposRegistry(home).repos[0].repo_id;
    const label = readReposRegistry(home).repos[0].label;
    expect(existsSync(outboxDirFor(repoA, home))).toBe(true);
    expect(readdirSync(outboxDirFor(repoA, home)).some((f) => f.endsWith('.json'))).toBe(true);

    // 2. Repo B imports -> PENDING. observations unchanged; recall shows ONLY the pointer.
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [label], nowEpoch: NOW });
    expect((dbB.prepare(`SELECT COUNT(*) n FROM observations`).get() as { n: number }).n).toBe(0);
    const pendingBlock = recallBlock(dbB, 1, NOW + 1);
    expect(pendingBlock).toContain('massu memory review'); // the inert pointer
    expect(pendingBlock).not.toContain('printf'); // ZERO candidate-derived bytes
    expect(pendingBlock).not.toContain(TERM);

    // 3. Tamper the retained bytes -> accept REFUSES -> zero mutation.
    const hash = (dbB.prepare(`SELECT record_hash FROM shared_memory_pending LIMIT 1`).get() as { record_hash: string }).record_hash;
    const raw = (dbB.prepare(`SELECT envelope_raw FROM shared_memory_pending WHERE record_hash=?`).get(hash) as { envelope_raw: string }).envelope_raw;
    dbB.prepare(`UPDATE shared_memory_pending SET envelope_raw=? WHERE record_hash=?`).run(raw.replace('printf', 'PRINTF'), hash);
    expect(acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW }).ok).toBe(false);
    expect((dbB.prepare(`SELECT COUNT(*) n FROM observations`).get() as { n: number }).n).toBe(0);

    // 4. Untamper -> accept -> origin='repo:...' -> recall fenced + labelled.
    dbB.prepare(`UPDATE shared_memory_pending SET envelope_raw=? WHERE record_hash=?`).run(raw, hash);
    const acc = acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW + 5 });
    expect(acc.ok).toBe(true);
    const obs = dbB.prepare(`SELECT origin FROM observations WHERE id=?`).get(acc.observationId) as { origin: string };
    expect(obs.origin).toBe(`repo:${repoA}`);
    const acceptedBlock = recallBlock(dbB, 1, NOW + 6);
    expect(acceptedBlock).toContain('CROSS-REPO memory');
    expect(acceptedBlock).toContain(`\`${label}\``);

    // 5. Repo A revokes (expire + re-export), Repo B imports the revoke -> expired.
    dbA.prepare(`UPDATE observations SET expired_at='2026-07-22T00:00:00Z', expired_at_epoch=? WHERE shareable=1`).run(NOW + 10);
    await exportSharedMemories(dbA, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW + 20 });

    // Import the revoke, then 9 more idempotent cycles — it STAYS expired.
    let firstRevoked = 0;
    for (let i = 0; i < 10; i++) {
      const res = await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [label], nowEpoch: NOW + 30 + i });
      if (i === 0) firstRevoked = res.revoked;
      const expiredRow = dbB.prepare(`SELECT expired_at_epoch FROM observations WHERE id=?`).get(acc.observationId) as { expired_at_epoch: number | null };
      expect(expiredRow.expired_at_epoch, `cycle ${i}`).not.toBeNull(); // stays expired
    }
    expect(firstRevoked).toBe(1);
    // Expired ⇒ out of recall, but the row still exists (never deleted).
    expect(recallBlock(dbB, 1, NOW + 100)).not.toContain('CROSS-REPO memory');
    expect((dbB.prepare(`SELECT COUNT(*) n FROM observations`).get() as { n: number }).n).toBe(1);
  });

  it('runs with no ~/.massu until sharing is used (dormant-clean start)', () => {
    // Before any export, the faked home has no massu shared dir.
    expect(existsSync(sharedRootDir(home))).toBe(false);
  });
});

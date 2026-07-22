// Slice 5 — B-04/B-05/B-07: the trust-critical import → PENDING → accept core.
//
// The two laws under test:
//   1. IMPORT MATERIALIZES ONLY A PENDING ROW — never observations/FTS/recall.
//   2. ACCEPT RE-VERIFIES the retained envelope bytes (D2). A tampered byte is
//      refused with ZERO mutation; a claim is never authority.
// Plus B-07 revocation (accepted row expires, stays out of recall, never deleted).
//
// Topology: two :memory: stores sharing ONE faked $HOME (the real single-machine
// LocalFsTransport case — same ~/.massu keys, registry, outbox).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { initMemorySchema, createSession, getMemoryMeta, setMemoryMeta } from '../memory-db.ts';
import { exportSharedMemories } from '../shared-memory-export.ts';
import {
  importSharedMemories,
  acceptSharedMemory,
  refuseSharedMemory,
  listPendingSharedMemories,
} from '../shared-memory-sync.ts';
import { LocalFsTransport } from '../shared-memory-transport.ts';
import { readReposRegistry } from '../memory-repos-registry.ts';
import {
  signSharedMemoryEnvelope,
  ensureLocalShareKeypair,
} from '../security/local-share-signer.ts';
import { hashSharedMemoryRecord, SHARED_MEMORY_KIND, type SharedMemoryRecord } from '../shared-memory-envelope.ts';
import { hybridSearch } from '../memory-hybrid-search.ts';

const NOW = 1_752_000_000;
const TERM = 'zqxwvutoken'; // a distinctive term to probe recall unambiguously

function openStore(): Database.Database {
  const db = new Database(':memory:');
  initMemorySchema(db);
  createSession(db, 'S1');
  return db;
}

function seedDecision(db: Database.Database, detail: string): number {
  const r = db
    .prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, origin, shareable, created_at, created_at_epoch)
       VALUES ('S1','decision', ?, ?, 4, 'local', 1, '2026-07-21T00:00:00Z', ?)`,
    )
    .run(`decision ${TERM}`, detail, NOW);
  return Number(r.lastInsertRowid);
}

function repoIdOf(db: Database.Database): string {
  return (db.prepare(`SELECT value FROM memory_meta WHERE key='repo_id'`).get() as { value: string }).value;
}

function recallCount(db: Database.Database): number {
  return hybridSearch(db, null, { queryText: TERM, sources: ['observation'], now: (NOW + 1) * 1000 }).length;
}

describe('Slice 5 B-04/B-05/B-07 — import → pending → accept', () => {
  let home: string;
  let dbA: Database.Database; // exporter
  let dbB: Database.Database; // importer
  let originLabel: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'massu-sync-'));
    dbA = openStore();
    dbB = openStore();
    // Repo A shares a decision → outbox + self-registers in ~/.massu/repos.json.
    seedDecision(dbA, `never use echo for env vars ${TERM}`);
    const exp = await exportSharedMemories(dbA, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(exp.published).toBe(true);
    originLabel = readReposRegistry(home).repos.find((r) => r.repo_id === repoIdOf(dbA))!.label;
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('B-04: import lands a PENDING row and NOTHING in observations/recall', async () => {
    const res = await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    expect(res.imported).toBe(1);
    expect(db_count(dbB, 'shared_memory_pending')).toBe(1);
    // observations has ZERO cross-repo rows, and recall cannot see the imported text.
    expect(db_count(dbB, "observations WHERE origin LIKE 'repo:%'")).toBe(0);
    expect(recallCount(dbB)).toBe(0);
  });

  it('B-04: import is idempotent by record_hash (re-import skips)', async () => {
    const tp = new LocalFsTransport(home);
    await importSharedMemories(dbB, tp, { home, subscribe: [originLabel], nowEpoch: NOW });
    // reset cursor so fetchSince re-serves the same envelope
    setMemoryMeta(dbB, `shared_cursor:${repoIdOf(dbA)}`, '0');
    const res2 = await importSharedMemories(dbB, tp, { home, subscribe: [originLabel], nowEpoch: NOW });
    expect(res2.imported).toBe(0);
    expect(res2.skipped).toBe(1);
    expect(db_count(dbB, 'shared_memory_pending')).toBe(1);
  });

  it('B-05: accept RE-VERIFIES and materializes origin=repo:<id>, recall-visible', async () => {
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const hash = pendingHash(dbB);
    const res = acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW });
    expect(res.ok).toBe(true);
    const obs = dbB.prepare(`SELECT origin, shareable FROM observations WHERE id = ?`).get(res.observationId) as {
      origin: string;
      shareable: number;
    };
    expect(obs.origin).toBe(`repo:${repoIdOf(dbA)}`);
    expect(obs.shareable).toBe(0); // re-export forbidden
    expect(recallCount(dbB)).toBe(1);
  });

  it('B-05 (D2): a tampered envelope byte is REFUSED at accept with ZERO mutation', async () => {
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const hash = pendingHash(dbB);
    // Flip a byte INSIDE the retained signed bytes (the term in the detail).
    const raw = (dbB.prepare(`SELECT envelope_raw FROM shared_memory_pending WHERE record_hash=?`).get(hash) as { envelope_raw: string }).envelope_raw;
    const tampered = raw.replace(TERM, TERM.replace('z', 'Z'));
    expect(tampered).not.toBe(raw);
    dbB.prepare(`UPDATE shared_memory_pending SET envelope_raw=? WHERE record_hash=?`).run(tampered, hash);

    const res = acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/reverify|record_hash_mismatch|not_in_signed/);
    expect(db_count(dbB, "observations WHERE origin LIKE 'repo:%'")).toBe(0); // zero mutation

    // Untamper → accept now succeeds (the store is the arbiter, the bytes are checked live).
    dbB.prepare(`UPDATE shared_memory_pending SET envelope_raw=? WHERE record_hash=?`).run(raw, hash);
    expect(acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW }).ok).toBe(true);
  });

  it('B-05: accept is idempotent (second accept is a no-op)', async () => {
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const hash = pendingHash(dbB);
    expect(acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW }).ok).toBe(true);
    const again = acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW });
    expect(again.ok).toBe(true);
    expect(again.alreadyAccepted).toBe(true);
    expect(db_count(dbB, "observations WHERE origin LIKE 'repo:%'")).toBe(1); // not duplicated
  });

  it('B-05: an unknown record type is REFUSED at accept, never coerced', async () => {
    ensureLocalShareKeypair(home);
    // Craft a signed envelope whose record has a type OUTSIDE the CHECK vocabulary.
    const base: Omit<SharedMemoryRecord, 'record_hash'> = {
      type: 'evil_type', title: `t ${TERM}`, detail: 'body', importance: 3, created_at_epoch: NOW, superseded_by_hash: null,
    };
    const rec: SharedMemoryRecord = { ...base, record_hash: hashSharedMemoryRecord(base) };
    const env = signSharedMemoryEnvelope(
      {
        kind: SHARED_MEMORY_KIND, origin_repo_id: repoIdOf(dbA), origin_repo_label: originLabel, seq: 99,
        issued_at: '2026-07-21T00:00:00Z', records_json: JSON.stringify([rec]), revokes_json: '[]',
      },
      home,
    );
    await new LocalFsTransport(home).publish(env);
    const res = await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    expect(res.imported).toBe(2); // the real decision + the evil one both land as pending
    const acc = acceptSharedMemory(dbB, rec.record_hash, { home, nowEpoch: NOW });
    expect(acc.ok).toBe(false);
    expect(acc.reason).toBe('unknown_type');
    expect(db_count(dbB, "observations WHERE origin LIKE 'repo:%'")).toBe(0);
  });

  it('B-06: refuse marks the pending row and blocks a later accept', async () => {
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const hash = pendingHash(dbB);
    expect(refuseSharedMemory(dbB, hash, { nowEpoch: NOW }).ok).toBe(true);
    expect(listPendingSharedMemories(dbB, { home })).toHaveLength(0); // gone from review
    expect(acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW }).ok).toBe(false);
  });

  it('B-06: review is sanitized and live-verified', async () => {
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const [view] = listPendingSharedMemories(dbB, { home });
    expect(view.signature_valid).toBe(true);
    expect(view.origin_repo_label).toBe(originLabel);
  });

  it('B-07: revoke expires an accepted cross-repo memory (out of recall, still present, never deleted)', async () => {
    // B imports + accepts.
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const hash = pendingHash(dbB);
    expect(acceptSharedMemory(dbB, hash, { home, nowEpoch: NOW }).ok).toBe(true);
    expect(recallCount(dbB)).toBe(1);

    // Repo A expires the decision, then re-exports → emits a revoke.
    dbA.prepare(`UPDATE observations SET expired_at='2026-07-22T00:00:00Z', expired_at_epoch=? WHERE shareable=1`).run(NOW + 10);
    const exp = await exportSharedMemories(dbA, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW + 20 });
    expect(exp.published).toBe(true);

    // B imports the revoke → the accepted row expires; recall no longer sees it; row still present.
    const res = await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW + 30 });
    expect(res.revoked).toBe(1);
    expect(recallCount(dbB)).toBe(0);
    expect(db_count(dbB, "observations WHERE origin LIKE 'repo:%'")).toBe(1); // expired, not deleted
  });

  it('B-10 actor provenance: sweep events are actor=hook, CLI accept is actor=human', async () => {
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
    const importedActor = (dbB.prepare(`SELECT actor FROM audit_log WHERE event_type='shared_memory_imported' LIMIT 1`).get() as { actor: string }).actor;
    expect(importedActor).toBe('hook'); // automated session-end sweep — no human present
    acceptSharedMemory(dbB, pendingHash(dbB), { home, nowEpoch: NOW });
    const acceptedActor = (dbB.prepare(`SELECT actor FROM audit_log WHERE event_type='shared_memory_accepted' LIMIT 1`).get() as { actor: string }).actor;
    expect(acceptedActor).toBe('human'); // CLI-only human act
  });

  it('dormant: subscribe=[] imports nothing', async () => {
    const res = await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [], nowEpoch: NOW });
    expect(res).toEqual({ imported: 0, dropped: 0, revoked: 0, skipped: 0 });
    expect(db_count(dbB, 'shared_memory_pending')).toBe(0);
  });
});

function db_count(db: Database.Database, tableAndWhere: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${tableAndWhere}`).get() as { n: number }).n;
}
function pendingHash(db: Database.Database): string {
  return (db.prepare(`SELECT record_hash FROM shared_memory_pending WHERE accepted_at_epoch IS NULL LIMIT 1`).get() as { record_hash: string }).record_hash;
}

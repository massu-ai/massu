// Slice 5 — B-06: the `massu memory review|accept|refuse|share|trust` CLI, the
// human's cross-repo control surface (the operator's safety valve).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { initMemorySchema, createSession } from '../memory-db.ts';
import { exportSharedMemories } from '../shared-memory-export.ts';
import { importSharedMemories } from '../shared-memory-sync.ts';
import { LocalFsTransport } from '../shared-memory-transport.ts';
import { readReposRegistry } from '../memory-repos-registry.ts';
import { getSharedPin } from '../memory-repo-identity.ts';
import { runMemoryShareCli } from '../commands/memory-share-cli.ts';

const NOW = 1_752_000_000;

function open(): Database.Database {
  const db = new Database(':memory:');
  initMemorySchema(db);
  createSession(db, 'S1');
  return db;
}

describe('Slice 5 B-06 — memory share/review/accept/refuse/trust CLI', () => {
  let home: string;
  let dbA: Database.Database;
  let dbB: Database.Database;
  let originLabel: string;
  let originRepoId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'massu-cli-'));
    dbA = open();
    dbB = open();
    dbA.prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, origin, shareable, created_at, created_at_epoch)
       VALUES ('S1','decision','use printf','echo appends a newline', 4, 'local', 1, '2026-07-21T00:00:00Z', ?)`,
    ).run(NOW);
    await exportSharedMemories(dbA, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    const entry = readReposRegistry(home).repos[0];
    originLabel = entry.label;
    originRepoId = entry.repo_id;
    await importSharedMemories(dbB, new LocalFsTransport(home), { home, subscribe: [originLabel], nowEpoch: NOW });
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(home, { recursive: true, force: true });
  });

  function hash(db: Database.Database): string {
    return (db.prepare(`SELECT record_hash FROM shared_memory_pending LIMIT 1`).get() as { record_hash: string }).record_hash;
  }

  it('review lists a pending item with accept/refuse commands', async () => {
    const r = await runMemoryShareCli('review', [], { db: dbB, home });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(originLabel);
    expect(r.output).toContain('massu memory accept');
  });

  it('accept materializes the cross-repo memory', async () => {
    const r = await runMemoryShareCli('accept', [hash(dbB)], { db: dbB, home });
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/cross-repo memory/i);
    expect((dbB.prepare(`SELECT COUNT(*) n FROM observations WHERE origin LIKE 'repo:%'`).get() as { n: number }).n).toBe(1);
  });

  it('refuse blocks a later accept', async () => {
    const h = hash(dbB);
    expect((await runMemoryShareCli('refuse', [h], { db: dbB, home })).exitCode).toBe(0);
    expect((await runMemoryShareCli('accept', [h], { db: dbB, home })).exitCode).toBe(1);
  });

  it('accept rejects a malformed hash', async () => {
    expect((await runMemoryShareCli('accept', ['not-a-hash'], { db: dbB, home })).exitCode).toBe(1);
  });

  it('share marks a LOCAL observation shareable, refuses an imported one', async () => {
    // a fresh local decision (not yet shareable)
    const id = Number(
      dbB
        .prepare(
          `INSERT INTO observations (session_id, type, title, detail, importance, origin, created_at, created_at_epoch)
           VALUES ('S1','decision','local one','body',3,'local','2026-07-21T00:00:00Z', ?)`,
        )
        .run(NOW).lastInsertRowid,
    );
    const r = await runMemoryShareCli('share', [String(id)], { db: dbB, home });
    expect(r.exitCode).toBe(0);
    expect((dbB.prepare(`SELECT shareable FROM observations WHERE id=?`).get(id) as { shareable: number }).shareable).toBe(1);

    // an imported row (origin repo:) cannot be re-shared
    const importedId = Number(
      dbB
        .prepare(
          `INSERT INTO observations (session_id, type, title, detail, importance, origin, created_at, created_at_epoch)
           VALUES ('S1','decision','foreign','body',3,'repo:${originRepoId}','2026-07-21T00:00:00Z', ?)`,
        )
        .run(NOW).lastInsertRowid,
    );
    const r2 = await runMemoryShareCli('share', [String(importedId)], { db: dbB, home });
    expect(r2.exitCode).toBe(1);
    expect((dbB.prepare(`SELECT shareable FROM observations WHERE id=?`).get(importedId) as { shareable: number }).shareable).toBe(0);
  });

  it('trust re-pins an origin repo fingerprint (explicit human act)', async () => {
    const fp = 'a'.repeat(64);
    const r = await runMemoryShareCli('trust', [originLabel, '--fingerprint', fp], { db: dbB, home });
    expect(r.exitCode).toBe(0);
    expect(getSharedPin(dbB, originRepoId)).toBe(fp);
  });

  it('an unknown subcommand exits 1 with usage', async () => {
    expect((await runMemoryShareCli('bogus', [], { db: dbB, home })).exitCode).toBe(1);
  });

  it('S-5: purge --shared EXPIRES (never deletes) pending + accepted cross-repo rows', async () => {
    // accept one, leave one pending
    const h1 = hash(dbB);
    expect((await runMemoryShareCli('accept', [h1], { db: dbB, home })).exitCode).toBe(0);
    const pendingBefore = (dbB.prepare(`SELECT COUNT(*) n FROM shared_memory_pending`).get() as { n: number }).n;
    const acceptedBefore = (dbB.prepare(`SELECT COUNT(*) n FROM observations WHERE origin LIKE 'repo:%'`).get() as { n: number }).n;
    expect(acceptedBefore).toBe(1);

    // bare purge is refused (needs the explicit flag)
    expect((await runMemoryShareCli('purge', [], { db: dbB, home })).exitCode).toBe(1);

    expect((await runMemoryShareCli('purge', ['--shared'], { db: dbB, home })).exitCode).toBe(0);
    // rows are EXPIRED, not deleted — same count, but out of recall.
    expect((dbB.prepare(`SELECT COUNT(*) n FROM shared_memory_pending`).get() as { n: number }).n).toBe(pendingBefore);
    expect((dbB.prepare(`SELECT COUNT(*) n FROM observations WHERE origin LIKE 'repo:%'`).get() as { n: number }).n).toBe(1);
    expect((dbB.prepare(`SELECT expired_at_epoch FROM observations WHERE origin LIKE 'repo:%'`).get() as { expired_at_epoch: number | null }).expired_at_epoch).not.toBeNull();
  });
});

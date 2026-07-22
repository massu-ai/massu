// Slice 5 — B-02/B-03/B-09/B-12: the fail-closed export path + the transport seam.
//
// Export is the trust boundary a decision LEAVES through. These assert the four
// fail-closed guarantees on the filesystem (not in prose):
//   • a secret / a $HOME path / an imported row is REFUSED (no outbox file);
//   • the happy-path envelope verifies through the REAL verifier and is 0600;
//   • a repo_id can never become a path component unless it is UUID-shaped;
//   • the store is backed up before the first write, and an unwritable backup
//     refuses the export and writes nothing;
//   • a dormant install (share off) mints no key, no registry, no inbox.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { initMemorySchema, createSession } from '../memory-db.ts';
import { exportSharedMemories } from '../shared-memory-export.ts';
import {
  LocalFsTransport,
  outboxDirFor,
  sharedRootDir,
  REPO_ID_PATH_RE,
} from '../shared-memory-transport.ts';
import { verifyLocalShareEnvelope, } from '../security/local-share-verifier.ts';
import { localSharePubkeyFingerprint } from '../security/local-share-signer.ts';
import type { SharedMemoryEnvelope } from '../shared-memory-envelope.ts';

const NOW = 1_752_000_000;

function insertShareable(
  db: Database.Database,
  o: { title: string; detail: string; origin?: string; type?: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, origin, shareable, created_at, created_at_epoch)
       VALUES ('S1', ?, ?, ?, 4, ?, 1, '2026-07-21T00:00:00Z', ?)`,
    )
    .run(o.type ?? 'decision', o.title, o.detail, o.origin ?? 'local', NOW);
  return Number(r.lastInsertRowid);
}

describe('Slice 5 B-02/B-09/B-12 — fail-closed export', () => {
  let db: Database.Database;
  let home: string;
  beforeEach(() => {
    db = new Database(':memory:');
    initMemorySchema(db);
    createSession(db, 'S1');
    home = mkdtempSync(join(tmpdir(), 'massu-share-home-'));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('B-02 happy path: a clean decision exports as a signed envelope that verifies through the REAL verifier', async () => {
    insertShareable(db, { title: 'Use printf not echo', detail: 'echo appends a newline for Vercel env vars' });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(res.published).toBe(true);
    expect(res.exported).toBe(1);

    const dir = outboxDirFor(res_repoId(db), home);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const env = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) as SharedMemoryEnvelope;
    const verdict = verifyLocalShareEnvelope(env, localSharePubkeyFingerprint(home), home);
    expect(verdict.kind).toBe('valid');
    // B-09: the outbox file is 0600.
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
  });

  it('B-02: a record carrying a synthetic ms_live_ secret is REFUSED — no outbox file', async () => {
    insertShareable(db, { title: 'the prod key', detail: 'set MASSU_API_KEY=ms_live_ABCdef0123456789' });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(res.published).toBe(false);
    expect(res.exported).toBe(0);
    expect(res.refusals.some((r) => r.reason.startsWith('secret:'))).toBe(true);
    // No outbox file for this repo.
    const outbox = join(sharedRootDir(home), 'outbox');
    const anyFile = existsSync(outbox) && readdirSync(outbox, { recursive: true } as never).some((f: string) => String(f).endsWith('.json'));
    expect(anyFile).toBeFalsy();
  });

  it('B-02: sk-/JWT fragments are also refused', async () => {
    insertShareable(db, { title: 'openai', detail: 'sk-abcdef0123456789abcd used here' });
    insertShareable(db, { title: 'jwt', detail: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV token' });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(res.published).toBe(false);
    expect(res.refusals.filter((r) => r.reason.startsWith('secret:')).length).toBe(2);
  });

  it('B-02.2: an imported (origin!=local) row is REFUSED — no re-export / no echo loop', async () => {
    insertShareable(db, { title: 'from repo A', detail: 'a foreign memory', origin: 'repo:11111111-1111-1111-1111-111111111111' });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(res.published).toBe(false);
    expect(res.refusals.some((r) => r.reason === 'non_local_origin')).toBe(true);
  });

  it('B-02: an absolute $HOME path is refused', async () => {
    insertShareable(db, { title: 'a path leak', detail: `see ${home}/secret/notes for details` });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(res.published).toBe(false);
    expect(res.refusals.some((r) => r.reason === 'home_path')).toBe(true);
  });

  it('B-09: a non-UUID repo_id can never become a path component', () => {
    expect(REPO_ID_PATH_RE.test('../../etc')).toBe(false);
    expect(() => outboxDirFor('../../etc', home)).toThrow();
    expect(() => outboxDirFor('11111111-1111-1111-1111-111111111111', home)).not.toThrow();
  });

  it('B-12: the store is backed up before the first export; an unwritable backup refuses and writes nothing', async () => {
    insertShareable(db, { title: 'a decision', detail: 'body' });
    // point the backup at a path under a regular FILE, so mkdir/write fails.
    const notADir = join(home, 'not-a-dir');
    writeFileSync(notADir, 'x');
    const res = await exportSharedMemories(db, new LocalFsTransport(home), {
      home, shareEnabled: true, nowEpoch: NOW, backupDir: join(notADir, 'backups'),
    });
    expect(res.published).toBe(false);
    expect(res.refusals.some((r) => r.reason === 'backup_failed')).toBe(true);
    // nothing published
    const outbox = join(sharedRootDir(home), 'outbox');
    expect(existsSync(outbox) ? readdirSync(outbox).length : 0).toBe(0);
  });

  it('B-12: a writable backup is created and stamps the done marker (idempotent)', async () => {
    insertShareable(db, { title: 'a decision', detail: 'body' });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, shareEnabled: true, nowEpoch: NOW });
    expect(res.published).toBe(true);
    const backupsRoot = join(sharedRootDir(home), 'backups');
    const anyBackup = readdirSync(backupsRoot, { recursive: true } as never).some((f: string) => String(f).endsWith('.db'));
    expect(anyBackup).toBe(true);
  });

  it('dormant install: share OFF exports nothing and mints no key / registry / inbox', async () => {
    insertShareable(db, { title: 'a decision', detail: 'body' });
    const res = await exportSharedMemories(db, new LocalFsTransport(home), { home, /* shareEnabled defaults from config = false */ nowEpoch: NOW });
    expect(res.enabled).toBe(false);
    expect(res.published).toBe(false);
    // ~/.massu untouched
    expect(existsSync(join(home, '.massu'))).toBe(false);
  });
});

describe('Slice 5 B-03 — LocalFsTransport round-trip + seq cursor', () => {
  let home: string;
  const repo = '22222222-2222-2222-2222-222222222222';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'massu-share-tp-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function env(seq: number): SharedMemoryEnvelope {
    return {
      kind: 'massu.shared-memory.v1', origin_repo_id: repo, origin_repo_label: 'a', seq,
      issued_at: '2026-07-21T00:00:00Z', records_json: '[]', revokes_json: '[]',
      _signature: 'x', _signature_alg: 'ed25519', _signature_payload_keys: [], _signature_pubkey_fingerprint: 'f',
    } as SharedMemoryEnvelope;
  }

  it('publish → fetchSince returns only seq > cursor, ascending', async () => {
    const tp = new LocalFsTransport(home);
    await tp.publish(env(1));
    await tp.publish(env(2));
    await tp.publish(env(3));
    expect((await tp.fetchSince(repo, 0)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await tp.fetchSince(repo, 2)).map((e) => e.seq)).toEqual([3]);
    expect(await tp.fetchSince('33333333-3333-3333-3333-333333333333', 0)).toEqual([]);
  });
});

/** Read this repo's minted repo_id straight from memory_meta (test helper). */
function res_repoId(db: Database.Database): string {
  return (db.prepare(`SELECT value FROM memory_meta WHERE key='repo_id'`).get() as { value: string }).value;
}

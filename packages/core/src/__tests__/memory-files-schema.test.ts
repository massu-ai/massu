// A-02 (the lossless mirror) + N-02 (the audit_log CHECK that would have thrown).
//
// N-02 is the one that matters in production: `audit_log.event_type` is
// CHECK-constrained to a fixed list. The memory-file event types were not on it, so
// every insert would throw a constraint violation — and in the ingest path that throw
// is swallowed by a bare `catch {}`, so the observability would have silently produced
// NOTHING, while inside the renderer's transaction the same throw would ROLL BACK a
// legitimate render. Adding values to a SQLite CHECK requires a table rebuild, and an
// EXISTING user database is the case that breaks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

import { initMemorySchema, createSession, migrateAuditLogCheckExtension } from '../memory-db.ts';

const MEMORY_FILE_EVENTS = [
  'memory_file_ingested',
  'memory_file_expired',
  'memory_file_adopted_human',
  'memory_file_rendered',
  'memory_file_render_refused',
  'memory_file_tombstoned',
];

describe('memory_files schema (A-02) + audit_log CHECK (N-02)', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'massu-mfschema-'));
    db = new Database(join(dir, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('memory_files stores a memory VERBATIM — a 19KB body with wiki-links and CRLF round-trips byte-identically', () => {
    // The whole point of `raw`. Today's ingest destroys bytes before the 500-char
    // clamp (`.trim()`), and re-serializing YAML loses key order, comments and
    // quoting. 45 of the operator's 69 memories carry [[wiki-links]] no code parses.
    const raw =
      '---\r\nname: x\r\nmetadata:\r\n  type: feedback   # trailing comment\r\n---\r\n\r\n' +
      '  leading whitespace that .trim() would eat\n' +
      'A [[wiki-link]] and another [[one]].\n' +
      'x'.repeat(19_000) +
      '\n\ntrailing whitespace   \n';

    db.prepare(
      `INSERT INTO memory_files (rel_path, name, raw, body, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('feedback_x.md', 'x', raw, 'body', 'hash');

    const back = (db.prepare('SELECT raw FROM memory_files WHERE rel_path = ?').get('feedback_x.md') as {
      raw: string;
    }).raw;

    expect(back).toBe(raw);
    expect(back.length).toBeGreaterThan(19_000); // no 500-char truncation
    expect(back).toContain('[[wiki-link]]');
    expect(back).toContain('\r\n');
  });

  it('identity is the PATH and folds case — `Foo.md` and `foo.md` are ONE file on disk', () => {
    // macOS and Windows fold case. If the store believes they are two rows, the
    // renderer writes one file twice and each write clobbers the other, every session.
    db.prepare(`INSERT INTO memory_files (rel_path, raw, body, content_hash) VALUES (?, 'r', 'b', 'h')`).run(
      'Foo.md',
    );
    expect(() =>
      db
        .prepare(`INSERT INTO memory_files (rel_path, raw, body, content_hash) VALUES (?, 'r', 'b', 'h')`)
        .run('foo.md'),
    ).toThrow(/UNIQUE/i);
  });

  it('defaults are the SAFE ones: not Massu-authored, local origin, not tombstoned', () => {
    db.prepare(`INSERT INTO memory_files (rel_path, raw, body, content_hash) VALUES (?, 'r', 'b', 'h')`).run(
      'a.md',
    );
    const row = db.prepare('SELECT * FROM memory_files WHERE rel_path = ?').get('a.md') as Record<
      string,
      unknown
    >;
    // Authorship is EARNED, never assumed. A pre-existing file is the human's.
    expect(row.massu_authored).toBe(0);
    expect(row.massu_render_mac).toBeNull();
    // Slice 5 will introduce non-local rows; the renderer must refuse them.
    expect(row.origin).toBe('local');
    expect(row.tombstoned_at_epoch).toBeNull();
    expect(row.ingest_schema_version).toBe(1);
  });

  it('N-02: the audit_log CHECK accepts every memory-file event type', () => {
    for (const ev of MEMORY_FILE_EVENTS) {
      expect(() =>
        db
          .prepare(`INSERT INTO audit_log (session_id, event_type, actor) VALUES ('S1', ?, 'hook')`)
          .run(ev),
      ).not.toThrow();
    }
    const n = (db.prepare(`SELECT COUNT(*) n FROM audit_log`).get() as { n: number }).n;
    expect(n).toBe(MEMORY_FILE_EVENTS.length);
  });

  it('A-19: the events ACTUALLY LAND — an audit trail nobody verified is an audit trail that is not there', async () => {
    // This test exists because the first version of the writer passed NULL for
    // session_id — which is NOT NULL with an FK — so every insert threw, the fail-open
    // catch swallowed it, and the audit trail was SILENTLY EMPTY while appearing to
    // work. Exactly the shape of the CHECK-constraint bug the feature was added to fix.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { ingestMemoryFile } = await import('../memory-file-ingest.ts');

    const root = mkdtempSync(join(tmpdir(), 'massu-a19-'));
    const memDir = join(root, 'memory');
    mkdirSync(memDir);
    const f = join(memDir, 'feedback_x.md');
    writeFileSync(f, '---\nname: x\nmetadata:\n  type: feedback\n---\n\nBody.\n', 'utf-8');

    ingestMemoryFile(db, 'S1', f);

    const n = (
      db
        .prepare(`SELECT COUNT(*) n FROM audit_log WHERE event_type = 'memory_file_ingested'`)
        .get() as { n: number }
    ).n;
    expect(n, 'the ingest event must be RECORDED, not silently swallowed').toBe(1);

    const row = db
      .prepare(`SELECT evidence, actor FROM audit_log WHERE event_type = 'memory_file_ingested'`)
      .get() as { evidence: string; actor: string };
    expect(row.evidence).toBe('feedback_x.md');
    expect(row.actor).toBe('hook');

    rmSync(root, { recursive: true, force: true });
  });

  it('N-02: an EXISTING database built with the OLD 9-value CHECK is migrated to accept them', () => {
    // The production case. `CREATE TABLE IF NOT EXISTS` does NOT alter an existing
    // table, so without the migration every memory-file event throws forever on any
    // db that already exists — which is every db already in the field.
    const legacy = new Database(join(dir, 'legacy.db'));
    legacy.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now')),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
          'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed'
        )),
        actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
        model_id TEXT, file_path TEXT,
        change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
        rules_in_effect TEXT,
        approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
        evidence TEXT, metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
    legacy.prepare(`INSERT INTO sessions (session_id) VALUES ('S1')`).run();
    legacy.prepare(`INSERT INTO audit_log (session_id, event_type) VALUES ('S1', 'commit')`).run();

    // Before: the new event is REJECTED.
    expect(() =>
      legacy.prepare(`INSERT INTO audit_log (session_id, event_type) VALUES ('S1', 'memory_file_rendered')`).run(),
    ).toThrow(/CHECK/i);

    migrateAuditLogCheckExtension(legacy);

    // After: accepted, and the pre-existing row survived the table rebuild.
    expect(() =>
      legacy.prepare(`INSERT INTO audit_log (session_id, event_type) VALUES ('S1', 'memory_file_rendered')`).run(),
    ).not.toThrow();
    const kept = (legacy.prepare(`SELECT COUNT(*) n FROM audit_log WHERE event_type='commit'`).get() as {
      n: number;
    }).n;
    expect(kept, 'the migration must not lose existing audit rows').toBe(1);

    // Idempotent: re-running is a no-op.
    expect(() => migrateAuditLogCheckExtension(legacy)).not.toThrow();
    legacy.close();
  });
});

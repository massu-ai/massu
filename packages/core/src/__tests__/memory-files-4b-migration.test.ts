/**
 * B-00 — the 4B schema migration.
 *
 * The failure this exists to prevent: a machine that soaked 4A already HAS
 * `memory_files` and `observations`. `CREATE TABLE IF NOT EXISTS` adds no columns
 * to an existing table, so every 4B query throws `no such column` — and it throws
 * inside the renderer's write transaction, mid-way through touching the operator's
 * irreplaceable corpus.
 *
 * So the load-bearing test is NOT "a fresh DB has the columns" (that proves only
 * that CREATE TABLE works). It is "a DB built with the 4A-era schema, which is
 * missing these columns, gains them." We therefore construct a 4A-era table by
 * hand rather than trusting a fixture.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateMemoryFilesFor4B, initMemorySchema } from '../memory-db.ts';

/** The `memory_files` / `observations` shape as it existed BEFORE 4B: no `origin`
 *  on the source row, no `render_suppressed` on the projection. */
function build4AEraDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      raw TEXT NOT NULL,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      massu_authored INTEGER NOT NULL DEFAULT 0,
      observation_id INTEGER
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  return db;
}

const cols = (db: Database.Database, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('B-00 — migrateMemoryFilesFor4B on a 4A-era database', () => {
  it('adds every 4B column the renderer queries', () => {
    const db = build4AEraDb();

    // Precondition: this is genuinely the broken state we are fixing.
    expect(cols(db, 'observations')).not.toContain('origin');
    expect(cols(db, 'memory_files')).not.toContain('render_suppressed');
    expect(cols(db, 'memory_files')).not.toContain('massu_render_mac');

    migrateMemoryFilesFor4B(db);

    const mf = cols(db, 'memory_files');
    for (const c of [
      'massu_render_mac',
      'adopted_human_at_epoch',
      'tombstoned_at_epoch',
      'origin',
      'render_suppressed',
    ]) {
      expect(mf, `memory_files.${c}`).toContain(c);
    }
    // N-03 — the SOURCE row. This is the column B-10's gate actually reads.
    expect(cols(db, 'observations')).toContain('origin');
    db.close();
  });

  it('is idempotent — re-running changes nothing and does not throw', () => {
    const db = build4AEraDb();
    migrateMemoryFilesFor4B(db);
    const after1 = [...cols(db, 'memory_files'), ...cols(db, 'observations')];

    expect(() => {
      migrateMemoryFilesFor4B(db);
      migrateMemoryFilesFor4B(db);
    }).not.toThrow();

    expect([...cols(db, 'memory_files'), ...cols(db, 'observations')]).toEqual(after1);
    db.close();
  });

  it('defaults origin to local — an existing row is never accidentally non-local', () => {
    const db = build4AEraDb();
    db.prepare(
      `INSERT INTO observations (session_id, type, title, created_at, created_at_epoch)
       VALUES ('s', 'decision', 'a pre-existing memory', '2026-01-01', 1767225600)`
    ).run();

    migrateMemoryFilesFor4B(db);

    // Fail-closed cuts BOTH ways: a pre-existing local memory must not become
    // un-renderable, and a NULL origin must never be readable as 'local'.
    const row = db.prepare(`SELECT origin FROM observations WHERE id = 1`).get() as { origin: string };
    expect(row.origin).toBe('local');
    db.close();
  });

  it('a 4B renderer query succeeds against a migrated 4A-era DB', () => {
    const db = build4AEraDb();
    migrateMemoryFilesFor4B(db);

    // The exact shape of the renderer's source-row scan (B-10 gate + B-04 tombstone
    // exclusion). Before the migration this throws `no such column: o.origin`.
    expect(() =>
      db
        .prepare(
          `SELECT o.id, o.title, o.origin
             FROM observations o
             LEFT JOIN memory_files mf ON mf.observation_id = o.id
            WHERE o.origin = 'local'
              AND COALESCE(mf.tombstoned_at_epoch, 0) = 0
              AND COALESCE(mf.render_suppressed, 0) = 0`
        )
        .all()
    ).not.toThrow();
    db.close();
  });

  it('every 4B audit_log event type inserts without a CHECK violation', () => {
    // N-02: A-19 writes these and its caller swallows the throw, so a CHECK
    // violation makes observability silently nil rather than loud.
    const db = new Database(':memory:');
    initMemorySchema(db);
    db.prepare(
      `INSERT INTO sessions (session_id, started_at, started_at_epoch)
       VALUES ('s1', '2026-07-12', 1768176000)`
    ).run();

    for (const evt of [
      'memory_file_ingested',
      'memory_file_expired',
      'memory_file_adopted_human',
      'memory_file_rendered',
      'memory_file_render_refused',
      'memory_file_tombstoned',
    ]) {
      expect(
        () =>
          db
            .prepare(`INSERT INTO audit_log (session_id, event_type) VALUES ('s1', ?)`)
            .run(evt),
        `event_type=${evt}`
      ).not.toThrow();
    }
    db.close();
  });

  it('a fresh initMemorySchema DB already has every 4B column', () => {
    const db = new Database(':memory:');
    initMemorySchema(db);
    expect(cols(db, 'observations')).toContain('origin');
    expect(cols(db, 'memory_files')).toContain('render_suppressed');
    expect(cols(db, 'memory_files')).toContain('massu_render_mac');
    db.close();
  });
});

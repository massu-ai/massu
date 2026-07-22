// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * SSOT DB-driver adapter — the SINGLE engine-swappable open chokepoint (CR-65 → CR-69).
 *
 * WHY THIS EXISTS (incident 2026-07-12, bug class B — native engine):
 * `better-sqlite3` is a NATIVE module; its `.node` binary is ABI-locked to the Node
 * major that built it, and `dlopen`-FAILS (silently, lazily, inside the ctor) on a
 * Node-major mismatch. Layer 1 (`lib/sqlite-loader.ts`) made that failure loud +
 * self-healing; Layer 2 (this module) removes the ROOT CAUSE by defaulting to Node's
 * built-in synchronous `node:sqlite` (`DatabaseSync`) — no native module, no ABI to
 * mismatch — behind a thin adapter that preserves the exact `better-sqlite3` surface
 * massu codes against (FTS5, WAL, `.transaction()`, `.pragma()`, `.serialize()`).
 * `better-sqlite3` is retained ONLY as an opt-in fallback driver (`MASSU_DB_ENGINE=
 * better-sqlite3`) so the engine choice is ONE constant and there is a reversible
 * escape hatch.
 *
 * SOLE-OPENER INVARIANT: every DB-open site in `packages/core/src` imports
 * `openDatabase` from THIS module (which for the bs3 engine delegates to the Layer-1
 * native loader). This module is the ONLY value-importer of `node:sqlite`; the ONLY
 * value-importer of `better-sqlite3` remains `lib/sqlite-loader.ts` (CR-65). Enforced
 * by `db-driver-drift-guard.test.ts` (D-001) + pattern-scanner Check 46 (D-002).
 *
 * COMPAT SURFACE (reality-audited at impl time — the ONLY better-sqlite3 members
 * massu uses): db.prepare/exec/pragma/transaction/serialize/close + ctor `{readonly}`;
 * stmt.run/get/all. All binds are positional `?` (0 named-param sites). BLOB reads go
 * through `memory-vector.ts` which accepts `Buffer | Uint8Array`. No caller uses
 * `.pluck/.raw/.iterate/.expand/.name/.inTransaction/.function/.aggregate/.backup`.
 *
 * SECURITY (CR-63 / S5): extension loading is disabled on both engines
 * (`allowExtension:false`); FTS5 MATCH sites bind, never interpolate untrusted text.
 */

import { createRequire } from 'module';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, fsyncSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import {
  openDatabase as openBetterSqlite3Native,
  probeMemoryDbUsable as probeBetterSqlite3Native,
  NATIVE_DB_REMEDY,
  type OpenDatabaseOptions,
  type ProbeVerdict,
} from './lib/sqlite-loader.ts';

// A require bound to THIS module. `node:sqlite` is loaded lazily (only when the
// node-sqlite engine is actually used) so the fallback path never pays the
// ExperimentalWarning, and this stays the SOLE `node:sqlite` value-importer.
const req = createRequire(import.meta.url);

/** The two supported local DB engines. `node-sqlite` is the default (native-free). */
export type DbEngine = 'node-sqlite' | 'better-sqlite3';

/**
 * The default engine — Node's built-in `node:sqlite`. A DRIFT-GUARDED CONSTANT
 * (D-001 asserts it equals `'node-sqlite'`); a mutation here fails the guard.
 */
export const DEFAULT_DB_ENGINE: DbEngine = 'node-sqlite';

/** Env override that selects the opt-in `better-sqlite3` fallback driver. */
export const DB_ENGINE_ENV = 'MASSU_DB_ENGINE';

/** Resolve the active engine: env override (fallback opt-in) → the default constant. */
export function resolveDbEngine(): DbEngine {
  return process.env[DB_ENGINE_ENV] === 'better-sqlite3' ? 'better-sqlite3' : DEFAULT_DB_ENGINE;
}

/**
 * The massu-facing DB surface. This IS the `better-sqlite3` `Database` interface
 * (what massu codes against today); the node-sqlite driver presents a
 * behaviorally-identical object, proven by the dual-engine parity test (M-006).
 */
export type MassuDatabase = Database.Database;

// ============================================================
// node:sqlite driver — the native-free default
// ============================================================

/** node:sqlite `DatabaseSync` ctor (loaded lazily, once). */
interface NodeSqliteCtor {
  new (
    path: string,
    opts?: {
      open?: boolean;
      readOnly?: boolean;
      enableForeignKeyConstraints?: boolean;
      enableDoubleQuotedStringLiterals?: boolean;
      allowExtension?: boolean;
    },
  ): NodeSqliteDb;
}
interface NodeSqliteDb {
  prepare(sql: string): NodeSqliteStmt;
  exec(sql: string): void;
  close(): void;
  /** TRUE while a transaction is open on this connection — reflects raw `exec('BEGIN')`
   *  too, not just the adapter's wrapper (better-sqlite3's `inTransaction` analogue). */
  readonly isTransaction: boolean;
}
interface NodeSqliteStmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

let _nodeCtor: NodeSqliteCtor | null = null;
function nodeSqliteCtor(): NodeSqliteCtor {
  if (!_nodeCtor) _nodeCtor = (req('node:sqlite') as { DatabaseSync: NodeSqliteCtor }).DatabaseSync;
  return _nodeCtor;
}

/** node:sqlite returns null-prototype row objects; hand back plain objects so the
 *  handle is a byte-faithful drop-in (prototype-sensitive callers / JSON / spreads). */
function plainRow<T>(row: T): T {
  if (row == null || typeof row !== 'object') return row;
  return { ...(row as Record<string, unknown>) } as T;
}

function openNodeSqlite(dbPath: string, opts: OpenDatabaseOptions): MassuDatabase {
  const Ctor = nodeSqliteCtor();
  const raw = new Ctor(dbPath, {
    open: true,
    readOnly: !!opts.readonly,
    // FAITHFULNESS: better-sqlite3's ACTUAL default is foreign_keys=ON (empirically
    // verified — SQLite's own default is OFF, but bs3 enables it). massu was written +
    // tested against that default, so the adapter must match it, or a store that relies
    // on FK-ON-by-default (without an explicit pragma) would silently lose enforcement.
    // Explicit `foreign_keys=OFF/ON` pragmas (e.g. memory-db bulk ops) still override.
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });

  let savepointSeq = 0;

  const wrapStmt = (sql: string) => {
    const st = raw.prepare(sql);
    return {
      run: (...p: unknown[]) => {
        const r = st.run(...p);
        return {
          changes: typeof r.changes === 'bigint' ? Number(r.changes) : r.changes,
          lastInsertRowid: r.lastInsertRowid as number | bigint,
        };
      },
      get: (...p: unknown[]) => plainRow(st.get(...p)),
      all: (...p: unknown[]) => st.all(...p).map(plainRow),
    };
  };

  // .pragma(str, {simple?}) — set (contains `=`) via exec; read via prepare().all().
  // `{simple:true}` returns the first column of the first row (bs3 semantics).
  const pragma = (source: string, options?: { simple?: boolean }) => {
    const s = String(source).trim();
    if (s.includes('=')) {
      raw.exec(`PRAGMA ${s}`);
      return undefined;
    }
    const rows = raw.prepare(`PRAGMA ${s}`).all().map(plainRow);
    if (options?.simple) {
      const first = rows[0];
      return first ? (Object.values(first)[0] as unknown) : undefined;
    }
    return rows;
  };

  // .transaction(fn) — a callable that BEGINs/COMMITs (SAVEPOINT when nested),
  // ROLLBACKs on throw, and forwards its args + return value (bs3 semantics).
  const transaction = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const run = (...args: A): R => {
      // Consult the connection's REAL transaction state (bs3's `inTransaction` analogue)
      // — NOT a private counter — so a wrapped helper invoked INSIDE a raw `exec('BEGIN')`
      // region correctly opens a SAVEPOINT instead of a second BEGIN (which node:sqlite
      // rejects: "cannot start a transaction within a transaction"). The codebase mixes
      // both idioms (17 `.transaction()` sites + raw BEGIN regions).
      const nested = raw.isTransaction;
      const name = `msp_${savepointSeq++}`;
      if (nested) raw.exec(`SAVEPOINT ${name}`);
      else raw.exec('BEGIN');
      try {
        const out = fn(...args);
        if (nested) raw.exec(`RELEASE ${name}`);
        else raw.exec('COMMIT');
        return out;
      } catch (e) {
        if (nested) {
          // ROLLBACK TO rewinds to the savepoint but LEAVES it on the stack — RELEASE
          // pops it, returning the connection to the pre-savepoint state (bs3 parity).
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
        } else {
          raw.exec('ROLLBACK');
        }
        throw e;
      }
    };
    return run;
  };

  // .serialize() — bs3 returns a consistent snapshot Buffer. node:sqlite has no
  // serialize; `VACUUM INTO <tmp>` is SQLite's canonical consistent-copy mechanism
  // (works for file-backed AND in-memory DBs). Read the bytes, clean up, return Buffer.
  // ENGINE LIMITATION vs bs3: VACUUM cannot run inside a transaction, so unlike bs3's
  // C-API serialize(), the node:sqlite path requires no open transaction. The sole
  // caller (shared-memory-export ensureSharingBackup) runs outside one; fail LOUD with a
  // clear message rather than a cryptic SQLite error if that ever changes.
  const serialize = (): Buffer => {
    if (raw.isTransaction) {
      throw new Error(
        'db-driver: .serialize() (node:sqlite engine) cannot run inside an open ' +
          'transaction — VACUUM is forbidden in a transaction. Serialize before BEGIN, ' +
          'or use MASSU_DB_ENGINE=better-sqlite3 for mid-transaction snapshots.',
      );
    }
    const dir = mkdtempSync(join(tmpdir(), 'massu-serialize-'));
    const out = join(dir, 'snapshot.db');
    try {
      raw.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      const fd = openSync(out, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const handle = {
    prepare: (sql: string) => wrapStmt(sql),
    exec: (sql: string) => raw.exec(sql),
    pragma,
    transaction,
    serialize,
    close: () => raw.close(),
  };
  // The adapter fulfills the reality-audited subset of `Database.Database` that massu
  // uses; behavioral equivalence is proven by the dual-engine parity test (M-006) and
  // the full suite. This assertion is the single adapter boundary.
  return handle as unknown as MassuDatabase;
}

// ============================================================
// better-sqlite3 driver — opt-in fallback (retains Layer-1 ABI self-heal)
// ============================================================

function openBetterSqlite3(dbPath: string, opts: OpenDatabaseOptions): MassuDatabase {
  // The Layer-1 native loader is the sole `better-sqlite3` value-importer (CR-65). A
  // real bs3 `Database` already satisfies the full massu surface natively.
  return openBetterSqlite3Native(dbPath, opts);
}

// ============================================================
// Public chokepoint
// ============================================================

/**
 * THE single engine-swappable DB-open chokepoint. Returns a handle presenting the
 * `better-sqlite3` surface massu codes against, backed by the resolved engine
 * (`node:sqlite` default; `better-sqlite3` when `MASSU_DB_ENGINE=better-sqlite3`).
 * `{ readonly: true }` is honored on both engines.
 */
export function openDatabase(dbPath: string, opts: OpenDatabaseOptions = {}): MassuDatabase {
  return resolveDbEngine() === 'better-sqlite3'
    ? openBetterSqlite3(dbPath, opts)
    : openNodeSqlite(dbPath, opts);
}

/** Remedy surfaced when Node's built-in `node:sqlite` itself fails (not an ABI class —
 *  there is no binary to rebuild; `massu heal` cannot help). */
export const NODE_SQLITE_REMEDY =
  "Node's built-in node:sqlite failed to open the database. Ensure Node >= 22.13.0 (`node --version`) " +
  'and that this Node build includes SQLite, then restart your MCP client / Claude Code.';

/**
 * Engine-aware health probe. For the `better-sqlite3` fallback it delegates to the
 * Layer-1 native probe VERBATIM (ABI detection + self-heal). For the `node:sqlite`
 * default it does the REAL native-free touch: construct `:memory:` via the adapter and
 * run `SELECT 1` (node:sqlite has no ABI, so a green here can never coexist with a dead
 * DB touch), then — if `dbPath` exists — open it read-only and `SELECT 1`.
 */
export function probeMemoryDbUsable(opts: { dbPath?: string; selfHeal?: boolean } = {}): ProbeVerdict {
  if (resolveDbEngine() === 'better-sqlite3') {
    return probeBetterSqlite3Native(opts);
  }
  // (1) The native-free touch — a REAL construct + query of the active engine.
  try {
    const db = openDatabase(':memory:');
    try {
      db.prepare('SELECT 1').get();
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'unreadable',
      remedy: NODE_SQLITE_REMEDY,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  // (2) The real-file touch (read-only) — catches a corrupt / unreadable store.
  const dbPath = opts.dbPath;
  if (dbPath && dbPath !== ':memory:' && existsSync(dbPath)) {
    try {
      const rdb = openDatabase(dbPath, { readonly: true });
      try {
        rdb.prepare('SELECT 1').get();
      } finally {
        rdb.close();
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'unreadable',
        remedy: NODE_SQLITE_REMEDY,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true };
}

export { NATIVE_DB_REMEDY, type ProbeVerdict, type OpenDatabaseOptions };
export { MemoryEngineUnusableError, type MemoryEngineReason } from './lib/sqlite-loader.ts';

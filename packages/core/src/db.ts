// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { assertCodegraphUsable } from './preflight.ts';
import { getResolvedPaths } from './config.ts';
import { t } from './lib/sql-table-names.ts';

/**
 * Thrown by `getCodeGraphDb()` when `.codegraph/codegraph.db` is missing.
 *
 * Caught at the JSON-RPC dispatch layer (server.ts) and translated to a
 * structured `-32001` error response carrying a remedy hint and the resolved
 * DB path. The thrown error is INTERNAL; user-facing copy lives in the
 * dispatcher's error envelope.
 *
 * @see `docs/plans/2026-05-10-server-lazy-db-deps.md` P-C-001 + P-A-004
 */
// G-3: the error classes live in preflight.ts (the module that decides usability), and
// are re-exported here for every existing importer. Defining the base HERE and extending
// it THERE would be a circular ESM import — and `class X extends Y` needs Y evaluated at
// module-load time, so it would crash on startup. One direction only: db -> preflight.
export {
  CodegraphDbNotInitializedError,
  CodegraphDbUnusableError,
  type CodegraphFailure,
} from './preflight.ts';

/**
 * Connection to CodeGraph's read-only SQLite database.
 * We NEVER write to this DB - it belongs to vanilla CodeGraph.
 *
 * Throws `CodegraphDbNotInitializedError` (internal signal) when the DB is
 * missing. The MCP dispatcher catches and translates to a structured
 * JSON-RPC error pointing at `npx @colbymchenry/codegraph init`.
 */
export function getCodeGraphDb(): Database.Database {
  const dbPath = getResolvedPaths().codegraphDbPath;

  // G-3 (M-2): this used to be `if (!existsSync(dbPath)) throw`. That guards the LOUD
  // failure — the file is gone — and is blind to every QUIET one. Verified live: the
  // file existed with 0 files / 0 nodes / 0 edges, the guard raised NOTHING, and
  // `massu_impact` then reported "(safe)" for any change because it looked and found
  // nothing. "No impact" and "I have no data" were byte-identical to the caller.
  //
  // A dependency is not "present". It is USABLE, or it is not there.
  assertCodegraphUsable(dbPath);

  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Connection to Massu's supplementary SQLite database.
 * This stores import edges, tRPC mappings, domain classifications, etc.
 */
export function getDataDb(): Database.Database {
  const dbPath = getResolvedPaths().dataDbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initDataSchema(db);
  return db;
}

function initDataSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${t('imports')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      target_file TEXT NOT NULL,
      import_type TEXT NOT NULL CHECK(import_type IN ('named', 'default', 'namespace', 'side_effect', 'dynamic')),
      imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_massu_imports_source ON ${t('imports')}(source_file);
    CREATE INDEX IF NOT EXISTS idx_massu_imports_target ON ${t('imports')}(target_file);

    CREATE TABLE IF NOT EXISTS ${t('trpc_procedures')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_file TEXT NOT NULL,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT NOT NULL CHECK(procedure_type IN ('query', 'mutation')),
      has_ui_caller INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_massu_trpc_router ON ${t('trpc_procedures')}(router_name);

    CREATE TABLE IF NOT EXISTS ${t('trpc_call_sites')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL DEFAULT 0,
      call_pattern TEXT NOT NULL,
      FOREIGN KEY (procedure_id) REFERENCES ${t('trpc_procedures')}(id)
    );

    CREATE INDEX IF NOT EXISTS idx_massu_call_sites_proc ON ${t('trpc_call_sites')}(procedure_id);

    CREATE TABLE IF NOT EXISTS ${t('page_deps')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_file TEXT NOT NULL,
      route TEXT NOT NULL,
      portal TEXT NOT NULL DEFAULT 'unknown',
      components TEXT NOT NULL DEFAULT '[]',
      hooks TEXT NOT NULL DEFAULT '[]',
      routers TEXT NOT NULL DEFAULT '[]',
      tables_touched TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_massu_page_deps_page ON ${t('page_deps')}(page_file);

    CREATE TABLE IF NOT EXISTS ${t('middleware_tree')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS ${t('meta')} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ============================================================
    -- Python Code Intelligence Tables
    -- ============================================================

    CREATE TABLE IF NOT EXISTS ${t('py_imports')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      target_file TEXT NOT NULL,
      import_type TEXT NOT NULL CHECK(import_type IN ('absolute', 'relative', 'from_absolute', 'from_relative')),
      imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_massu_py_imports_source ON ${t('py_imports')}(source_file);
    CREATE INDEX IF NOT EXISTS idx_massu_py_imports_target ON ${t('py_imports')}(target_file);

    CREATE TABLE IF NOT EXISTS ${t('py_meta')} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${t('py_routes')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      function_name TEXT NOT NULL,
      dependencies TEXT NOT NULL DEFAULT '[]',
      request_model TEXT,
      response_model TEXT,
      is_authenticated INTEGER NOT NULL DEFAULT 0,
      line INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_massu_py_routes_path ON ${t('py_routes')}(path);
    CREATE INDEX IF NOT EXISTS idx_massu_py_routes_file ON ${t('py_routes')}(file);

    CREATE TABLE IF NOT EXISTS ${t('py_route_callers')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL REFERENCES ${t('py_routes')}(id) ON DELETE CASCADE,
      frontend_file TEXT NOT NULL,
      line INTEGER NOT NULL DEFAULT 0,
      call_pattern TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_massu_py_route_callers_route ON ${t('py_route_callers')}(route_id);

    CREATE TABLE IF NOT EXISTS ${t('py_models')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL,
      table_name TEXT,
      file TEXT NOT NULL,
      line INTEGER NOT NULL DEFAULT 0,
      columns TEXT NOT NULL DEFAULT '[]',
      relationships TEXT NOT NULL DEFAULT '[]',
      foreign_keys TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_massu_py_models_file ON ${t('py_models')}(file);
    CREATE INDEX IF NOT EXISTS idx_massu_py_models_table ON ${t('py_models')}(table_name);

    CREATE TABLE IF NOT EXISTS ${t('py_fk_edges')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_table TEXT NOT NULL,
      source_column TEXT NOT NULL,
      target_table TEXT NOT NULL,
      target_column TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_massu_py_fk_source ON ${t('py_fk_edges')}(source_table);
    CREATE INDEX IF NOT EXISTS idx_massu_py_fk_target ON ${t('py_fk_edges')}(target_table);

    CREATE TABLE IF NOT EXISTS ${t('py_migrations')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision TEXT NOT NULL UNIQUE,
      down_revision TEXT,
      file TEXT NOT NULL,
      description TEXT,
      operations TEXT NOT NULL DEFAULT '[]',
      is_head INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_massu_py_migrations_rev ON ${t('py_migrations')}(revision);

    -- ============================================================
    -- Sentinel: Feature Registry Tables
    -- ============================================================

    -- Core feature definition
    CREATE TABLE IF NOT EXISTS ${t('sentinel')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT UNIQUE NOT NULL,
      domain TEXT NOT NULL,
      subdomain TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('planned', 'active', 'deprecated', 'removed')),
      priority TEXT DEFAULT 'standard'
        CHECK(priority IN ('critical', 'standard', 'nice-to-have')),
      portal_scope TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      removed_at TEXT,
      removed_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sentinel_domain ON ${t('sentinel')}(domain);
    CREATE INDEX IF NOT EXISTS idx_sentinel_status ON ${t('sentinel')}(status);
    CREATE INDEX IF NOT EXISTS idx_sentinel_key ON ${t('sentinel')}(feature_key);

    -- Feature-to-component mapping (many-to-many)
    CREATE TABLE IF NOT EXISTS ${t('sentinel_components')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES ${t('sentinel')}(id) ON DELETE CASCADE,
      component_file TEXT NOT NULL,
      component_name TEXT,
      role TEXT DEFAULT 'implementation'
        CHECK(role IN ('implementation', 'ui', 'data', 'utility')),
      is_primary BOOLEAN DEFAULT 0,
      UNIQUE(feature_id, component_file, component_name)
    );

    -- Feature-to-procedure mapping (many-to-many)
    CREATE TABLE IF NOT EXISTS ${t('sentinel_procedures')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES ${t('sentinel')}(id) ON DELETE CASCADE,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT,
      UNIQUE(feature_id, router_name, procedure_name)
    );

    -- Feature-to-page mapping (where feature is accessible)
    CREATE TABLE IF NOT EXISTS ${t('sentinel_pages')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES ${t('sentinel')}(id) ON DELETE CASCADE,
      page_route TEXT NOT NULL,
      portal TEXT,
      UNIQUE(feature_id, page_route, portal)
    );

    -- Feature dependency graph
    CREATE TABLE IF NOT EXISTS ${t('sentinel_deps')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES ${t('sentinel')}(id) ON DELETE CASCADE,
      depends_on_feature_id INTEGER NOT NULL REFERENCES ${t('sentinel')}(id) ON DELETE CASCADE,
      dependency_type TEXT DEFAULT 'requires'
        CHECK(dependency_type IN ('requires', 'enhances', 'replaces')),
      UNIQUE(feature_id, depends_on_feature_id)
    );

    -- Feature change log (audit trail)
    CREATE TABLE IF NOT EXISTS ${t('sentinel_changelog')} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES ${t('sentinel')}(id) ON DELETE CASCADE,
      change_type TEXT NOT NULL,
      changed_by TEXT,
      change_detail TEXT,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sentinel_components_file ON ${t('sentinel_components')}(component_file);
    CREATE INDEX IF NOT EXISTS idx_sentinel_procedures_router ON ${t('sentinel_procedures')}(router_name);
    CREATE INDEX IF NOT EXISTS idx_sentinel_pages_route ON ${t('sentinel_pages')}(page_route);
    CREATE INDEX IF NOT EXISTS idx_sentinel_changelog_feature ON ${t('sentinel_changelog')}(feature_id);
  `);

  // FTS5 for feature search (separate exec since virtual tables can't be in same batch)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${t('sentinel_fts')} USING fts5(
      feature_key, title, description, domain, subdomain,
      content=${t('sentinel')}, content_rowid=id
    );
  `);

  // FTS5 sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS massu_sentinel_ai AFTER INSERT ON ${t('sentinel')} BEGIN
      INSERT INTO ${t('sentinel_fts')}(rowid, feature_key, title, description, domain, subdomain)
      VALUES (new.id, new.feature_key, new.title, new.description, new.domain, new.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS massu_sentinel_ad AFTER DELETE ON ${t('sentinel')} BEGIN
      INSERT INTO ${t('sentinel_fts')}(${t('sentinel_fts')}, rowid, feature_key, title, description, domain, subdomain)
      VALUES ('delete', old.id, old.feature_key, old.title, old.description, old.domain, old.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS massu_sentinel_au AFTER UPDATE ON ${t('sentinel')} BEGIN
      INSERT INTO ${t('sentinel_fts')}(${t('sentinel_fts')}, rowid, feature_key, title, description, domain, subdomain)
      VALUES ('delete', old.id, old.feature_key, old.title, old.description, old.domain, old.subdomain);
      INSERT INTO ${t('sentinel_fts')}(rowid, feature_key, title, description, domain, subdomain)
      VALUES (new.id, new.feature_key, new.title, new.description, new.domain, new.subdomain);
    END;
  `);
}

/**
 * Check if Massu indexes are stale compared to CodeGraph timestamps.
 */
export function isDataStale(dataDb: Database.Database, codegraphDb: Database.Database): boolean {
  const lastBuild = dataDb.prepare(`SELECT value FROM ${t('meta')} WHERE key = 'last_build_time'`).get() as { value: string } | undefined;
  if (!lastBuild) return true;

  // CodeGraph stores indexed_at as unix timestamp (integer)
  const latestIndexed = codegraphDb.prepare("SELECT MAX(indexed_at) as latest FROM files").get() as { latest: number } | undefined;
  if (!latestIndexed?.latest) return true;

  // Convert CodeGraph's unix timestamp to ms and compare with our ISO date
  return (latestIndexed.latest * 1000) > new Date(lastBuild.value).getTime();
}

/**
 * Update the last build timestamp in massu_meta.
 */
export function updateBuildTimestamp(dataDb: Database.Database): void {
  dataDb.prepare(`INSERT OR REPLACE INTO ${t('meta')} (key, value) VALUES ('last_build_time', ?)`).run(new Date().toISOString());
}

/**
 * Check if Python indexes are stale based on massu_py_meta.last_build_time.
 */
export function isPythonDataStale(dataDb: Database.Database, pythonRoot: string): boolean {
  const lastBuild = dataDb.prepare(`SELECT value FROM ${t('py_meta')} WHERE key = 'last_build_time'`).get() as { value: string } | undefined;
  if (!lastBuild) return true;

  const lastBuildTime = new Date(lastBuild.value).getTime();
  // Check if any .py file is newer than last build
  function checkDir(dir: string): boolean {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['__pycache__', '.venv', 'venv', 'node_modules', '.mypy_cache', '.pytest_cache'].includes(entry.name)) continue;
          if (checkDir(fullPath)) return true;
        } else if (entry.name.endsWith('.py')) {
          if (statSync(fullPath).mtimeMs > lastBuildTime) return true;
        }
      }
    } catch { /* directory may not exist */ }
    return false;
  }

  return checkDir(pythonRoot);
}

/**
 * Update the Python build timestamp in massu_py_meta.
 */
export function updatePythonBuildTimestamp(dataDb: Database.Database): void {
  dataDb.prepare(`INSERT OR REPLACE INTO ${t('py_meta')} (key, value) VALUES ('last_build_time', ?)`).run(new Date().toISOString());
}

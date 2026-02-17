// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import Database from 'better-sqlite3';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getResolvedPaths } from './config.ts';

/**
 * Connection to CodeGraph's read-only SQLite database.
 * We NEVER write to this DB - it belongs to vanilla CodeGraph.
 */
export function getCodeGraphDb(): Database.Database {
  const dbPath = getResolvedPaths().codegraphDbPath;
  if (!existsSync(dbPath)) {
    throw new Error(`CodeGraph database not found at ${dbPath}. Run 'npx @colbymchenry/codegraph sync' first.`);
  }
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
    CREATE TABLE IF NOT EXISTS massu_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      target_file TEXT NOT NULL,
      import_type TEXT NOT NULL CHECK(import_type IN ('named', 'default', 'namespace', 'side_effect', 'dynamic')),
      imported_names TEXT NOT NULL DEFAULT '[]',
      line INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_massu_imports_source ON massu_imports(source_file);
    CREATE INDEX IF NOT EXISTS idx_massu_imports_target ON massu_imports(target_file);

    CREATE TABLE IF NOT EXISTS massu_trpc_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_file TEXT NOT NULL,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT NOT NULL CHECK(procedure_type IN ('query', 'mutation')),
      has_ui_caller INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_massu_trpc_router ON massu_trpc_procedures(router_name);

    CREATE TABLE IF NOT EXISTS massu_trpc_call_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL DEFAULT 0,
      call_pattern TEXT NOT NULL,
      FOREIGN KEY (procedure_id) REFERENCES massu_trpc_procedures(id)
    );

    CREATE INDEX IF NOT EXISTS idx_massu_call_sites_proc ON massu_trpc_call_sites(procedure_id);

    CREATE TABLE IF NOT EXISTS massu_page_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_file TEXT NOT NULL,
      route TEXT NOT NULL,
      portal TEXT NOT NULL DEFAULT 'unknown',
      components TEXT NOT NULL DEFAULT '[]',
      hooks TEXT NOT NULL DEFAULT '[]',
      routers TEXT NOT NULL DEFAULT '[]',
      tables_touched TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_massu_page_deps_page ON massu_page_deps(page_file);

    CREATE TABLE IF NOT EXISTS massu_middleware_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS massu_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ============================================================
    -- Sentinel: Feature Registry Tables
    -- ============================================================

    -- Core feature definition
    CREATE TABLE IF NOT EXISTS massu_sentinel (
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

    CREATE INDEX IF NOT EXISTS idx_sentinel_domain ON massu_sentinel(domain);
    CREATE INDEX IF NOT EXISTS idx_sentinel_status ON massu_sentinel(status);
    CREATE INDEX IF NOT EXISTS idx_sentinel_key ON massu_sentinel(feature_key);

    -- Feature-to-component mapping (many-to-many)
    CREATE TABLE IF NOT EXISTS massu_sentinel_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      component_file TEXT NOT NULL,
      component_name TEXT,
      role TEXT DEFAULT 'implementation'
        CHECK(role IN ('implementation', 'ui', 'data', 'utility')),
      is_primary BOOLEAN DEFAULT 0,
      UNIQUE(feature_id, component_file, component_name)
    );

    -- Feature-to-procedure mapping (many-to-many)
    CREATE TABLE IF NOT EXISTS massu_sentinel_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      router_name TEXT NOT NULL,
      procedure_name TEXT NOT NULL,
      procedure_type TEXT,
      UNIQUE(feature_id, router_name, procedure_name)
    );

    -- Feature-to-page mapping (where feature is accessible)
    CREATE TABLE IF NOT EXISTS massu_sentinel_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      page_route TEXT NOT NULL,
      portal TEXT,
      UNIQUE(feature_id, page_route, portal)
    );

    -- Feature dependency graph
    CREATE TABLE IF NOT EXISTS massu_sentinel_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      depends_on_feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      dependency_type TEXT DEFAULT 'requires'
        CHECK(dependency_type IN ('requires', 'enhances', 'replaces')),
      UNIQUE(feature_id, depends_on_feature_id)
    );

    -- Feature change log (audit trail)
    CREATE TABLE IF NOT EXISTS massu_sentinel_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES massu_sentinel(id) ON DELETE CASCADE,
      change_type TEXT NOT NULL,
      changed_by TEXT,
      change_detail TEXT,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sentinel_components_file ON massu_sentinel_components(component_file);
    CREATE INDEX IF NOT EXISTS idx_sentinel_procedures_router ON massu_sentinel_procedures(router_name);
    CREATE INDEX IF NOT EXISTS idx_sentinel_pages_route ON massu_sentinel_pages(page_route);
    CREATE INDEX IF NOT EXISTS idx_sentinel_changelog_feature ON massu_sentinel_changelog(feature_id);
  `);

  // FTS5 for feature search (separate exec since virtual tables can't be in same batch)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS massu_sentinel_fts USING fts5(
      feature_key, title, description, domain, subdomain,
      content=massu_sentinel, content_rowid=id
    );
  `);

  // FTS5 sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS massu_sentinel_ai AFTER INSERT ON massu_sentinel BEGIN
      INSERT INTO massu_sentinel_fts(rowid, feature_key, title, description, domain, subdomain)
      VALUES (new.id, new.feature_key, new.title, new.description, new.domain, new.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS massu_sentinel_ad AFTER DELETE ON massu_sentinel BEGIN
      INSERT INTO massu_sentinel_fts(massu_sentinel_fts, rowid, feature_key, title, description, domain, subdomain)
      VALUES ('delete', old.id, old.feature_key, old.title, old.description, old.domain, old.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS massu_sentinel_au AFTER UPDATE ON massu_sentinel BEGIN
      INSERT INTO massu_sentinel_fts(massu_sentinel_fts, rowid, feature_key, title, description, domain, subdomain)
      VALUES ('delete', old.id, old.feature_key, old.title, old.description, old.domain, old.subdomain);
      INSERT INTO massu_sentinel_fts(rowid, feature_key, title, description, domain, subdomain)
      VALUES (new.id, new.feature_key, new.title, new.description, new.domain, new.subdomain);
    END;
  `);
}

/**
 * Check if Massu indexes are stale compared to CodeGraph timestamps.
 */
export function isDataStale(dataDb: Database.Database, codegraphDb: Database.Database): boolean {
  const lastBuild = dataDb.prepare("SELECT value FROM massu_meta WHERE key = 'last_build_time'").get() as { value: string } | undefined;
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
  dataDb.prepare("INSERT OR REPLACE INTO massu_meta (key, value) VALUES ('last_build_time', ?)").run(new Date().toISOString());
}

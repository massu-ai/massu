// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type {
  Feature,
  FeatureInput,
  FeatureComponent,
  FeatureProcedure,
  FeaturePage,
  FeatureDep,
  FeatureChangeLog,
  FeatureWithCounts,
  FeatureDetail,
  ImpactReport,
  ImpactItem,
  ValidationReport,
  ValidationItem,
  ParityReport,
  ParityItem,
  ComponentRole,
} from './sentinel-types.ts';
import { getProjectRoot } from './config.ts';
import { sanitizeFts5Query } from './memory-db.ts';

// ============================================================
// Sentinel: Feature Registry Data Access Layer
// ============================================================

const PROJECT_ROOT = getProjectRoot();

function parsePortalScope(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function toFeature(row: Record<string, unknown>): Feature {
  return {
    id: row.id as number,
    feature_key: row.feature_key as string,
    domain: row.domain as string,
    subdomain: (row.subdomain as string) || null,
    title: row.title as string,
    description: (row.description as string) || null,
    status: row.status as Feature['status'],
    priority: row.priority as Feature['priority'],
    portal_scope: parsePortalScope(row.portal_scope as string),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    removed_at: (row.removed_at as string) || null,
    removed_reason: (row.removed_reason as string) || null,
  };
}

// ============================================================
// Core CRUD
// ============================================================

export function upsertFeature(db: Database.Database, input: FeatureInput): number {
  const existing = db.prepare('SELECT id FROM massu_sentinel WHERE feature_key = ?').get(input.feature_key) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE massu_sentinel SET
        domain = ?, subdomain = ?, title = ?, description = ?,
        status = COALESCE(?, status), priority = COALESCE(?, priority),
        portal_scope = COALESCE(?, portal_scope),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.domain,
      input.subdomain || null,
      input.title,
      input.description || null,
      input.status || null,
      input.priority || null,
      input.portal_scope ? JSON.stringify(input.portal_scope) : null,
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO massu_sentinel (feature_key, domain, subdomain, title, description, status, priority, portal_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feature_key,
    input.domain,
    input.subdomain || null,
    input.title,
    input.description || null,
    input.status || 'active',
    input.priority || 'standard',
    JSON.stringify(input.portal_scope || [])
  );

  return Number(result.lastInsertRowid);
}

export function getFeature(db: Database.Database, featureKey: string): Feature | null {
  const row = db.prepare('SELECT * FROM massu_sentinel WHERE feature_key = ?').get(featureKey) as Record<string, unknown> | undefined;
  return row ? toFeature(row) : null;
}

export function getFeatureById(db: Database.Database, id: number): Feature | null {
  const row = db.prepare('SELECT * FROM massu_sentinel WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toFeature(row) : null;
}

// ============================================================
// Search & Query
// ============================================================

export function searchFeatures(
  db: Database.Database,
  query: string,
  filters?: { domain?: string; subdomain?: string; status?: string; portal?: string; page_route?: string }
): FeatureWithCounts[] {
  let sql: string;
  const params: unknown[] = [];

  if (query && query.trim()) {
    // FTS5 search
    sql = `
      SELECT s.*, fts.rank,
        (SELECT COUNT(*) FROM massu_sentinel_components WHERE feature_id = s.id) as component_count,
        (SELECT COUNT(*) FROM massu_sentinel_procedures WHERE feature_id = s.id) as procedure_count,
        (SELECT COUNT(*) FROM massu_sentinel_pages WHERE feature_id = s.id) as page_count
      FROM massu_sentinel s
      JOIN massu_sentinel_fts fts ON s.id = fts.rowid
      WHERE massu_sentinel_fts MATCH ?
    `;
    params.push(sanitizeFts5Query(query));
  } else {
    sql = `
      SELECT s.*,
        (SELECT COUNT(*) FROM massu_sentinel_components WHERE feature_id = s.id) as component_count,
        (SELECT COUNT(*) FROM massu_sentinel_procedures WHERE feature_id = s.id) as procedure_count,
        (SELECT COUNT(*) FROM massu_sentinel_pages WHERE feature_id = s.id) as page_count
      FROM massu_sentinel s
      WHERE 1=1
    `;
  }

  if (filters?.domain) {
    sql += ' AND s.domain = ?';
    params.push(filters.domain);
  }
  if (filters?.subdomain) {
    sql += ' AND s.subdomain = ?';
    params.push(filters.subdomain);
  }
  if (filters?.status) {
    sql += ' AND s.status = ?';
    params.push(filters.status);
  }
  if (filters?.portal) {
    sql += ` AND s.portal_scope LIKE ? ESCAPE '\\'`;
    const escapedPortal = filters.portal.replace(/[%_]/g, '\\$&');
    params.push(`%"${escapedPortal}"%`);
  }
  if (filters?.page_route) {
    sql += ' AND s.id IN (SELECT feature_id FROM massu_sentinel_pages WHERE page_route = ?)';
    params.push(filters.page_route);
  }

  sql += query && query.trim() ? ' ORDER BY fts.rank LIMIT 100' : ' ORDER BY s.domain, s.subdomain, s.feature_key LIMIT 100';

  const rows = db.prepare(sql).all(...params) as (Record<string, unknown>)[];
  return rows.map(row => ({
    ...toFeature(row),
    component_count: row.component_count as number,
    procedure_count: row.procedure_count as number,
    page_count: row.page_count as number,
  }));
}

export function getFeaturesByDomain(db: Database.Database, domain: string): Feature[] {
  const rows = db.prepare('SELECT * FROM massu_sentinel WHERE domain = ? ORDER BY subdomain, feature_key').all(domain) as Record<string, unknown>[];
  return rows.map(toFeature);
}

export function getFeaturesByFile(db: Database.Database, filePath: string): Feature[] {
  const rows = db.prepare(`
    SELECT DISTINCT s.* FROM massu_sentinel s
    JOIN massu_sentinel_components c ON c.feature_id = s.id
    WHERE c.component_file = ?
    ORDER BY s.feature_key
  `).all(filePath) as Record<string, unknown>[];
  return rows.map(toFeature);
}

export function getFeaturesByRoute(db: Database.Database, route: string): Feature[] {
  const rows = db.prepare(`
    SELECT DISTINCT s.* FROM massu_sentinel s
    JOIN massu_sentinel_pages p ON p.feature_id = s.id
    WHERE p.page_route = ?
    ORDER BY s.feature_key
  `).all(route) as Record<string, unknown>[];
  return rows.map(toFeature);
}

// ============================================================
// Feature Detail (full join)
// ============================================================

export function getFeatureDetail(db: Database.Database, featureKeyOrId: string | number): FeatureDetail | null {
  let feature: Feature | null;
  if (typeof featureKeyOrId === 'number') {
    feature = getFeatureById(db, featureKeyOrId);
  } else {
    feature = getFeature(db, featureKeyOrId);
  }
  if (!feature) return null;

  const components = db.prepare('SELECT * FROM massu_sentinel_components WHERE feature_id = ?').all(feature.id) as FeatureComponent[];
  const procedures = db.prepare('SELECT * FROM massu_sentinel_procedures WHERE feature_id = ?').all(feature.id) as FeatureProcedure[];
  const pages = db.prepare('SELECT * FROM massu_sentinel_pages WHERE feature_id = ?').all(feature.id) as FeaturePage[];
  const dependencies = db.prepare('SELECT * FROM massu_sentinel_deps WHERE feature_id = ?').all(feature.id) as FeatureDep[];
  const changelog = db.prepare('SELECT * FROM massu_sentinel_changelog WHERE feature_id = ? ORDER BY created_at DESC LIMIT 50').all(feature.id) as FeatureChangeLog[];

  return { ...feature, components, procedures, pages, dependencies, changelog };
}

// ============================================================
// Orphan & Impact Detection
// ============================================================

export function getOrphanedFeatures(db: Database.Database): Feature[] {
  // Active features with no living primary component files
  const features = db.prepare(`
    SELECT s.* FROM massu_sentinel s
    WHERE s.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM massu_sentinel_components c
      WHERE c.feature_id = s.id AND c.is_primary = 1
    )
    ORDER BY s.domain, s.feature_key
  `).all() as Record<string, unknown>[];
  return features.map(toFeature);
}

export function getFeatureImpact(db: Database.Database, filePaths: string[]): ImpactReport {
  const fileSet = new Set(filePaths);
  const affectedFeatureIds = new Set<number>();

  // Find all features linked to these files
  for (const filePath of filePaths) {
    const links = db.prepare(
      'SELECT feature_id FROM massu_sentinel_components WHERE component_file = ?'
    ).all(filePath) as { feature_id: number }[];
    for (const link of links) {
      affectedFeatureIds.add(link.feature_id);
    }
  }

  const orphaned: ImpactItem[] = [];
  const degraded: ImpactItem[] = [];
  const unaffected: ImpactItem[] = [];

  for (const featureId of affectedFeatureIds) {
    const feature = getFeatureById(db, featureId);
    if (!feature || feature.status !== 'active') continue;

    const allComponents = db.prepare(
      'SELECT component_file, is_primary FROM massu_sentinel_components WHERE feature_id = ?'
    ).all(featureId) as { component_file: string; is_primary: number }[];

    const affected = allComponents.filter(c => fileSet.has(c.component_file));
    const remaining = allComponents.filter(c => !fileSet.has(c.component_file));
    const primaryAffected = affected.some(c => c.is_primary);

    const item: ImpactItem = {
      feature,
      affected_files: affected.map(c => c.component_file),
      remaining_files: remaining.map(c => c.component_file),
      status: 'unaffected',
    };

    if (primaryAffected && remaining.filter(c => c.is_primary).length === 0) {
      item.status = 'orphaned';
      orphaned.push(item);
    } else if (affected.length > 0) {
      item.status = 'degraded';
      degraded.push(item);
    } else {
      unaffected.push(item);
    }
  }

  const hasCriticalOrphans = orphaned.some(o => o.feature.priority === 'critical');
  const hasStandardOrphans = orphaned.some(o => o.feature.priority === 'standard');

  return {
    files_analyzed: filePaths,
    orphaned,
    degraded,
    unaffected,
    blocked: hasCriticalOrphans || hasStandardOrphans,
    block_reason: hasCriticalOrphans
      ? `BLOCKED: ${orphaned.length} features would be orphaned (includes critical features). Create migration plan first.`
      : hasStandardOrphans
      ? `BLOCKED: ${orphaned.length} standard features would be orphaned. Create migration plan first.`
      : null,
  };
}

// ============================================================
// Links: Components, Procedures, Pages
// ============================================================

export function linkComponent(
  db: Database.Database,
  featureId: number,
  filePath: string,
  componentName: string | null,
  role: ComponentRole = 'implementation',
  isPrimary: boolean = false
): void {
  db.prepare(`
    INSERT OR REPLACE INTO massu_sentinel_components (feature_id, component_file, component_name, role, is_primary)
    VALUES (?, ?, ?, ?, ?)
  `).run(featureId, filePath, componentName, role, isPrimary ? 1 : 0);
}

export function linkProcedure(
  db: Database.Database,
  featureId: number,
  routerName: string,
  procedureName: string,
  procedureType?: string
): void {
  db.prepare(`
    INSERT OR REPLACE INTO massu_sentinel_procedures (feature_id, router_name, procedure_name, procedure_type)
    VALUES (?, ?, ?, ?)
  `).run(featureId, routerName, procedureName, procedureType || null);
}

export function linkPage(
  db: Database.Database,
  featureId: number,
  route: string,
  portal?: string
): void {
  db.prepare(`
    INSERT OR REPLACE INTO massu_sentinel_pages (feature_id, page_route, portal)
    VALUES (?, ?, ?)
  `).run(featureId, route, portal || null);
}

// ============================================================
// Changelog
// ============================================================

export function logChange(
  db: Database.Database,
  featureId: number,
  changeType: string,
  detail: string | null,
  commitHash?: string,
  changedBy: string = 'claude-code'
): void {
  db.prepare(`
    INSERT INTO massu_sentinel_changelog (feature_id, change_type, changed_by, change_detail, commit_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(featureId, changeType, changedBy, detail, commitHash || null);
}

// ============================================================
// Validation
// ============================================================

export function validateFeatures(db: Database.Database, domainFilter?: string): ValidationReport {
  let sql = `SELECT * FROM massu_sentinel WHERE status = 'active'`;
  const params: unknown[] = [];
  if (domainFilter) {
    sql += ' AND domain = ?';
    params.push(domainFilter);
  }
  sql += ' ORDER BY domain, feature_key';

  const features = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const details: ValidationItem[] = [];
  let alive = 0;
  let orphaned = 0;
  let degradedCount = 0;

  for (const row of features) {
    const feature = toFeature(row);
    const components = db.prepare('SELECT * FROM massu_sentinel_components WHERE feature_id = ?').all(feature.id) as FeatureComponent[];
    const procedures = db.prepare('SELECT * FROM massu_sentinel_procedures WHERE feature_id = ?').all(feature.id) as FeatureProcedure[];
    const pages = db.prepare('SELECT * FROM massu_sentinel_pages WHERE feature_id = ?').all(feature.id) as FeaturePage[];

    const missingComponents: string[] = [];
    const missingProcedures: { router: string; procedure: string }[] = [];
    const missingPages: string[] = [];

    // Check component files exist on disk
    for (const comp of components) {
      const absPath = resolve(PROJECT_ROOT, comp.component_file);
      if (!existsSync(absPath)) {
        missingComponents.push(comp.component_file);
      }
    }

    // Check procedure files exist and contain the procedure
    for (const proc of procedures) {
      // Look for the router file based on convention
      const routerPath = resolve(PROJECT_ROOT, `src/server/api/routers/${proc.router_name}.ts`);
      if (!existsSync(routerPath)) {
        missingProcedures.push({ router: proc.router_name, procedure: proc.procedure_name });
      }
    }

    // Check page routes exist
    for (const page of pages) {
      const routeToPath = page.page_route
        .replace(/^\/(portal-[^/]+\/)?/, 'src/app/')
        .replace(/\/$/, '')
        + '/page.tsx';
      const absPath = resolve(PROJECT_ROOT, routeToPath);
      // Page route checking is approximate - don't flag as missing if path conversion is ambiguous
      if (page.page_route.startsWith('/') && !existsSync(absPath)) {
        // Try alternative path patterns
        const altPath = resolve(PROJECT_ROOT, `src/app${page.page_route}/page.tsx`);
        if (!existsSync(altPath)) {
          missingPages.push(page.page_route);
        }
      }
    }

    const hasMissing = missingComponents.length > 0 || missingProcedures.length > 0;
    const primaryMissing = components.filter(c => c.is_primary && missingComponents.includes(c.component_file)).length > 0;
    const allPrimaryMissing = components.filter(c => c.is_primary).length > 0 &&
      components.filter(c => c.is_primary).every(c => missingComponents.includes(c.component_file));

    let status: 'alive' | 'orphaned' | 'degraded';
    if (allPrimaryMissing || (components.length > 0 && missingComponents.length === components.length)) {
      status = 'orphaned';
      orphaned++;
    } else if (hasMissing) {
      status = 'degraded';
      degradedCount++;
    } else {
      status = 'alive';
      alive++;
    }

    details.push({
      feature,
      missing_components: missingComponents,
      missing_procedures: missingProcedures,
      missing_pages: missingPages,
      status,
    });
  }

  return { alive, orphaned, degraded: degradedCount, details };
}

// ============================================================
// Parity Check (for rebuild scenarios)
// ============================================================

export function checkParity(db: Database.Database, oldFiles: string[], newFiles: string[]): ParityReport {
  const oldFileSet = new Set(oldFiles);
  const newFileSet = new Set(newFiles);

  // Find features linked to old files
  const oldFeatureIds = new Set<number>();
  for (const file of oldFiles) {
    const links = db.prepare('SELECT feature_id FROM massu_sentinel_components WHERE component_file = ?').all(file) as { feature_id: number }[];
    for (const link of links) {
      oldFeatureIds.add(link.feature_id);
    }
  }

  // Find features linked to new files
  const newFeatureIds = new Set<number>();
  for (const file of newFiles) {
    const links = db.prepare('SELECT feature_id FROM massu_sentinel_components WHERE component_file = ?').all(file) as { feature_id: number }[];
    for (const link of links) {
      newFeatureIds.add(link.feature_id);
    }
  }

  const done: ParityItem[] = [];
  const gaps: ParityItem[] = [];
  const newFeatures: ParityItem[] = [];

  // Features in old that are also in new = DONE
  // Features in old but NOT in new = GAP
  for (const fId of oldFeatureIds) {
    const feature = getFeatureById(db, fId);
    if (!feature) continue;

    const oldComps = db.prepare('SELECT component_file FROM massu_sentinel_components WHERE feature_id = ? AND component_file IN (' + oldFiles.map(() => '?').join(',') + ')').all(fId, ...oldFiles) as { component_file: string }[];
    const newComps = db.prepare('SELECT component_file FROM massu_sentinel_components WHERE feature_id = ? AND component_file IN (' + newFiles.map(() => '?').join(',') + ')').all(fId, ...newFiles) as { component_file: string }[];

    const item: ParityItem = {
      feature_key: feature.feature_key,
      title: feature.title,
      status: newFeatureIds.has(fId) ? 'DONE' : 'GAP',
      old_files: oldComps.map(c => c.component_file),
      new_files: newComps.map(c => c.component_file),
    };

    if (item.status === 'DONE') {
      done.push(item);
    } else {
      gaps.push(item);
    }
  }

  // Features only in new = NEW
  for (const fId of newFeatureIds) {
    if (oldFeatureIds.has(fId)) continue;
    const feature = getFeatureById(db, fId);
    if (!feature) continue;

    const newComps = db.prepare('SELECT component_file FROM massu_sentinel_components WHERE feature_id = ? AND component_file IN (' + newFiles.map(() => '?').join(',') + ')').all(fId, ...newFiles) as { component_file: string }[];

    newFeatures.push({
      feature_key: feature.feature_key,
      title: feature.title,
      status: 'NEW',
      old_files: [],
      new_files: newComps.map(c => c.component_file),
    });
  }

  const total = done.length + gaps.length;
  const parityPercentage = total > 0 ? Math.round((done.length / total) * 100) : 100;

  return { done, gaps, new_features: newFeatures, parity_percentage: parityPercentage };
}

// ============================================================
// Bulk operations for scanner
// ============================================================

export function clearAutoDiscoveredFeatures(db: Database.Database): void {
  // Only clear features that were auto-discovered (not manually registered)
  // We use the changelog to distinguish: auto-discovered ones have changed_by = 'scanner'
  const autoIds = db.prepare(`
    SELECT DISTINCT feature_id FROM massu_sentinel_changelog
    WHERE changed_by = 'scanner' AND change_type = 'created'
  `).all() as { feature_id: number }[];

  // Don't delete features that also have manual changes
  for (const { feature_id } of autoIds) {
    const hasManualChanges = db.prepare(`
      SELECT 1 FROM massu_sentinel_changelog
      WHERE feature_id = ? AND changed_by != 'scanner'
    `).get(feature_id);

    if (!hasManualChanges) {
      db.prepare('DELETE FROM massu_sentinel WHERE id = ?').run(feature_id);
    }
  }
}

export function bulkUpsertFeatures(db: Database.Database, features: FeatureInput[]): number {
  let count = 0;
  const upsert = db.transaction((items: FeatureInput[]) => {
    for (const item of items) {
      upsertFeature(db, item);
      count++;
    }
  });
  upsert(features);
  return count;
}

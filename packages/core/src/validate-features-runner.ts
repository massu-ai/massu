#!/usr/bin/env npx tsx
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Standalone feature validation runner
// Called by scripts/validate-features.sh
// Directly imports sentinel-db.ts (no MCP protocol needed)
// ============================================================

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { getProjectRoot, getResolvedPaths } from './config.ts';

const PROJECT_ROOT = getProjectRoot();

function main(): void {
  const dbPath = getResolvedPaths().dataDbPath;

  if (!existsSync(dbPath)) {
    console.log('Sentinel: No data DB found - skipping feature validation (run sync first)');
    process.exit(0);
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
  } catch (error) {
    console.log('Sentinel: Could not open data DB - skipping feature validation');
    process.exit(0);
  }

  try {
    // Check if sentinel tables exist
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='massu_sentinel'"
    ).get();

    if (!tableExists) {
      console.log('Sentinel: Feature registry not initialized - skipping (run sync first)');
      process.exit(0);
    }

    // Count active features
    const totalActive = db.prepare(
      "SELECT COUNT(*) as count FROM massu_sentinel WHERE status = 'active'"
    ).get() as { count: number };

    if (totalActive.count === 0) {
      console.log('Sentinel: No active features registered - skipping validation');
      process.exit(0);
    }

    // Check for orphaned features (active features with missing primary component files)
    const orphaned = db.prepare(`
      SELECT s.feature_key, s.title, s.priority, c.component_file
      FROM massu_sentinel s
      JOIN massu_sentinel_components c ON c.feature_id = s.id AND c.is_primary = 1
      WHERE s.status = 'active'
      ORDER BY s.priority DESC, s.domain, s.feature_key
    `).all() as { feature_key: string; title: string; priority: string; component_file: string }[];

    const missingFeatures: { feature_key: string; title: string; priority: string; missing_file: string }[] = [];

    for (const row of orphaned) {
      const absPath = resolve(PROJECT_ROOT, row.component_file);
      if (!existsSync(absPath)) {
        missingFeatures.push({
          feature_key: row.feature_key,
          title: row.title,
          priority: row.priority,
          missing_file: row.component_file,
        });
      }
    }

    console.log(`Sentinel: ${totalActive.count} active features, checking primary components...`);

    if (missingFeatures.length === 0) {
      console.log('Sentinel: All active features have living primary components. PASS');
      process.exit(0);
    } else {
      console.error(`Sentinel: ${missingFeatures.length} features have MISSING primary components:`);
      for (const f of missingFeatures) {
        console.error(`  [${f.priority}] ${f.feature_key}: ${f.title}`);
        console.error(`    Missing: ${f.missing_file}`);
      }

      const criticalCount = missingFeatures.filter(f => f.priority === 'critical').length;
      if (criticalCount > 0) {
        console.error(`\nFAIL: ${criticalCount} CRITICAL features are orphaned. Fix before committing.`);
        process.exit(1);
      } else {
        console.warn(`\nWARN: ${missingFeatures.length} features are orphaned (non-critical). Consider updating registry.`);
        // Non-critical orphans are warnings, not blockers
        process.exit(0);
      }
    }
  } finally {
    db.close();
  }
}

main();

#!/usr/bin/env npx tsx
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Standalone feature validation runner
// Called by scripts/validate-features.sh
// Directly imports sentinel-db.ts (no MCP protocol needed)
// ============================================================

import type Database from 'better-sqlite3';
import { openDatabase } from './lib/sqlite-loader.ts';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { getProjectRoot, getResolvedPaths } from './config.ts';
import { t } from './lib/sql-table-names.ts';

const PROJECT_ROOT = getProjectRoot();

function main(): void {
  const dbPath = getResolvedPaths().dataDbPath;

  if (!existsSync(dbPath)) {
    // P-M-037 (plan-stage-d-medium-sweep): structured warning replaces silent
    // skip. CR-39 contract: customer must see that validation didn't run.
    // The telemetry event lets ops alert on "validation never ran in N days"
    // (Vercel / Sentry breadcrumb scope; emitter is logged once at process
    // boundary so the CLI's stderr stream remains readable for humans).
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        event: 'validation_skipped_no_db',
        reason: 'data_db_not_found',
        message: 'Sentinel: No data DB found - skipping feature validation (run sync first)',
        dbPath,
      }) + '\n',
    );
    process.exit(0);
  }

  let db: Database.Database;
  try {
    db = openDatabase(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
  } catch (error) {
    // P-M-037: structured warning replaces silent skip.
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        event: 'validation_skipped_no_db',
        reason: 'data_db_open_failed',
        message: 'Sentinel: Could not open data DB - skipping feature validation',
        error: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
    process.exit(0);
  }

  try {
    // Check if sentinel tables exist
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=`${t('sentinel')}`"
    ).get();

    if (!tableExists) {
      process.stderr.write('Sentinel: Feature registry not initialized - skipping (run sync first)\n');
      process.exit(0);
    }

    // Count active features
    const totalActive = db.prepare(
      `SELECT COUNT(*) as count FROM ${t('sentinel')} WHERE status = 'active'`
    ).get() as { count: number };

    if (totalActive.count === 0) {
      process.stderr.write('Sentinel: No active features registered - skipping validation\n');
      process.exit(0);
    }

    // Check for orphaned features (active features with missing primary
    // component files). LIMIT 100000 caps total active features (P-DG-001) —
    // multiple orders beyond realistic project size.
    const orphaned = db.prepare(`
      SELECT s.feature_key, s.title, s.priority, c.component_file
      FROM ${t('sentinel')} s
      JOIN ${t('sentinel_components')} c ON c.feature_id = s.id AND c.is_primary = 1
      WHERE s.status = 'active'
      ORDER BY s.priority DESC, s.domain, s.feature_key
      LIMIT 100000
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

    process.stderr.write(`Sentinel: ${totalActive.count} active features, checking primary components...\n`);

    if (missingFeatures.length === 0) {
      process.stderr.write('Sentinel: All active features have living primary components. PASS\n');
      process.exit(0);
    } else {
      process.stderr.write(`Sentinel: ${missingFeatures.length} features have MISSING primary components:\n`);
      for (const f of missingFeatures) {
        process.stderr.write(`  [${f.priority}] ${f.feature_key}: ${f.title}\n`);
        process.stderr.write(`    Missing: ${f.missing_file}\n`);
      }

      const criticalCount = missingFeatures.filter(f => f.priority === 'critical').length;
      if (criticalCount > 0) {
        process.stderr.write(`\nFAIL: ${criticalCount} CRITICAL features are orphaned. Fix before committing.\n`);
        process.exit(1);
      } else {
        process.stderr.write(`\nWARN: ${missingFeatures.length} features are orphaned (non-critical). Consider updating registry.\n`);
        // Non-critical orphans are warnings, not blockers
        process.exit(0);
      }
    }
  } finally {
    db.close();
  }
}

main();

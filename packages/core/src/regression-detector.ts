// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';

// ============================================================
// Regression Detection
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

/** Default health thresholds. Configurable via regression.health_thresholds */
const DEFAULT_HEALTH_THRESHOLDS = {
  healthy: 80,
  warning: 50,
};

/**
 * Get health thresholds from config or defaults.
 */
function getHealthThresholds(): { healthy: number; warning: number } {
  const configured = getConfig().regression?.health_thresholds;
  return {
    healthy: configured?.healthy ?? DEFAULT_HEALTH_THRESHOLDS.healthy,
    warning: configured?.warning ?? DEFAULT_HEALTH_THRESHOLDS.warning,
  };
}

/**
 * Calculate feature health score based on modification/test gaps.
 * 0 = critical, 100 = healthy.
 */
export function calculateHealthScore(
  testsPassing: number,
  testsFailing: number,
  modificationsSinceTest: number,
  lastTested: string | null,
  lastModified: string | null
): number {
  let score = 100;

  // Test failures
  if (testsFailing > 0) {
    score -= Math.min(40, testsFailing * 10);
  }

  // Modifications since last test
  if (modificationsSinceTest > 0) {
    score -= Math.min(30, modificationsSinceTest * 5);
  }

  // Time gap between modification and test
  if (lastModified && lastTested) {
    const modDate = new Date(lastModified).getTime();
    const testDate = new Date(lastTested).getTime();
    if (modDate > testDate) {
      const daysSinceTest = (modDate - testDate) / (1000 * 60 * 60 * 24);
      score -= Math.min(20, Math.floor(daysSinceTest * 2));
    }
  } else if (lastModified && !lastTested) {
    // Modified but never tested
    score -= 30;
  }

  return Math.max(0, score);
}

/**
 * Update feature health when a file is modified.
 */
export function trackModification(
  db: Database.Database,
  featureKey: string
): void {
  const existing = db.prepare(
    'SELECT * FROM feature_health WHERE feature_key = ?'
  ).get(featureKey) as Record<string, unknown> | undefined;

  if (existing) {
    db.prepare(`
      UPDATE feature_health
      SET last_modified = datetime('now'),
          modifications_since_test = modifications_since_test + 1,
          health_score = ?
      WHERE feature_key = ?
    `).run(
      calculateHealthScore(
        (existing.tests_passing as number) ?? 0,
        (existing.tests_failing as number) ?? 0,
        ((existing.modifications_since_test as number) ?? 0) + 1,
        existing.last_tested as string | null,
        new Date().toISOString()
      ),
      featureKey
    );
  } else {
    db.prepare(`
      INSERT INTO feature_health
      (feature_key, last_modified, modifications_since_test, health_score, tests_passing, tests_failing)
      VALUES (?, datetime('now'), 1, 70, 0, 0)
    `).run(featureKey);
  }
}

/**
 * Record test results for a feature.
 */
export function recordTestResult(
  db: Database.Database,
  featureKey: string,
  passing: number,
  failing: number
): void {
  const existing = db.prepare(
    'SELECT * FROM feature_health WHERE feature_key = ?'
  ).get(featureKey) as Record<string, unknown> | undefined;

  const healthScore = calculateHealthScore(passing, failing, 0, new Date().toISOString(), existing?.last_modified as string | null);

  db.prepare(`
    INSERT INTO feature_health
    (feature_key, last_tested, test_coverage_pct, health_score, tests_passing, tests_failing, modifications_since_test)
    VALUES (?, datetime('now'), ?, ?, ?, ?, 0)
    ON CONFLICT(feature_key) DO UPDATE SET
      last_tested = datetime('now'),
      health_score = ?,
      tests_passing = ?,
      tests_failing = ?,
      modifications_since_test = 0
  `).run(
    featureKey, passing > 0 ? (passing / (passing + failing)) * 100 : 0,
    healthScore, passing, failing,
    healthScore, passing, failing
  );
}

/**
 * Build alerts for unhealthy features.
 */
function buildAlerts(feature: Record<string, unknown>): string[] {
  const alerts: string[] = [];

  if ((feature.tests_failing as number) > 0) {
    alerts.push(`${feature.tests_failing} tests failing`);
  }
  if ((feature.modifications_since_test as number) > 3) {
    alerts.push(`${feature.modifications_since_test} modifications since last test`);
  }
  if (!feature.last_tested && feature.last_modified) {
    alerts.push('Never tested');
  }

  return alerts;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getRegressionToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('feature_health'),
      description: 'Feature health dashboard. Shows health scores, modification/test gaps, and alerts for registered features.',
      inputSchema: {
        type: 'object',
        properties: {
          unhealthy_only: { type: 'boolean', description: 'Show only features with health below warning threshold (default: false)' },
        },
        required: [],
      },
    },
    {
      name: p('regression_risk'),
      description: 'Check if recent changes risk regression. Shows affected features, test coverage status, and risk assessment.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ];
}

const REGRESSION_BASE_NAMES = new Set(['feature_health', 'regression_risk']);

export function isRegressionTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return REGRESSION_BASE_NAMES.has(baseName);
}

export function handleRegressionToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'feature_health':
        return handleFeatureHealth(args, memoryDb);
      case 'regression_risk':
        return handleRegressionCheck(args, memoryDb);
      default:
        return text(`Unknown regression tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('feature_health')} { unhealthy_only: true }, ${p('regression_risk')} {}`);
  }
}

function handleFeatureHealth(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const unhealthyOnly = args.unhealthy_only as boolean | undefined;
  const thresholds = getHealthThresholds();

  let sql = 'SELECT * FROM feature_health';
  const params: (string | number)[] = [];

  if (unhealthyOnly) {
    sql += ' WHERE health_score < ?';
    params.push(thresholds.healthy);
  }

  sql += ' ORDER BY health_score ASC';

  const features = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  if (features.length === 0) {
    const filterMsg = unhealthyOnly
      ? `No unhealthy features found (threshold: ${thresholds.healthy}). All tracked features are currently healthy. Use ${p('feature_health')} {} without filters to see all features.`
      : `No feature health data available yet. Feature health is tracked automatically when files in registered features are modified and tested. Try: ${p('regression_risk')} {} to check for untested modifications.`;
    return text(filterMsg);
  }

  const lines = [
    `## Feature Health Dashboard`,
    `Features tracked: ${features.length}`,
    '',
    '| Feature | Health | Tests P/F | Mods Since Test | Alerts |',
    '|---------|--------|-----------|-----------------|--------|',
  ];

  for (const f of features) {
    const alerts = buildAlerts(f);
    const healthScore = f.health_score as number;
    const healthIndicator = healthScore >= thresholds.healthy ? 'OK'
      : healthScore >= thresholds.warning ? 'WARN'
      : 'CRIT';

    lines.push(
      `| ${f.feature_key} | ${healthScore} [${healthIndicator}] | ${f.tests_passing ?? 0}/${f.tests_failing ?? 0} | ${f.modifications_since_test ?? 0} | ${alerts.join('; ') || '-'} |`
    );
  }

  return text(lines.join('\n'));
}

function handleRegressionCheck(_args: Record<string, unknown>, db: Database.Database): ToolResult {
  const thresholds = getHealthThresholds();

  const recentlyModified = db.prepare(`
    SELECT feature_key, health_score, modifications_since_test, tests_failing, last_modified, last_tested
    FROM feature_health
    WHERE modifications_since_test > 0
    ORDER BY modifications_since_test DESC
    LIMIT 500
  `).all() as Array<Record<string, unknown>>;

  if (recentlyModified.length === 0) {
    return text(`No features have been modified since their last test run. Low regression risk. Use ${p('feature_health')} {} to see the full feature health dashboard.`);
  }

  const highRisk = recentlyModified.filter(f => (f.health_score as number) < thresholds.warning);
  const mediumRisk = recentlyModified.filter(f => (f.health_score as number) >= thresholds.warning && (f.health_score as number) < thresholds.healthy);
  const lowRisk = recentlyModified.filter(f => (f.health_score as number) >= thresholds.healthy);

  const lines = [
    `## Regression Risk Assessment`,
    `Features with untested modifications: ${recentlyModified.length}`,
    `High risk: ${highRisk.length} | Medium: ${mediumRisk.length} | Low: ${lowRisk.length}`,
    '',
  ];

  if (highRisk.length > 0) {
    lines.push('### HIGH RISK (test immediately)');
    for (const f of highRisk) {
      lines.push(`- **${f.feature_key}** (health: ${f.health_score}, ${f.modifications_since_test} untested modifications)`);
    }
    lines.push('');
  }

  if (mediumRisk.length > 0) {
    lines.push('### Medium Risk');
    for (const f of mediumRisk) {
      lines.push(`- ${f.feature_key} (health: ${f.health_score}, ${f.modifications_since_test} untested modifications)`);
    }
    lines.push('');
  }

  if (lowRisk.length > 0) {
    lines.push('### Low Risk');
    for (const f of lowRisk) {
      lines.push(`- ${f.feature_key} (health: ${f.health_score})`);
    }
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

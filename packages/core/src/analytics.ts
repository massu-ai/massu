// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';

// ============================================================
// Quality Trend Analytics
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

export interface QualityBreakdown {
  security: number;
  architecture: number;
  coupling: number;
  tests: number;
  rule_compliance: number;
  [key: string]: number;
}

/** Default scoring weights. Can be overridden via config.analytics.quality.weights */
const DEFAULT_WEIGHTS: Record<string, number> = {
  bug_found: -5,
  vr_failure: -10,
  incident: -20,
  cr_violation: -3,
  vr_pass: 2,
  clean_commit: 5,
  successful_verification: 3,
};

/** Default quality categories */
const DEFAULT_CATEGORIES = ['security', 'architecture', 'coupling', 'tests', 'rule_compliance'];

/**
 * Get the scoring weights from config or defaults.
 */
function getWeights(): Record<string, number> {
  return getConfig().analytics?.quality?.weights ?? DEFAULT_WEIGHTS;
}

/**
 * Get the quality categories from config or defaults.
 */
function getCategories(): string[] {
  return getConfig().analytics?.quality?.categories ?? DEFAULT_CATEGORIES;
}

/**
 * Calculate a quality score from observations in a session.
 * Score starts at 50 and adjusts based on weighted events.
 */
export function calculateQualityScore(
  db: Database.Database,
  sessionId: string
): { score: number; breakdown: QualityBreakdown } {
  const weights = getWeights();
  const categories = getCategories();

  const observations = db.prepare(
    'SELECT type, detail FROM observations WHERE session_id = ?'
  ).all(sessionId) as Array<{ type: string; detail: string }>;

  let score = 50; // Base score
  const breakdown: QualityBreakdown = Object.fromEntries(
    categories.map(c => [c, 0])
  ) as QualityBreakdown;

  for (const obs of observations) {
    const weight = weights[obs.type] ?? 0;
    score += weight;

    // Categorize observation
    const desc = (obs.detail ?? '').toLowerCase();
    for (const category of categories) {
      if (desc.includes(category)) {
        breakdown[category] += weight;
      }
    }
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown,
  };
}

/**
 * Store a quality score for a session.
 */
export function storeQualityScore(
  db: Database.Database,
  sessionId: string,
  score: number,
  breakdown: QualityBreakdown
): void {
  db.prepare(`
    INSERT INTO session_quality_scores
    (session_id, score, security_score, architecture_score, coupling_score, test_score, rule_compliance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, score,
    breakdown.security ?? 0,
    breakdown.architecture ?? 0,
    breakdown.coupling ?? 0,
    breakdown.tests ?? 0,
    breakdown.rule_compliance ?? 0
  );
}

/**
 * Backfill quality scores for sessions that don't have them.
 */
export function backfillQualityScores(db: Database.Database): number {
  const sessions = db.prepare(`
    SELECT DISTINCT s.session_id
    FROM sessions s
    LEFT JOIN session_quality_scores q ON s.session_id = q.session_id
    WHERE q.session_id IS NULL
  `).all() as Array<{ session_id: string }>;

  let backfilled = 0;
  for (const session of sessions) {
    const { score, breakdown } = calculateQualityScore(db, session.session_id);
    storeQualityScore(db, session.session_id, score, breakdown);
    backfilled++;
  }

  return backfilled;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getAnalyticsToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('quality_score'),
      description: 'Calculate and store quality score for a session based on observations. Shows breakdown by category.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID to score' },
        },
        required: ['session_id'],
      },
    },
    {
      name: p('quality_trend'),
      description: 'Quality trend over recent sessions. Shows score progression and identifies improving/declining areas.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days to look back (default: 30)' },
        },
        required: [],
      },
    },
    {
      name: p('quality_report'),
      description: 'Comprehensive quality report with averages, trends, and recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days to cover (default: 30)' },
        },
        required: [],
      },
    },
  ];
}

const ANALYTICS_BASE_NAMES = new Set(['quality_score', 'quality_trend', 'quality_report']);

export function isAnalyticsTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return ANALYTICS_BASE_NAMES.has(baseName);
}

export function handleAnalyticsToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'quality_score':
        return handleQualityScore(args, memoryDb);
      case 'quality_trend':
        return handleQualityTrend(args, memoryDb);
      case 'quality_report':
        return handleQualityReport(args, memoryDb);
      default:
        return text(`Unknown analytics tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('quality_score')} { session_id: "..." }, ${p('quality_trend')} { days: 30 }`);
  }
}

function handleQualityScore(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const sessionId = args.session_id as string;
  if (!sessionId) return text(`Usage: ${p('quality_score')} { session_id: "abc123" } - Calculate quality score for a specific session.`);

  const { score, breakdown } = calculateQualityScore(db, sessionId);
  storeQualityScore(db, sessionId, score, breakdown);

  const categories = getCategories();
  const lines = [
    `## Quality Score: ${score}/100`,
    '',
    '### Breakdown',
    '| Category | Impact |',
    '|----------|--------|',
  ];

  for (const category of categories) {
    const impact = breakdown[category] ?? 0;
    const indicator = impact > 0 ? '+' : impact < 0 ? '' : ' ';
    lines.push(`| ${category} | ${indicator}${impact} |`);
  }

  return text(lines.join('\n'));
}

function handleQualityTrend(args: Record<string, unknown>, db: Database.Database, retried = false): ToolResult {
  const days = (args.days as number) ?? 30;

  const scores = db.prepare(`
    SELECT session_id, score, security_score, architecture_score, coupling_score, test_score, rule_compliance_score, created_at
    FROM session_quality_scores
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at ASC
  `).all(`-${days} days`) as Array<{
    session_id: string;
    score: number;
    created_at: string;
  }>;

  if (scores.length === 0) {
    if (!retried) {
      const backfilled = backfillQualityScores(db);
      if (backfilled > 0) {
        return handleQualityTrend(args, db, true);
      }
    }
    return text(`No quality scores found in the last ${days} days. Quality scores are calculated automatically from session observations (bugfixes, VR checks, incidents). Try: ${p('quality_score')} { session_id: "..." } to score a specific session, or try a longer time range with { days: 90 }.`);
  }

  const avg = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const recent = scores.slice(-5);
  const recentAvg = recent.reduce((sum, s) => sum + s.score, 0) / recent.length;

  const trend = recentAvg > avg ? 'IMPROVING' : recentAvg < avg - 5 ? 'DECLINING' : 'STABLE';

  const lines = [
    `## Quality Trend (${days} days)`,
    `Sessions scored: ${scores.length}`,
    `Average: ${avg.toFixed(1)}`,
    `Recent (last 5): ${recentAvg.toFixed(1)} [${trend}]`,
    '',
    '### Recent Scores',
    '| Session | Score | Date |',
    '|---------|-------|------|',
  ];

  for (const s of scores.slice(-10)) {
    lines.push(`| ${s.session_id.slice(0, 8)}... | ${s.score} | ${s.created_at} |`);
  }

  return text(lines.join('\n'));
}

function handleQualityReport(args: Record<string, unknown>, db: Database.Database, retried = false): ToolResult {
  const days = (args.days as number) ?? 30;

  const scores = db.prepare(`
    SELECT score, security_score, architecture_score, coupling_score, test_score, rule_compliance_score
    FROM session_quality_scores
    WHERE created_at >= datetime('now', ?)
  `).all(`-${days} days`) as Array<Record<string, number>>;

  if (scores.length === 0) {
    if (!retried) {
      const backfilled = backfillQualityScores(db);
      if (backfilled > 0) {
        return handleQualityReport(args, db, true);
      }
    }
    return text(`No quality data available for the last ${days} days. Quality scores are calculated from session observations (bugfixes, VR checks, incidents). Try: ${p('quality_score')} { session_id: "..." } to score individual sessions first, or try a longer time range with { days: 90 }.`);
  }

  const avg = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const max = Math.max(...scores.map(s => s.score));
  const min = Math.min(...scores.map(s => s.score));

  const categoryColumns: Record<string, string> = {
    security: 'security_score',
    architecture: 'architecture_score',
    coupling: 'coupling_score',
    tests: 'test_score',
    rule_compliance: 'rule_compliance_score',
  };

  const categories = getCategories();
  const categoryTotals: Record<string, number> = {};
  for (const category of categories) {
    categoryTotals[category] = 0;
  }

  for (const s of scores) {
    for (const category of categories) {
      const col = categoryColumns[category];
      if (col) {
        categoryTotals[category] += s[col] ?? 0;
      }
    }
  }

  const lines = [
    `## Quality Report (${days} days)`,
    '',
    '### Summary',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Sessions | ${scores.length} |`,
    `| Average Score | ${avg.toFixed(1)} |`,
    `| Best Session | ${max} |`,
    `| Worst Session | ${min} |`,
    '',
    '### Category Impact (Cumulative)',
    '| Category | Total Impact | Avg/Session |',
    '|----------|-------------|-------------|',
  ];

  for (const category of categories) {
    const total = categoryTotals[category];
    const avgCat = total / scores.length;
    lines.push(`| ${category} | ${total > 0 ? '+' : ''}${total} | ${avgCat > 0 ? '+' : ''}${avgCat.toFixed(1)} |`);
  }

  // Recommendations
  const worstCategory = categories.reduce((worst, cat) =>
    categoryTotals[cat] < categoryTotals[worst] ? cat : worst, categories[0]);

  lines.push('');
  lines.push('### Recommendations');
  if (avg < 40) {
    lines.push('- **Critical**: Average quality below 40. Focus on reducing incidents and VR failures.');
  }
  if (categoryTotals[worstCategory] < -10) {
    lines.push(`- **Focus Area**: ${worstCategory} has the most negative impact (${categoryTotals[worstCategory]}). Prioritize improvements here.`);
  }
  if (avg >= 70) {
    lines.push('- Quality is good. Maintain current practices and focus on consistency.');
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

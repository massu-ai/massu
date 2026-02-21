// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import type { TranscriptEntry } from './transcript-parser.ts';
import { getConfig } from './config.ts';

// ============================================================
// Cost Attribution Tracking
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

/** Default model pricing (Claude models). Can be overridden via config.analytics.cost.models */
const DEFAULT_MODEL_PRICING: Record<string, { input_per_million: number; output_per_million: number; cache_read_per_million?: number; cache_write_per_million?: number }> = {
  'claude-opus-4-6': { input_per_million: 5.00, output_per_million: 25.00, cache_read_per_million: 0.50, cache_write_per_million: 6.25 },
  'claude-sonnet-4-6': { input_per_million: 3.00, output_per_million: 15.00, cache_read_per_million: 0.30, cache_write_per_million: 3.75 },
  'claude-sonnet-4-5': { input_per_million: 3.00, output_per_million: 15.00, cache_read_per_million: 0.30, cache_write_per_million: 3.75 },
  'claude-haiku-4-5-20251001': { input_per_million: 0.80, output_per_million: 4.00, cache_read_per_million: 0.08, cache_write_per_million: 1.00 },
  'default': { input_per_million: 3.00, output_per_million: 15.00, cache_read_per_million: 0.30, cache_write_per_million: 3.75 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
}

export interface CostResult {
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  currency: string;
}

/**
 * Get model pricing from config or defaults.
 */
function getModelPricing(): Record<string, { input_per_million: number; output_per_million: number; cache_read_per_million?: number; cache_write_per_million?: number }> {
  return getConfig().analytics?.cost?.models ?? DEFAULT_MODEL_PRICING;
}

/**
 * Get currency from config or default.
 */
function getCurrency(): string {
  return getConfig().analytics?.cost?.currency ?? 'USD';
}

/**
 * Extract token usage from transcript entries.
 */
export function extractTokenUsage(entries: TranscriptEntry[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = 'unknown';

  for (const entry of entries) {
    // Usage and model are present on raw API responses but not typed on TranscriptMessage
    const msg = entry.message as (Record<string, unknown> | undefined);
    if (entry.type === 'assistant' && msg?.usage) {
      const usage = msg.usage as Record<string, number>;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0;
      cacheWriteTokens += usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0;
    }
    if (entry.type === 'assistant' && msg?.model) {
      model = msg.model as string;
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model };
}

/**
 * Calculate cost from token usage.
 */
export function calculateCost(usage: TokenUsage): CostResult {
  const pricing = getModelPricing();
  const modelPricing = pricing[usage.model] ?? pricing['default'] ?? pricing['claude-sonnet-4-5'] ?? { input_per_million: 3.00, output_per_million: 15.00 };

  const inputCost = (usage.inputTokens / 1_000_000) * modelPricing.input_per_million;
  const outputCost = (usage.outputTokens / 1_000_000) * modelPricing.output_per_million;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * (modelPricing.cache_read_per_million ?? 0);
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * (modelPricing.cache_write_per_million ?? 0);

  return {
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    currency: getCurrency(),
  };
}

/**
 * Store session cost data.
 */
export function storeSessionCost(
  db: Database.Database,
  sessionId: string,
  usage: TokenUsage,
  cost: CostResult
): void {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  db.prepare(`
    INSERT INTO session_costs
    (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     total_tokens, estimated_cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, usage.model,
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
    totalTokens, cost.totalCost
  );
}

/**
 * Backfill cost data from transcript files.
 */
export function backfillSessionCosts(db: Database.Database): number {
  // Check for sessions without cost data
  const sessions = db.prepare(`
    SELECT DISTINCT s.session_id
    FROM sessions s
    LEFT JOIN session_costs c ON s.session_id = c.session_id
    WHERE c.session_id IS NULL
    LIMIT 1000
  `).all() as Array<{ session_id: string }>;

  // Backfilling requires transcript data which may not be available
  // Return count of sessions that need backfilling
  return sessions.length;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getCostToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('cost_session'),
      description: 'Show cost breakdown for a session. Includes token counts, model pricing, and cost by category.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID to analyze' },
        },
        required: ['session_id'],
      },
    },
    {
      name: p('cost_trend'),
      description: 'Cost trend over time. Shows daily/weekly spending and identifies cost drivers.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days to look back (default: 30)' },
          group_by: { type: 'string', description: 'Group by: day, week (default: day)' },
        },
        required: [],
      },
    },
    {
      name: p('cost_feature'),
      description: 'Cost attribution by feature. Shows which features consume the most tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days to look back (default: 30)' },
        },
        required: [],
      },
    },
  ];
}

const COST_BASE_NAMES = new Set(['cost_session', 'cost_trend', 'cost_feature']);

export function isCostTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return COST_BASE_NAMES.has(baseName);
}

export function handleCostToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'cost_session':
        return handleCostSession(args, memoryDb);
      case 'cost_trend':
        return handleCostTrend(args, memoryDb);
      case 'cost_feature':
        return handleCostFeature(args, memoryDb);
      default:
        return text(`Unknown cost tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('cost_session')} { session_id: "..." }, ${p('cost_trend')} { days: 30 }`);
  }
}

function handleCostSession(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const sessionId = args.session_id as string;
  if (!sessionId) return text(`Usage: ${p('cost_session')} { session_id: "abc123" } - Show cost breakdown for a specific session.`);

  const cost = db.prepare(
    'SELECT * FROM session_costs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sessionId) as Record<string, unknown> | undefined;

  if (!cost) {
    return text(`No cost data found for session ${sessionId}. Cost data is recorded automatically when sessions end via the session-end hook. If the session is still active, data will appear after it completes. Try: ${p('cost_trend')} { days: 30 } to see aggregate cost data instead.`);
  }

  // Recalculate per-category costs from token counts and model
  const modelPricing = getModelPricing();
  const mp = modelPricing[cost.model as string] ?? modelPricing['claude-sonnet-4-5'] ?? { input_per_million: 3.00, output_per_million: 15.00 };
  const inputCost = ((cost.input_tokens as number) / 1_000_000) * mp.input_per_million;
  const outputCost = ((cost.output_tokens as number) / 1_000_000) * mp.output_per_million;
  const cacheReadCost = ((cost.cache_read_tokens as number) / 1_000_000) * (mp.cache_read_per_million ?? 0);
  const cacheWriteCost = ((cost.cache_write_tokens as number) / 1_000_000) * (mp.cache_write_per_million ?? 0);

  const lines = [
    `## Session Cost: $${(cost.estimated_cost_usd as number).toFixed(4)}`,
    `Model: ${cost.model}`,
    '',
    '### Token Usage',
    `| Type | Tokens | Est. Cost |`,
    `|------|--------|-----------|`,
    `| Input | ${(cost.input_tokens as number).toLocaleString()} | $${inputCost.toFixed(4)} |`,
    `| Output | ${(cost.output_tokens as number).toLocaleString()} | $${outputCost.toFixed(4)} |`,
    `| Cache Read | ${(cost.cache_read_tokens as number).toLocaleString()} | $${cacheReadCost.toFixed(4)} |`,
    `| Cache Write | ${(cost.cache_write_tokens as number).toLocaleString()} | $${cacheWriteCost.toFixed(4)} |`,
    `| **Total** | ${(cost.total_tokens as number).toLocaleString()} | **$${(cost.estimated_cost_usd as number).toFixed(4)}** |`,
  ];

  return text(lines.join('\n'));
}

function handleCostTrend(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const days = (args.days as number) ?? 30;
  const groupBy = (args.group_by as string) ?? 'day';

  if (!['day', 'week'].includes(groupBy)) {
    return text(`Invalid group_by value: "${groupBy}". Use "day" or "week". Example: ${p('cost_trend')} { days: 30, group_by: "week" }`);
  }

  // Use separate prepared statements to avoid SQL string interpolation.
  // dateFormat is validated by the allowlist above, but parameterized SQL
  // is the enterprise-grade approach regardless.
  const sql = groupBy === 'week'
    ? `SELECT strftime('%Y-W%W', created_at) as period,
             COUNT(*) as sessions,
             SUM(estimated_cost_usd) as total_cost,
             SUM(total_tokens) as total_tokens,
             AVG(estimated_cost_usd) as avg_cost
       FROM session_costs
       WHERE created_at >= datetime('now', ?)
       GROUP BY period
       ORDER BY period ASC`
    : `SELECT strftime('%Y-%m-%d', created_at) as period,
             COUNT(*) as sessions,
             SUM(estimated_cost_usd) as total_cost,
             SUM(total_tokens) as total_tokens,
             AVG(estimated_cost_usd) as avg_cost
       FROM session_costs
       WHERE created_at >= datetime('now', ?)
       GROUP BY period
       ORDER BY period ASC`;

  const rows = db.prepare(sql).all(`-${days} days`) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return text(`No cost data found in the last ${days} days. Cost tracking records token usage automatically at session end via hooks. Ensure session-end hooks are configured in your settings. Try: ${p('cost_session')} { session_id: "..." } to check a specific session.`);
  }

  const totalCost = rows.reduce((sum, r) => sum + (r.total_cost as number), 0);
  const totalSessions = rows.reduce((sum, r) => sum + (r.sessions as number), 0);

  const lines = [
    `## Cost Trend (${days} days)`,
    `Total: $${totalCost.toFixed(2)} across ${totalSessions} sessions`,
    `Average per session: $${(totalCost / totalSessions).toFixed(4)}`,
    '',
    `### By ${groupBy === 'week' ? 'Week' : 'Day'}`,
    `| Period | Sessions | Cost | Avg/Session |`,
    `|--------|----------|------|-------------|`,
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.period} | ${row.sessions} | $${(row.total_cost as number).toFixed(2)} | $${(row.avg_cost as number).toFixed(4)} |`
    );
  }

  return text(lines.join('\n'));
}

function handleCostFeature(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const days = (args.days as number) ?? 30;

  const rows = db.prepare(`
    SELECT feature_key, SUM(estimated_cost_usd) as total_cost, SUM(tokens_used) as total_tokens, COUNT(*) as entries
    FROM feature_costs
    WHERE created_at >= datetime('now', ?)
    GROUP BY feature_key
    ORDER BY total_cost DESC
  `).all(`-${days} days`) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return text(`No feature cost data found in the last ${days} days. Feature costs are attributed automatically when sessions work on registered features. Ensure features are registered, then costs are tracked per-session. Try: ${p('cost_trend')} { days: 30 } for session-level cost trends instead.`);
  }

  const totalCost = rows.reduce((sum, r) => sum + (r.total_cost as number), 0);

  const lines = [
    `## Feature Cost Attribution (${days} days)`,
    `Total: $${totalCost.toFixed(2)} across ${rows.length} features`,
    '',
    '| Feature | Cost | Tokens | Sessions | % of Total |',
    '|---------|------|--------|----------|------------|',
  ];

  for (const row of rows) {
    const pct = totalCost > 0 ? ((row.total_cost as number) / totalCost * 100).toFixed(1) : '0';
    lines.push(
      `| ${row.feature_key} | $${(row.total_cost as number).toFixed(2)} | ${(row.total_tokens as number).toLocaleString()} | ${row.entries} | ${pct}% |`
    );
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

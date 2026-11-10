// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import type { TranscriptEntry } from './transcript-parser.ts';
import { getConfig } from './config.ts';
import {
  resolveModelPrice, priceResponse, tokenCounts, PRICING_VERSION, PRICE_TABLE_AS_OF, PRICE_TABLE_SOURCE,
  type ConfigModelPrice, type ResponseUsage,
} from './model-pricing.ts';

// ============================================================
// Cost Attribution Tracking
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

export type CostStatus = 'priced' | 'partial' | 'unknown';

/**
 * Tokens and dollars for a run of transcript entries, priced response by response
 * (model-pricing.ts). One API response is written as SEVERAL transcript lines repeating
 * the same usage, so responses are counted once by message id — measured on one real
 * session: 1535 usage lines, 670 responses.
 */
export interface SessionCostSlice {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Dollars for the responses that have a price. */
  costUsd: number;
  pricedResponses: number;
  unpricedResponses: number;
  /** Models seen with no price; their responses are not in costUsd. */
  unpricedModels: string[];
  /** Model of the last response in the slice ('' when none). */
  model: string;
  /** Id of the last response counted, so the next slice skips its remaining lines. */
  lastMessageId: string | null;
}

function configPriceOverrides(): Record<string, ConfigModelPrice> {
  return (getConfig().analytics?.cost?.models ?? {}) as Record<string, ConfigModelPrice>;
}

/** Currency label for reports; prices are USD. */
function getCurrency(): string {
  return getConfig().analytics?.cost?.currency ?? 'USD';
}

export function costTranscriptEntries(
  entries: TranscriptEntry[],
  opts: { skipMessageId?: string | null } = {},
): SessionCostSlice {
  const overrides = configPriceOverrides();
  const out: SessionCostSlice = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
    pricedResponses: 0, unpricedResponses: 0, unpricedModels: [], model: '', lastMessageId: null,
  };
  const seen = new Set<string>();
  if (opts.skipMessageId) seen.add(opts.skipMessageId);
  const unpriced = new Set<string>();
  for (const entry of entries) {
    const msg = entry.message;
    if (entry.type !== 'assistant' || !msg?.usage) continue;
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      out.lastMessageId = msg.id;
    }
    const usage = msg.usage as ResponseUsage;
    const t = tokenCounts(usage);
    // A response that used no tokens costs nothing whatever its model. Claude Code writes
    // such entries itself (model "<synthetic>": 15 of them in this repo's transcripts,
    // every one with zero tokens), and they are not API calls with an unknown price.
    if (t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h === 0) continue;
    out.inputTokens += t.input;
    out.outputTokens += t.output;
    out.cacheReadTokens += t.cacheRead;
    out.cacheWriteTokens += t.cacheWrite5m + t.cacheWrite1h;
    const dollars = priceResponse(resolveModelPrice(msg.model, overrides), usage);
    if (dollars === null) {
      out.unpricedResponses++;
      unpriced.add(msg.model ?? 'unknown');
    } else {
      out.costUsd += dollars;
      out.pricedResponses++;
    }
    if (msg.model) out.model = msg.model;
  }
  out.unpricedModels = [...unpriced].sort();
  return out;
}

export function costStatusOf(priced: number, unpriced: number): CostStatus {
  if (unpriced === 0) return 'priced';
  return priced === 0 ? 'unknown' : 'partial';
}

/**
 * Store a session's cost — ONE row per session (`session_id` is UNIQUE).
 *
 * This was a plain INSERT, so every Stop after a session's first hit the constraint, the
 * hook's catch swallowed it, and a session's cost froze at its first turn. 'replace'
 * writes full-session totals; 'add' adds a newly-parsed slice to the stored row. Every
 * write stamps the PRICING_VERSION it was priced under, so a price-table change can find
 * and reprice old rows.
 */
export function storeSessionCost(
  db: Database.Database,
  sessionId: string,
  slice: SessionCostSlice,
  mode: 'replace' | 'add' = 'replace',
): void {
  const prev = mode === 'add'
    ? db.prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd,
              priced_responses, unpriced_responses, unpriced_models, model
         FROM session_costs WHERE session_id = ?`,
    ).get(sessionId) as Record<string, number | string> | undefined
    : undefined;
  const num = (k: string) => Number(prev?.[k] ?? 0) || 0;
  const input = num('input_tokens') + slice.inputTokens;
  const output = num('output_tokens') + slice.outputTokens;
  const cacheRead = num('cache_read_tokens') + slice.cacheReadTokens;
  const cacheWrite = num('cache_write_tokens') + slice.cacheWriteTokens;
  const priced = num('priced_responses') + slice.pricedResponses;
  const unpricedCount = num('unpriced_responses') + slice.unpricedResponses;
  const unpricedModels = [...new Set([
    ...String(prev?.unpriced_models ?? '').split(',').filter(Boolean),
    ...slice.unpricedModels,
  ])].sort().join(',');
  const model = slice.model || String(prev?.model ?? '') || null;
  db.prepare(`
    INSERT INTO session_costs
      (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_tokens, estimated_cost_usd, priced_responses, unpriced_responses, unpriced_models,
       cost_status, pricing_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      model = excluded.model, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens, total_tokens = excluded.total_tokens,
      estimated_cost_usd = excluded.estimated_cost_usd,
      priced_responses = excluded.priced_responses, unpriced_responses = excluded.unpriced_responses,
      unpriced_models = excluded.unpriced_models, cost_status = excluded.cost_status,
      pricing_version = excluded.pricing_version
  `).run(
    sessionId, model, input, output, cacheRead, cacheWrite, input + output + cacheRead + cacheWrite,
    num('estimated_cost_usd') + slice.costUsd, priced, unpricedCount, unpricedModels,
    costStatusOf(priced, unpricedCount), PRICING_VERSION,
  );
}

/**
 * Record that a session's cost cannot be known (its transcript is gone). Its row shows
 * "unknown", never a $0 that reads as a real number.
 */
export function markSessionCostUnknown(db: Database.Database, sessionId: string): void {
  db.prepare(`
    INSERT INTO session_costs (session_id, cost_status, pricing_version) VALUES (?, 'unknown', ?)
    ON CONFLICT(session_id) DO UPDATE SET
      input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0,
      total_tokens = 0, estimated_cost_usd = 0, priced_responses = 0, unpriced_responses = 0,
      unpriced_models = '', cost_status = 'unknown', pricing_version = excluded.pricing_version
  `).run(sessionId, PRICING_VERSION);
}

/**
 * Backfill cost data from transcript files.
 */
export function backfillSessionCosts(db: Database.Database): number {
  // Check for sessions without cost data. LIMIT 100000 caps the backfill
  // candidate set (P-DG-001) — a developer machine accumulates thousands
  // of sessions over years; 100000 is multiple orders beyond realistic.
  const sessions = db.prepare(`
    SELECT DISTINCT s.session_id
    FROM sessions s
    LEFT JOIN session_costs c ON s.session_id = c.session_id
    WHERE c.session_id IS NULL
    LIMIT 100000
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

  // Each response was priced at its own model's rates when stored (model-pricing.ts), so
  // there is no per-category re-derivation here: one session-wide rate was the defect.
  const status = (cost.cost_status as CostStatus | undefined) ?? 'unknown';
  const dollars = cost.estimated_cost_usd as number;
  const headline = status === 'unknown'
    ? 'unknown'
    : `$${dollars.toFixed(4)}${status === 'partial' ? ' (partial, see below)' : ''}`;
  const lines = [
    `## Session Cost: ${headline}`,
    `Model: ${cost.model ?? 'unknown'}`,
    '',
    '### Token Usage',
    `| Type | Tokens |`,
    `|------|--------|`,
    `| Input | ${(cost.input_tokens as number).toLocaleString()} |`,
    `| Output | ${(cost.output_tokens as number).toLocaleString()} |`,
    `| Cache Read | ${(cost.cache_read_tokens as number).toLocaleString()} |`,
    `| Cache Write | ${(cost.cache_write_tokens as number).toLocaleString()} |`,
    `| **Total** | ${(cost.total_tokens as number).toLocaleString()} |`,
    '',
    `Responses priced: ${cost.priced_responses ?? 0}; without a price: ${cost.unpriced_responses ?? 0}.`,
  ];
  if (status === 'unknown' && !(cost.unpriced_responses as number)) {
    lines.push('No transcript was available to price this session.');
  }
  if (cost.unpriced_models) {
    lines.push(`No price known for: ${cost.unpriced_models}. Add it under analytics.cost.models in massu.config.yaml.`);
  }
  lines.push(`Prices: ${PRICE_TABLE_SOURCE} as of ${PRICE_TABLE_AS_OF} (${getCurrency()}).`);

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
             SUM(CASE WHEN cost_status = 'unknown' THEN 0 ELSE estimated_cost_usd END) as total_cost,
             SUM(total_tokens) as total_tokens,
             SUM(CASE WHEN cost_status = 'priced' THEN 1 ELSE 0 END) as priced_sessions,
             SUM(CASE WHEN cost_status = 'partial' THEN 1 ELSE 0 END) as partial_sessions,
             SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) as unknown_sessions
       FROM session_costs
       WHERE created_at >= datetime('now', ?)
       GROUP BY period
       ORDER BY period ASC`
    : `SELECT strftime('%Y-%m-%d', created_at) as period,
             COUNT(*) as sessions,
             SUM(CASE WHEN cost_status = 'unknown' THEN 0 ELSE estimated_cost_usd END) as total_cost,
             SUM(total_tokens) as total_tokens,
             SUM(CASE WHEN cost_status = 'priced' THEN 1 ELSE 0 END) as priced_sessions,
             SUM(CASE WHEN cost_status = 'partial' THEN 1 ELSE 0 END) as partial_sessions,
             SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) as unknown_sessions
       FROM session_costs
       WHERE created_at >= datetime('now', ?)
       GROUP BY period
       ORDER BY period ASC`;

  const rows = db.prepare(sql).all(`-${days} days`) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return text(`No cost data found in the last ${days} days. Cost tracking records token usage automatically at session end via hooks. Ensure session-end hooks are configured in your settings. Try: ${p('cost_session')} { session_id: "..." } to check a specific session.`);
  }

  const sum = (k: string) => rows.reduce((acc, r) => acc + ((r[k] as number) ?? 0), 0);
  const totalCost = sum('total_cost');
  const totalSessions = sum('sessions');
  const known = sum('priced_sessions') + sum('partial_sessions');
  const unknown = sum('unknown_sessions');
  const partial = sum('partial_sessions');

  const lines = [
    `## Cost Trend (${days} days)`,
    `Total: $${totalCost.toFixed(2)} across ${known} priced session(s)` +
      (unknown ? `; ${unknown} session(s) of ${totalSessions} have unknown cost and are NOT in this total` : ''),
    known ? `Average per priced session: $${(totalCost / known).toFixed(4)}` : 'No session has a known cost in this window.',
  ];
  if (partial) lines.push(`${partial} session(s) are partial: a model they used has no price, so they are under-counted.`);
  lines.push(
    '',
    `### By ${groupBy === 'week' ? 'Week' : 'Day'}`,
    `| Period | Sessions | Cost | Unknown |`,
    `|--------|----------|------|---------|`,
  );
  for (const row of rows) {
    lines.push(`| ${row.period} | ${row.sessions} | $${(row.total_cost as number).toFixed(2)} | ${row.unknown_sessions} |`);
  }
  lines.push('', `Prices: ${PRICE_TABLE_SOURCE} as of ${PRICE_TABLE_AS_OF} (${getCurrency()}).`);

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

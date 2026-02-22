// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';
import { p, text } from './tool-helpers.ts';
import {
  getConversationTurns,
  searchConversationTurns,
  getToolPatterns,
  getSessionStats,
  getObservabilityDbSize,
  pruneOldConversationTurns,
} from './memory-db.ts';
import { getConfig } from './config.ts';

// ============================================================
// Observability MCP Tools (P3-001 through P3-004)
// ============================================================

const OBSERVABILITY_BASE_NAMES = new Set([
  'session_replay',
  'prompt_analysis',
  'tool_patterns',
  'session_stats',
]);

export function isObservabilityTool(name: string): boolean {
  const prefix = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return OBSERVABILITY_BASE_NAMES.has(baseName);
}

export function getObservabilityToolDefinitions(): ToolDefinition[] {
  return [
    // P3-001: session_replay
    {
      name: p('session_replay'),
      description: 'Replay a past session as a chronological conversation with user prompts, assistant responses, and optional tool call details. Requires conversation data captured by the session-end hook.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID to replay' },
          turn_from: { type: 'number', description: 'Start from turn N (optional)' },
          turn_to: { type: 'number', description: 'End at turn N (optional)' },
          include_tool_calls: { type: 'boolean', description: 'Include tool call details in replay (default: false)' },
        },
        required: ['session_id'],
      },
    },
    // P3-002: prompt_analysis
    {
      name: p('prompt_analysis'),
      description: 'Search and analyze prompts across sessions using FTS5 full-text search on conversation_turns_fts. Find prompts by keyword, filter by date range or complexity (tool call count).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'FTS5 search query within prompts and responses' },
          session_id: { type: 'string', description: 'Filter to specific session' },
          date_from: { type: 'string', description: 'Start date (ISO format)' },
          date_to: { type: 'string', description: 'End date (ISO format)' },
          min_tool_calls: { type: 'number', description: 'Filter by turns with N+ tool calls' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: [],
      },
    },
    // P3-003: tool_patterns
    {
      name: p('tool_patterns'),
      description: 'Analyze tool usage patterns across sessions. Shows counts, success rates, average I/O sizes per tool. Can group by tool name, session, or day.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Filter to specific session' },
          tool_name: { type: 'string', description: 'Filter to specific tool (Read, Write, Edit, Bash, etc.)' },
          date_from: { type: 'string', description: 'Start date (ISO format)' },
          group_by: { type: 'string', description: '"tool" | "session" | "day" (default: "tool")' },
        },
        required: [],
      },
    },
    // P3-004: session_stats
    {
      name: p('session_stats'),
      description: 'Get per-session statistics: turn count, tool call breakdown, token usage, duration. Includes database size monitoring for observability data.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Specific session ID (default: all recent)' },
          limit: { type: 'number', description: 'Max sessions to show (default: 10)' },
        },
        required: [],
      },
    },
  ];
}

export function handleObservabilityToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const prefix = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

    switch (baseName) {
      case 'session_replay':
        return handleSessionReplay(args, memoryDb);
      case 'prompt_analysis':
        return handlePromptAnalysis(args, memoryDb);
      case 'tool_patterns':
        return handleToolPatterns(args, memoryDb);
      case 'session_stats':
        return handleSessionStats(args, memoryDb);
      default:
        return text(`Unknown observability tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================
// Tool Handlers
// ============================================================

function handleSessionReplay(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const sessionId = args.session_id as string;
  if (!sessionId) return text('Error: session_id is required');

  const includeToolCalls = (args.include_tool_calls as boolean) ?? false;
  const turns = getConversationTurns(db, sessionId, {
    turnFrom: args.turn_from as number | undefined,
    turnTo: args.turn_to as number | undefined,
    includeToolCalls,
  });

  if (turns.length === 0) {
    return text(`No conversation turns found for session ${sessionId.slice(0, 8)}...\nNote: Conversation data is captured by the session-end hook. Only sessions that have ended will have replay data.`);
  }

  const lines = [`## Session Replay: ${sessionId.slice(0, 12)}...`, `Turns: ${turns.length}`, ''];

  for (const turn of turns) {
    lines.push(`### Turn ${turn.turn_number}`);
    lines.push(`**User**: ${turn.user_prompt.slice(0, 2000)}`);
    lines.push('');

    if (turn.assistant_response) {
      lines.push(`**Assistant**: ${turn.assistant_response.slice(0, 2000)}`);
      lines.push('');
    }

    if (includeToolCalls && turn.tool_calls_json) {
      try {
        const toolCalls = JSON.parse(turn.tool_calls_json) as Array<{ name: string; input_summary: string; is_error: boolean }>;
        if (toolCalls.length > 0) {
          lines.push(`**Tool Calls** (${toolCalls.length}):`);
          for (const tc of toolCalls) {
            const status = tc.is_error ? ' [ERROR]' : '';
            lines.push(`  - ${tc.name}: ${tc.input_summary}${status}`);
          }
          lines.push('');
        }
      } catch (_e) {
        // Skip invalid JSON
      }
    }

    if (turn.tool_call_count > 0) {
      lines.push(`_${turn.tool_call_count} tool calls | ~${turn.prompt_tokens ?? 0} prompt tokens | ~${turn.response_tokens ?? 0} response tokens_`);
    }
    lines.push('---');
    lines.push('');
  }

  return text(lines.join('\n'));
}

function handlePromptAnalysis(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const query = args.query as string | undefined;

  if (!query) {
    // No FTS query -- show recent turns summary
    const recentTurns = db.prepare(
      'SELECT ct.session_id, ct.turn_number, ct.user_prompt, ct.tool_call_count, ct.response_tokens, ct.created_at FROM conversation_turns ct ORDER BY ct.created_at_epoch DESC LIMIT ?'
    ).all((args.limit as number) ?? 20) as Array<{
      session_id: string; turn_number: number; user_prompt: string;
      tool_call_count: number; response_tokens: number | null; created_at: string;
    }>;

    if (recentTurns.length === 0) {
      return text('No conversation turns recorded yet.');
    }

    const lines = ['## Recent Prompts', ''];
    lines.push('| Session | Turn | Prompt (truncated) | Tools | Response Tokens | Date |');
    lines.push('|---------|------|--------------------|-------|-----------------|------|');

    for (const t of recentTurns) {
      lines.push(`| ${t.session_id.slice(0, 8)}... | ${t.turn_number} | ${t.user_prompt.slice(0, 60).replace(/\|/g, '\\|')} | ${t.tool_call_count} | ${t.response_tokens ?? '-'} | ${t.created_at.split('T')[0]} |`);
    }

    return text(lines.join('\n'));
  }

  const results = searchConversationTurns(db, query, {
    sessionId: args.session_id as string | undefined,
    dateFrom: args.date_from as string | undefined,
    dateTo: args.date_to as string | undefined,
    minToolCalls: args.min_tool_calls as number | undefined,
    limit: args.limit as number | undefined,
  });

  if (results.length === 0) {
    return text(`No prompts found matching "${query}".`);
  }

  const lines = [`## Prompt Search: "${query}" (${results.length} results)`, ''];
  lines.push('| Session | Turn | Prompt (truncated) | Tools | Response Tokens | Date |');
  lines.push('|---------|------|--------------------|-------|-----------------|------|');

  for (const r of results) {
    lines.push(`| ${r.session_id.slice(0, 8)}... | ${r.turn_number} | ${r.user_prompt.slice(0, 60).replace(/\|/g, '\\|')} | ${r.tool_call_count} | ${r.response_tokens ?? '-'} | ${r.created_at.split('T')[0]} |`);
  }

  return text(lines.join('\n'));
}

function handleToolPatterns(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const groupBy = (args.group_by as 'tool' | 'session' | 'day') ?? 'tool';
  const patterns = getToolPatterns(db, {
    sessionId: args.session_id as string | undefined,
    toolName: args.tool_name as string | undefined,
    dateFrom: args.date_from as string | undefined,
    groupBy,
  });

  if (patterns.length === 0) {
    return text('No tool usage data recorded yet.');
  }

  const lines = [`## Tool Usage Patterns (grouped by ${groupBy})`, ''];

  switch (groupBy) {
    case 'tool':
      lines.push('| Tool | Calls | Successes | Failures | Success Rate | Avg Output Size | Avg Input Size |');
      lines.push('|------|-------|-----------|----------|--------------|-----------------|----------------|');
      for (const p of patterns) {
        const total = p.call_count as number;
        const successes = p.successes as number;
        const failures = p.failures as number;
        const rate = total > 0 ? Math.round((successes / total) * 100) : 0;
        lines.push(`| ${p.tool_name} | ${total} | ${successes} | ${failures} | ${rate}% | ${Math.round(p.avg_output_size as number ?? 0)} | ${Math.round(p.avg_input_size as number ?? 0)} |`);
      }
      break;
    case 'session':
      lines.push('| Session | Calls | Unique Tools | Successes | Failures | Avg Output Size |');
      lines.push('|---------|-------|--------------|-----------|----------|-----------------|');
      for (const p of patterns) {
        lines.push(`| ${(p.session_id as string).slice(0, 8)}... | ${p.call_count} | ${p.unique_tools} | ${p.successes} | ${p.failures} | ${Math.round(p.avg_output_size as number ?? 0)} |`);
      }
      break;
    case 'day':
      lines.push('| Day | Calls | Unique Tools | Successes |');
      lines.push('|-----|-------|--------------|-----------|');
      for (const p of patterns) {
        lines.push(`| ${p.day} | ${p.call_count} | ${p.unique_tools} | ${p.successes} |`);
      }
      break;
  }

  return text(lines.join('\n'));
}

function handleSessionStats(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const stats = getSessionStats(db, {
    sessionId: args.session_id as string | undefined,
    limit: args.limit as number | undefined,
  });

  if (stats.length === 0) {
    return text('No session stats available.');
  }

  const lines = ['## Session Statistics', ''];

  if (args.session_id) {
    // Detailed single session view
    const s = stats[0];
    lines.push(`### Session: ${(s.session_id as string).slice(0, 12)}...`);
    lines.push(`- **Status**: ${s.status}`);
    lines.push(`- **Started**: ${s.started_at ?? '-'}`);
    lines.push(`- **Ended**: ${s.ended_at ?? '-'}`);
    lines.push(`- **Turns**: ${s.turn_count}`);
    lines.push(`- **Total Tool Calls**: ${s.total_tool_calls}`);
    lines.push(`- **Prompt Tokens**: ~${s.total_prompt_tokens}`);
    lines.push(`- **Response Tokens**: ~${s.total_response_tokens}`);
    lines.push('');

    const breakdown = s.tool_breakdown as Array<Record<string, unknown>> | undefined;
    if (breakdown && breakdown.length > 0) {
      lines.push('#### Tool Breakdown');
      lines.push('| Tool | Calls |');
      lines.push('|------|-------|');
      for (const tb of breakdown) {
        lines.push(`| ${tb.tool_name} | ${tb.count} |`);
      }
    }
  } else {
    // Multi-session summary
    lines.push('| Session | Status | Turns | Tool Calls | Prompt Tokens | Response Tokens | Started |');
    lines.push('|---------|--------|-------|------------|---------------|-----------------|---------|');
    for (const s of stats) {
      lines.push(`| ${(s.session_id as string).slice(0, 8)}... | ${s.status} | ${s.turn_count} | ${s.total_tool_calls} | ~${s.total_prompt_tokens} | ~${s.total_response_tokens} | ${(s.started_at as string)?.split('T')[0] ?? '-'} |`);
    }
  }

  // Database size info (P4-001)
  lines.push('');
  lines.push('### Database Size');
  const dbSize = getObservabilityDbSize(db);
  lines.push(`- Conversation turns: ${dbSize.conversation_turns_count}`);
  lines.push(`- Tool call details: ${dbSize.tool_call_details_count}`);
  lines.push(`- Observations: ${dbSize.observations_count}`);
  lines.push(`- Database size: ~${dbSize.estimated_size_mb} MB`);

  return text(lines.join('\n'));
}


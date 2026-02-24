// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import {
  searchObservations,
  getRecentObservations,
  getSessionSummaries,
  getSessionTimeline,
  getFailedAttempts,
  addObservation,
  assignImportance,
  createSession,
} from './memory-db.ts';
import { getConfig } from './config.ts';

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

// ============================================================
// P4-001 through P4-006: MCP Memory Tools
// ============================================================

/**
 * Get all memory tool definitions.
 */
export function getMemoryToolDefinitions(): ToolDefinition[] {
  return [
    // P4-001: memory_search
    {
      name: p('memory_search'),
      description: 'Search past session observations and decisions using full-text search. Returns compact index of matching observations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text (FTS5 query syntax supported)' },
          type: { type: 'string', description: 'Filter by observation type (decision, bugfix, feature, failed_attempt, cr_violation, vr_check, etc.)' },
          cr_rule: { type: 'string', description: 'Filter by CR rule (e.g., CR-9)' },
          date_from: { type: 'string', description: 'Start date (ISO format)' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
    // P4-002: memory_timeline
    {
      name: p('memory_timeline'),
      description: 'Retrieve episodic memory - chronological context around a specific event. Shows observations before and after the anchor point to reconstruct what happened and why.',
      inputSchema: {
        type: 'object',
        properties: {
          observation_id: { type: 'number', description: 'Anchor observation ID' },
          depth_before: { type: 'number', description: 'Items before (default: 5)' },
          depth_after: { type: 'number', description: 'Items after (default: 5)' },
        },
        required: ['observation_id'],
      },
    },
    // P4-003: memory_detail
    {
      name: p('memory_detail'),
      description: 'Get full observation details by IDs (batch). Includes evidence, files, plan items.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'Observation IDs to retrieve',
          },
        },
        required: ['ids'],
      },
    },
    // P4-004: memory_sessions
    {
      name: p('memory_sessions'),
      description: 'List recent sessions with summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max sessions (default: 10)' },
          status: { type: 'string', description: 'Filter by status (active, completed, abandoned)' },
        },
        required: [],
      },
    },
    // P4-005: memory_failures
    {
      name: p('memory_failures'),
      description: 'Get all failed attempts (DON\'T RETRY warnings). Check before attempting a fix to see if it was already tried.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filter by keyword' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: [],
      },
    },
    // P4-006: memory_ingest
    {
      name: p('memory_ingest'),
      description: 'Manually record an observation that hooks cannot auto-detect. Use for significant decisions, discoveries, or failed attempts mid-session.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Observation type: decision, bugfix, feature, refactor, discovery, cr_violation, vr_check, pattern_compliance, failed_attempt, file_change, incident_near_miss',
          },
          title: { type: 'string', description: 'Short description' },
          detail: { type: 'string', description: 'Full context' },
          importance: { type: 'number', description: 'Override importance (1-5, default: auto-assigned)' },
          cr_rule: { type: 'string', description: 'Link to CR rule (e.g., CR-9)' },
          plan_item: { type: 'string', description: 'Link to plan item (e.g., P2-003)' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files involved',
          },
        },
        required: ['type', 'title'],
      },
    },
  ];
}

/**
 * Handle a memory tool call.
 */
export function handleMemoryToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const prefix = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

    switch (baseName) {
      case 'memory_search':
        return handleSearch(args, memoryDb);
      case 'memory_timeline':
        return handleTimeline(args, memoryDb);
      case 'memory_detail':
        return handleDetail(args, memoryDb);
      case 'memory_sessions':
        return handleSessions(args, memoryDb);
      case 'memory_failures':
        return handleFailures(args, memoryDb);
      case 'memory_ingest':
        return handleIngest(args, memoryDb);
      default:
        return text(`Unknown memory tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================
// Tool Handlers
// ============================================================

function handleSearch(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const query = args.query as string;
  if (!query) return text('Error: query is required');

  const results = searchObservations(db, query, {
    type: args.type as string | undefined,
    crRule: args.cr_rule as string | undefined,
    dateFrom: args.date_from as string | undefined,
    limit: args.limit as number | undefined,
  });

  if (results.length === 0) {
    return text(`No observations found for "${query}".`);
  }

  const lines = [`## Search Results for "${query}" (${results.length} matches)`, ''];
  lines.push('| ID | Type | Title | Date | Importance |');
  lines.push('|----|------|-------|------|------------|');

  for (const r of results) {
    lines.push(`| ${r.id} | ${r.type} | ${r.title.slice(0, 80)} | ${r.created_at.split('T')[0]} | ${r.importance} |`);
  }

  lines.push('');
  lines.push(`Use ${p('memory_detail')} with IDs for full details.`);
  lines.push(`Use ${p('memory_timeline')} with an ID for chronological context.`);

  return text(lines.join('\n'));
}

function handleTimeline(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const observationId = args.observation_id as number;
  if (!observationId) return text('Error: observation_id is required');

  const depthBefore = (args.depth_before as number) ?? 5;
  const depthAfter = (args.depth_after as number) ?? 5;

  // Get the anchor observation
  const anchor = db.prepare('SELECT * FROM observations WHERE id = ?').get(observationId) as Record<string, unknown> | undefined;
  if (!anchor) return text(`Observation ${observationId} not found.`);

  // Get observations before
  const before = db.prepare(
    'SELECT id, type, title, created_at, importance FROM observations WHERE session_id = ? AND created_at_epoch < ? ORDER BY created_at_epoch DESC LIMIT ?'
  ).all(anchor.session_id, anchor.created_at_epoch, depthBefore) as Array<Record<string, unknown>>;

  // Get observations after
  const after = db.prepare(
    'SELECT id, type, title, created_at, importance FROM observations WHERE session_id = ? AND created_at_epoch > ? ORDER BY created_at_epoch ASC LIMIT ?'
  ).all(anchor.session_id, anchor.created_at_epoch, depthAfter) as Array<Record<string, unknown>>;

  const lines = [`## Timeline around observation #${observationId}`, ''];

  // Before (reversed to chronological order)
  for (const o of before.reverse()) {
    lines.push(`  ${o.id} | ${o.type} | ${(o.title as string).slice(0, 60)} | ${(o.created_at as string).split('T')[0]}`);
  }

  // Anchor
  lines.push(`> ${anchor.id} | ${anchor.type} | ${(anchor.title as string).slice(0, 60)} | ${(anchor.created_at as string).split('T')[0]} <-- ANCHOR`);

  // After
  for (const o of after) {
    lines.push(`  ${o.id} | ${o.type} | ${(o.title as string).slice(0, 60)} | ${(o.created_at as string).split('T')[0]}`);
  }

  return text(lines.join('\n'));
}

function handleDetail(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const ids = args.ids as number[];
  if (!ids || ids.length === 0) return text('Error: ids array is required');

  const placeholders = ids.map(() => '?').join(',');
  const observations = db.prepare(
    `SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`
  ).all(...ids) as Array<Record<string, unknown>>;

  if (observations.length === 0) {
    return text('No observations found for the given IDs.');
  }

  const lines: string[] = [];
  for (const o of observations) {
    lines.push(`## Observation #${o.id} [${o.type}] (importance: ${o.importance})`);
    lines.push(`**Title**: ${o.title}`);
    lines.push(`**Session**: ${o.session_id}`);
    lines.push(`**Date**: ${o.created_at}`);

    if (o.detail) lines.push(`**Detail**: ${o.detail}`);
    if (o.files_involved && o.files_involved !== '[]') {
      const files = safeParseJson(o.files_involved as string, []) as string[];
      if (files.length > 0) lines.push(`**Files**: ${files.join(', ')}`);
    }
    if (o.plan_item) lines.push(`**Plan Item**: ${o.plan_item}`);
    if (o.cr_rule) lines.push(`**CR Rule**: ${o.cr_rule}`);
    if (o.vr_type) lines.push(`**VR Type**: ${o.vr_type}`);
    if (o.evidence) lines.push(`**Evidence**: ${(o.evidence as string).slice(0, 500)}`);
    if ((o.recurrence_count as number) > 1) lines.push(`**Recurrence**: ${o.recurrence_count}x`);
    lines.push('');
  }

  return text(lines.join('\n'));
}

function handleSessions(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const limit = (args.limit as number) ?? 10;
  const status = args.status as string | undefined;

  let sql = 'SELECT * FROM sessions';
  const params: (string | number)[] = [];

  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }

  sql += ' ORDER BY started_at_epoch DESC LIMIT ?';
  params.push(limit);

  const sessions = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  if (sessions.length === 0) {
    return text('No sessions found.');
  }

  const lines = ['## Recent Sessions', ''];
  lines.push('| Session ID | Status | Branch | Started | Plan |');
  lines.push('|------------|--------|--------|---------|------|');

  for (const s of sessions) {
    const started = (s.started_at as string).split('T')[0];
    const plan = s.plan_file ? (s.plan_file as string).split('/').pop() : '-';
    lines.push(`| ${(s.session_id as string).slice(0, 8)}... | ${s.status} | ${s.git_branch ?? '-'} | ${started} | ${plan} |`);
  }

  // Add summaries for each session
  for (const s of sessions) {
    const summaries = getSessionSummaries(db, 1);
    const summary = summaries.find(sm => sm.session_id === s.session_id);
    if (summary) {
      lines.push('');
      lines.push(`### ${(s.session_id as string).slice(0, 8)}...`);
      if (summary.request) lines.push(`**Task**: ${summary.request.slice(0, 200)}`);
      if (summary.completed) lines.push(`**Completed**: ${summary.completed.slice(0, 200)}`);
    }
  }

  return text(lines.join('\n'));
}

function handleFailures(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const query = args.query as string | undefined;
  const limit = (args.limit as number) ?? 20;

  const failures = getFailedAttempts(db, query, limit);

  if (failures.length === 0) {
    return text(query ? `No failed attempts found for "${query}".` : 'No failed attempts recorded.');
  }

  const lines = ['## Failed Attempts (DO NOT RETRY)', ''];

  for (const f of failures) {
    const recurrence = f.recurrence_count > 1 ? ` (occurred ${f.recurrence_count}x across sessions)` : '';
    lines.push(`### #${f.id}: ${f.title}${recurrence}`);
    if (f.detail) lines.push(f.detail.slice(0, 500));
    lines.push(`Session: ${f.session_id.slice(0, 8)}... | Date: ${f.created_at.split('T')[0]}`);
    lines.push('');
  }

  return text(lines.join('\n'));
}

function handleIngest(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const type = args.type as string;
  const title = args.title as string;

  if (!type || !title) return text('Error: type and title are required');

  const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery',
    'cr_violation', 'vr_check', 'pattern_compliance', 'failed_attempt',
    'file_change', 'incident_near_miss'];

  if (!validTypes.includes(type)) {
    return text(`Error: invalid type "${type}". Valid types: ${validTypes.join(', ')}`);
  }

  // We need a session_id - get the most recent active session
  const activeSession = db.prepare(
    "SELECT session_id FROM sessions WHERE status = 'active' ORDER BY started_at_epoch DESC LIMIT 1"
  ).get() as { session_id: string } | undefined;

  if (!activeSession) {
    return text('Error: no active session found. Start a session first.');
  }

  const importance = (args.importance as number) ?? assignImportance(type);
  const id = addObservation(db, activeSession.session_id, type, title, (args.detail as string) ?? null, {
    importance,
    crRule: args.cr_rule as string | undefined,
    planItem: args.plan_item as string | undefined,
    filesInvolved: args.files as string[] | undefined,
  });

  return text(`Observation #${id} recorded successfully.\nType: ${type}\nTitle: ${title}\nImportance: ${importance}\nSession: ${activeSession.session_id.slice(0, 8)}...`);
}

// ============================================================
// Helpers
// ============================================================

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

function safeParseJson(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}

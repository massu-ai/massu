// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';
import { p, text } from './tool-helpers.ts';
import { getConfig } from './config.ts';

// ============================================================
// ADR (Architecture Decision Record) Auto-Generation
// ============================================================

/** Default decision detection phrases. Configurable via governance.adr.detection_phrases */
const DEFAULT_DETECTION_PHRASES = ['chose', 'decided', 'switching to', 'moving from', 'going with'];

/**
 * Get decision detection phrases from config or defaults.
 */
function getDetectionPhrases(): string[] {
  return getConfig().governance?.adr?.detection_phrases ?? DEFAULT_DETECTION_PHRASES;
}

/**
 * Detect decision patterns in text.
 */
export function detectDecisionPatterns(text: string): boolean {
  const phrases = getDetectionPhrases();
  const lower = text.toLowerCase();
  return phrases.some(phrase => lower.includes(phrase));
}

/**
 * Extract alternatives from a decision description.
 */
export function extractAlternatives(description: string): string[] {
  const alternatives: string[] = [];

  // Pattern: "X over Y"
  const overMatch = description.match(/(\w[\w\s-]+)\s+over\s+(\w[\w\s-]+)/i);
  if (overMatch) {
    alternatives.push(overMatch[1].trim());
    alternatives.push(overMatch[2].trim());
  }

  // Pattern: "X instead of Y"
  const insteadMatch = description.match(/(\w[\w\s-]+)\s+instead\s+of\s+(\w[\w\s-]+)/i);
  if (insteadMatch) {
    alternatives.push(insteadMatch[1].trim());
    alternatives.push(insteadMatch[2].trim());
  }

  // Pattern: "switching from X to Y"
  const switchMatch = description.match(/switching\s+from\s+(\w[\w\s-]+)\s+to\s+(\w[\w\s-]+)/i);
  if (switchMatch) {
    alternatives.push(switchMatch[2].trim()); // Chosen
    alternatives.push(switchMatch[1].trim()); // Rejected
  }

  return [...new Set(alternatives)];
}

/**
 * Store an architecture decision.
 */
export function storeDecision(
  db: Database.Database,
  decision: {
    title: string;
    context: string;
    decision: string;
    alternatives: string[];
    consequences: string;
    sessionId?: string;
    status?: string;
  }
): number {
  const result = db.prepare(`
    INSERT INTO architecture_decisions
    (title, context, decision, alternatives, consequences, session_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.title,
    decision.context,
    decision.decision,
    JSON.stringify(decision.alternatives),
    decision.consequences,
    decision.sessionId ?? null,
    decision.status ?? 'accepted'
  );

  return Number(result.lastInsertRowid);
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getAdrToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('adr_list'),
      description: 'List all recorded architecture decisions. Filter by status or search text.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status: accepted, superseded, deprecated' },
          search: { type: 'string', description: 'Search in title and context' },
        },
        required: [],
      },
    },
    {
      name: p('adr_detail'),
      description: 'Get full details of a specific architecture decision by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ADR ID' },
        },
        required: ['id'],
      },
    },
    {
      name: p('adr_create'),
      description: 'Generate an ADR from a description. Extracts alternatives, context, and consequences.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Decision title' },
          context: { type: 'string', description: 'Why was this decision needed?' },
          decision: { type: 'string', description: 'What was decided?' },
          consequences: { type: 'string', description: 'What are the consequences?' },
        },
        required: ['title', 'decision'],
      },
    },
  ];
}

const ADR_BASE_NAMES = new Set(['adr_list', 'adr_detail', 'adr_create']);

export function isAdrTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return ADR_BASE_NAMES.has(baseName);
}

export function handleAdrToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'adr_list':
        return handleAdrList(args, memoryDb);
      case 'adr_detail':
        return handleAdrDetail(args, memoryDb);
      case 'adr_create':
        return handleAdrGenerate(args, memoryDb);
      default:
        return text(`Unknown ADR tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('adr_list')} {}, ${p('adr_create')} { title: "...", decision: "..." }`);
  }
}

function handleAdrList(args: Record<string, unknown>, db: Database.Database): ToolResult {
  let sql = 'SELECT id, title, status, created_at FROM architecture_decisions WHERE 1=1';
  const params: string[] = [];

  if (args.status) {
    sql += ' AND status = ?';
    params.push(args.status as string);
  }

  if (args.search) {
    sql += ' AND (title LIKE ? OR context LIKE ?)';
    const searchTerm = `%${args.search}%`;
    params.push(searchTerm, searchTerm);
  }

  sql += ' ORDER BY created_at DESC';

  const decisions = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  if (decisions.length === 0) {
    return text(`No architecture decisions found. Decisions are recorded when you use ${p('adr_create')} during design discussions. Try: ${p('adr_create')} { title: "Use Redis for caching", decision: "We chose Redis over Memcached" }`);
  }

  const lines = [
    `## Architecture Decisions (${decisions.length})`,
    '',
    '| ID | Title | Status | Date |',
    '|----|-------|--------|------|',
  ];

  for (const d of decisions) {
    lines.push(`| ${d.id} | ${d.title} | ${d.status} | ${(d.created_at as string).slice(0, 10)} |`);
  }

  return text(lines.join('\n'));
}

function handleAdrDetail(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const id = args.id as number;
  if (!id) return text(`Usage: ${p('adr_detail')} { id: 1 } - Get full details of an architecture decision.`);

  const decision = db.prepare(
    'SELECT * FROM architecture_decisions WHERE id = ?'
  ).get(id) as Record<string, unknown> | undefined;

  if (!decision) {
    return text(`ADR #${id} not found. Decisions are stored when created via ${p('adr_create')}. Try: ${p('adr_list')} {} to see all recorded decisions.`);
  }

  const alternatives = JSON.parse((decision.alternatives as string) || '[]') as string[];

  const lines = [
    `# ADR-${decision.id}: ${decision.title}`,
    `Status: ${decision.status}`,
    `Date: ${(decision.created_at as string).slice(0, 10)}`,
    '',
    '## Context',
    decision.context as string || 'Not specified',
    '',
    '## Decision',
    decision.decision as string,
    '',
  ];

  if (alternatives.length > 0) {
    lines.push('## Alternatives Considered');
    for (const alt of alternatives) {
      lines.push(`- ${alt}`);
    }
    lines.push('');
  }

  if (decision.consequences) {
    lines.push('## Consequences');
    lines.push(decision.consequences as string);
  }

  return text(lines.join('\n'));
}

function handleAdrGenerate(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const title = args.title as string;
  const decisionText = args.decision as string;
  if (!title || !decisionText) return text(`Usage: ${p('adr_create')} { title: "Use Redis for caching", decision: "We chose Redis over Memcached for caching", context: "...", consequences: "..." }`);

  const context = (args.context as string) ?? '';
  const consequences = (args.consequences as string) ?? '';

  // Extract alternatives from the decision text
  const alternatives = extractAlternatives(decisionText);

  const id = storeDecision(db, {
    title,
    context,
    decision: decisionText,
    alternatives,
    consequences,
  });

  const lines = [
    `## ADR-${id} Created: ${title}`,
    '',
    `**Status**: accepted`,
    `**Decision**: ${decisionText}`,
    alternatives.length > 0 ? `**Alternatives**: ${alternatives.join(', ')}` : '',
    context ? `**Context**: ${context}` : '',
    consequences ? `**Consequences**: ${consequences}` : '',
    '',
    `View full details: ${p('adr_detail')} { id: ${id} }`,
  ];

  return text(lines.filter(Boolean).join('\n'));
}


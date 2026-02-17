// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';

// ============================================================
// Compliance Audit Trail
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

export interface AuditEntry {
  eventType: 'code_change' | 'rule_enforced' | 'approval' | 'review' | 'commit' | 'compaction';
  actor: 'ai' | 'human' | 'hook' | 'agent';
  filePath?: string;
  changeType?: 'create' | 'edit' | 'delete';
  evidence?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  modelId?: string;
  approvalStatus?: 'auto_approved' | 'human_approved' | 'pending' | 'denied';
  rulesInEffect?: string;
}

/** Default audit formats */
const DEFAULT_FORMATS = ['summary', 'detailed', 'soc2'];

/** Default retention days */
const DEFAULT_RETENTION_DAYS = 365;

/**
 * Get configured audit formats.
 */
function getAuditFormats(): string[] {
  return getConfig().governance?.audit?.formats ?? DEFAULT_FORMATS;
}

/**
 * Log an audit entry.
 */
export function logAuditEntry(
  db: Database.Database,
  entry: AuditEntry
): void {
  db.prepare(`
    INSERT INTO audit_log (session_id, event_type, actor, model_id, file_path, change_type, rules_in_effect, approval_status, evidence, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionId ?? null,
    entry.eventType,
    entry.actor,
    entry.modelId ?? null,
    entry.filePath ?? null,
    entry.changeType ?? null,
    entry.rulesInEffect ?? null,
    entry.approvalStatus ?? null,
    entry.evidence ?? null,
    entry.metadata ? JSON.stringify(entry.metadata) : null
  );
}

/**
 * Query audit log with filters.
 */
export function queryAuditLog(
  db: Database.Database,
  options: {
    eventType?: string;
    actor?: string;
    days?: number;
    limit?: number;
    filePath?: string;
    changeType?: string;
  }
): Array<Record<string, unknown>> {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params: (string | number)[] = [];

  if (options.eventType) {
    sql += ' AND event_type = ?';
    params.push(options.eventType);
  }
  if (options.actor) {
    sql += ' AND actor = ?';
    params.push(options.actor);
  }
  if (options.days) {
    sql += ' AND timestamp >= datetime(\'now\', ?)';
    params.push(`-${options.days} days`);
  }
  if (options.filePath) {
    sql += ' AND file_path = ?';
    params.push(options.filePath);
  }
  if (options.changeType) {
    sql += ' AND change_type = ?';
    params.push(options.changeType);
  }

  sql += ' ORDER BY timestamp DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/**
 * Get audit chain for a file - chronological audit history.
 */
export function getFileChain(
  db: Database.Database,
  filePath: string
): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT * FROM audit_log WHERE file_path = ? ORDER BY timestamp ASC'
  ).all(filePath) as Array<Record<string, unknown>>;
}

/**
 * Backfill audit log from session observations.
 */
export function backfillAuditLog(db: Database.Database): number {
  const observations = db.prepare(`
    SELECT o.id, o.type, o.description, o.files, o.session_id, o.created_at
    FROM observations o
    LEFT JOIN audit_log a ON a.evidence = o.description AND a.session_id = o.session_id
    WHERE a.id IS NULL
    AND o.type IN ('bugfix', 'cr_violation', 'vr_check', 'incident', 'decision')
    ORDER BY o.created_at ASC
    LIMIT 1000
  `).all() as Array<Record<string, unknown>>;

  let backfilled = 0;
  for (const obs of observations) {
    const files = obs.files ? JSON.parse(obs.files as string) : [];
    const eventType = (obs.type === 'cr_violation') ? 'rule_enforced' as const
      : (obs.type === 'vr_check') ? 'review' as const
      : 'code_change' as const;

    logAuditEntry(db, {
      eventType,
      actor: 'ai',
      filePath: files[0] ?? undefined,
      changeType: 'edit',
      evidence: obs.description as string,
      sessionId: obs.session_id as string,
      metadata: { original_type: obs.type, backfilled: true },
    });
    backfilled++;
  }

  return backfilled;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getAuditToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('audit_log'),
      description: 'Query the audit log. Filter by event type, actor, file, or time range.',
      inputSchema: {
        type: 'object',
        properties: {
          event_type: { type: 'string', description: 'Filter by event type: code_change, rule_enforced, approval, review, commit, compaction' },
          actor: { type: 'string', description: 'Filter by actor: ai, human, hook, agent' },
          file_path: { type: 'string', description: 'Filter by file path' },
          change_type: { type: 'string', description: 'Filter by change type: create, edit, delete' },
          days: { type: 'number', description: 'Days to look back (default: 30)' },
          limit: { type: 'number', description: 'Max results (default: 50)' },
        },
        required: [],
      },
    },
    {
      name: p('audit_report'),
      description: 'Generate an audit report in a specified format (summary, detailed, soc2).',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', description: 'Report format: summary, detailed, soc2 (default: summary)' },
          days: { type: 'number', description: 'Days to cover (default: 30)' },
        },
        required: [],
      },
    },
    {
      name: p('audit_chain'),
      description: 'Get the complete audit trail for a specific file. Shows all changes, reviews, and decisions chronologically.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path to trace' },
        },
        required: ['file'],
      },
    },
  ];
}

const AUDIT_BASE_NAMES = new Set(['audit_log', 'audit_report', 'audit_chain']);

export function isAuditTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return AUDIT_BASE_NAMES.has(baseName);
}

export function handleAuditToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'audit_log':
        return handleAuditLog(args, memoryDb);
      case 'audit_report':
        return handleAuditReport(args, memoryDb);
      case 'audit_chain':
        return handleAuditChain(args, memoryDb);
      default:
        return text(`Unknown audit tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('audit_log')} { severity: "critical" }, ${p('audit_report')} { format: "soc2" }`);
  }
}

function handleAuditLog(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const entries = queryAuditLog(db, {
    eventType: args.event_type as string | undefined,
    actor: args.actor as string | undefined,
    filePath: args.file_path as string | undefined,
    changeType: args.change_type as string | undefined,
    days: (args.days as number) ?? 30,
    limit: (args.limit as number) ?? 50,
  });

  if (entries.length === 0) {
    return text(`No audit log entries found matching the filters. Audit entries are recorded automatically during code changes, rule checks, and commits. Try broadening your search: ${p('audit_log')} { days: 90 } for a longer time range, or ${p('audit_log')} {} with no filters.`);
  }

  const lines = [
    `## Audit Log (${entries.length} entries)`,
    '',
    '| Timestamp | Event | Actor | Change | File | Evidence |',
    '|-----------|-------|-------|--------|------|----------|',
  ];

  for (const entry of entries) {
    const file = entry.file_path ? (entry.file_path as string).split('/').pop() : '-';
    const evidence = entry.evidence ? (entry.evidence as string).slice(0, 50) : '-';
    lines.push(
      `| ${(entry.timestamp as string).slice(0, 16)} | ${entry.event_type} | ${entry.actor} | ${entry.change_type ?? '-'} | ${file} | ${evidence} |`
    );
  }

  return text(lines.join('\n'));
}

function handleAuditReport(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const format = (args.format as string) ?? 'summary';
  const days = (args.days as number) ?? 30;

  const availableFormats = getAuditFormats();
  if (!availableFormats.includes(format)) {
    return text(`Unknown report format: "${format}". Available formats: ${availableFormats.join(', ')}. Example: ${p('audit_report')} { format: "soc2", days: 30 }. Configure additional formats via the governance.audit.formats config key.`);
  }

  const entries = queryAuditLog(db, { days });

  if (entries.length === 0) {
    return text(`No audit entries found in the last ${days} days. Audit entries are recorded automatically during code changes, reviews, and commits. Try: ${p('audit_log')} { days: 90 } for a longer time range.`);
  }

  // Count by event type and actor
  const byEventType: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  for (const e of entries) {
    const et = e.event_type as string;
    byEventType[et] = (byEventType[et] ?? 0) + 1;
    const actor = e.actor as string;
    byActor[actor] = (byActor[actor] ?? 0) + 1;
  }

  if (format === 'soc2') {
    return generateSoc2Report(entries, byEventType, byActor, days);
  }

  if (format === 'detailed') {
    return generateDetailedReport(entries, byEventType, byActor, days);
  }

  // Summary format
  const lines = [
    `## Audit Summary Report (${days} days)`,
    `Generated: ${new Date().toISOString().slice(0, 16)}`,
    '',
    '### By Event Type',
    `| Event Type | Count |`,
    `|------------|-------|`,
  ];

  for (const [et, count] of Object.entries(byEventType).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${et} | ${count} |`);
  }

  lines.push(`| **Total** | **${entries.length}** |`);
  lines.push('');
  lines.push('### By Actor');
  lines.push(`| Actor | Count |`);
  lines.push(`|-------|-------|`);

  for (const [actor, count] of Object.entries(byActor).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${actor} | ${count} |`);
  }

  return text(lines.join('\n'));
}

function generateSoc2Report(
  entries: Array<Record<string, unknown>>,
  byEventType: Record<string, number>,
  byActor: Record<string, number>,
  days: number
): ToolResult {
  const lines = [
    `# SOC 2 Compliance Report`,
    `Period: Last ${days} days`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '## 1. Control Environment',
    `Total audit events: ${entries.length}`,
    `Human-initiated: ${byActor['human'] ?? 0}`,
    `AI-initiated: ${byActor['ai'] ?? 0}`,
    `Hook-triggered: ${byActor['hook'] ?? 0}`,
    '',
    '## 2. Change Management',
    `Code changes logged: ${byEventType['code_change'] ?? 0}`,
    `Rule enforcements: ${byEventType['rule_enforced'] ?? 0}`,
    `Approvals recorded: ${byEventType['approval'] ?? 0}`,
    `Reviews: ${byEventType['review'] ?? 0}`,
    `Commits: ${byEventType['commit'] ?? 0}`,
    '',
    '## 3. Approval Status',
  ];

  const pendingApprovals = entries.filter(e => e.approval_status === 'pending');
  const deniedApprovals = entries.filter(e => e.approval_status === 'denied');
  lines.push(`Pending approvals: ${pendingApprovals.length}`);
  lines.push(`Denied approvals: ${deniedApprovals.length}`);
  lines.push('');
  lines.push('## 4. Events Requiring Review');

  const reviewEntries = entries.filter(e => e.approval_status === 'denied' || e.event_type === 'rule_enforced');
  if (reviewEntries.length > 0) {
    for (const e of reviewEntries.slice(0, 20)) {
      lines.push(`- [${(e.timestamp as string).slice(0, 16)}] ${e.event_type}: ${((e.evidence as string) ?? '').slice(0, 100)}`);
    }
  } else {
    lines.push('No events requiring review in this period.');
  }

  return text(lines.join('\n'));
}

function generateDetailedReport(
  entries: Array<Record<string, unknown>>,
  byEventType: Record<string, number>,
  byActor: Record<string, number>,
  days: number
): ToolResult {
  const lines = [
    `## Detailed Audit Report (${days} days)`,
    `Total events: ${entries.length}`,
    '',
    '### Event Type Distribution',
  ];

  for (const [et, count] of Object.entries(byEventType).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${et}: ${count}`);
  }

  lines.push('');
  lines.push('### Actor Distribution');
  for (const [actor, count] of Object.entries(byActor).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${actor}: ${count}`);
  }

  lines.push('');
  lines.push('### All Events');

  for (const e of entries.slice(0, 100)) {
    lines.push(`#### ${(e.timestamp as string).slice(0, 16)} [${e.event_type}]`);
    lines.push(`Actor: ${e.actor} | Change: ${e.change_type ?? '-'} | Approval: ${e.approval_status ?? '-'}`);
    if (e.file_path) lines.push(`File: ${e.file_path}`);
    if (e.evidence) lines.push(`Evidence: ${e.evidence}`);
    lines.push('');
  }

  if (entries.length > 100) {
    lines.push(`... and ${entries.length - 100} more entries`);
  }

  return text(lines.join('\n'));
}

function handleAuditChain(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const filePath = args.file as string;
  if (!filePath) return text(`Usage: ${p('audit_chain')} { file: "src/path/to/file.ts" } - Get complete audit history for a file.`);

  const chain = getFileChain(db, filePath);

  if (chain.length === 0) {
    return text(`No audit entries found for "${filePath}". Audit entries are recorded automatically when files are modified, reviewed, or validated. Try: ${p('audit_log')} {} to see all recent audit entries across all files.`);
  }

  const lines = [
    `## Audit Chain: ${filePath}`,
    `Total events: ${chain.length}`,
    '',
  ];

  for (const entry of chain) {
    lines.push(`### ${(entry.timestamp as string).slice(0, 16)} [${entry.event_type}]`);
    lines.push(`**${entry.actor}** (${entry.change_type ?? 'unknown'})`);
    if (entry.evidence) lines.push(entry.evidence as string);
    lines.push('');
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

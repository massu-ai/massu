// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { indexIfStale } from './knowledge-indexer.ts';
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { getConfig, getResolvedPaths } from './config.ts';
import { getDataDb } from './db.ts';
import { getMemoryDb, sanitizeFts5Query } from './memory-db.ts';

// ============================================================
// Massu Knowledge: MCP Tool Definitions & Handlers
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

/** Strip the configured prefix from a tool name to get the base name. */
function stripPrefix(name: string): string {
  const pfx = getConfig().toolPrefix + '_';
  if (name.startsWith(pfx)) {
    return name.slice(pfx.length);
  }
  return name;
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

/**
 * Ensure knowledge DB is indexed before queries (P4-002: lazy re-index).
 * Non-fatal: returns false if indexing fails, tools should degrade gracefully.
 */
function ensureKnowledgeIndexed(db: Database.Database): boolean {
  try {
    indexIfStale(db);
    return true;
  } catch {
    return false;
  }
}

function hasData(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_documents').get() as { cnt: number } | undefined;
  return (row?.cnt ?? 0) > 0;
}

// ============================================================
// Tool Definitions (12 tools)
// ============================================================

export function getKnowledgeToolDefinitions(): ToolDefinition[] {
  const claudeDir = getConfig().conventions?.claudeDirName ?? '.claude';
  return [
    // P2-001: knowledge_search
    {
      name: p('knowledge_search'),
      description: `Full-text + structured search across all ${claudeDir}/ knowledge (rules, patterns, incidents, commands, protocols). Returns matched chunks with file path, heading, and content preview.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'FTS5 search term (e.g., "BigInt serialization", "schema mismatch")' },
          category: { type: 'string', description: 'Filter by category: patterns, commands, incidents, reference, protocols, memory, checklists, playbooks, critical, root' },
          chunk_type: { type: 'string', description: 'Filter by chunk type: section, rule, incident, pattern, command, mismatch, code_block, table_row' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    // P2-002: knowledge_rule
    {
      name: p('knowledge_rule'),
      description: 'Look up a specific CR rule, its VR verification, linked incidents, and prevention. Returns rule text, reference file, and connected entities.',
      inputSchema: {
        type: 'object',
        properties: {
          rule_id: { type: 'string', description: 'Exact CR rule ID (e.g., "CR-6")' },
          keyword: { type: 'string', description: 'Search rule text (e.g., "database schema")' },
          with_incidents: { type: 'boolean', description: 'Include linked incidents (default true)' },
        },
        required: [],
      },
    },
    // P2-003: knowledge_incident
    {
      name: p('knowledge_incident'),
      description: 'Look up a specific incident or search incidents by type/keyword. Returns full incident detail with date, type, gap, prevention, CR added, root cause.',
      inputSchema: {
        type: 'object',
        properties: {
          incident_num: { type: 'number', description: 'Exact incident number' },
          keyword: { type: 'string', description: 'Search gap_found + prevention + root_cause text' },
          type: { type: 'string', description: 'Filter by type (e.g., "Schema Migration", "Plan Verification")' },
        },
        required: [],
      },
    },
    // P2-004: knowledge_schema_check
    {
      name: p('knowledge_schema_check'),
      description: `Check if a table/column name has a known mismatch documented in ${claudeDir}/. Instant warning for common pitfalls.`,
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to check' },
          column: { type: 'string', description: 'Column name to check if known-wrong anywhere' },
        },
        required: [],
      },
    },
    // P2-005: knowledge_pattern
    {
      name: p('knowledge_pattern'),
      description: 'Get relevant pattern guidance for a domain/topic without loading entire pattern files. Returns relevant sections with code examples and anti-patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain: database, auth, ui, build, security, realtime, form, etc.' },
          topic: { type: 'string', description: 'Narrow to specific topic (e.g., "BigInt", "RLS", "Select.Item", "ctx.db")' },
        },
        required: ['domain'],
      },
    },
    // P2-006: knowledge_verification
    {
      name: p('knowledge_verification'),
      description: 'Look up which VR-* check to run for a given situation. Returns VR type, command, expected output, when to use.',
      inputSchema: {
        type: 'object',
        properties: {
          vr_type: { type: 'string', description: 'Exact VR type (e.g., "VR-BUILD", "VR-SCHEMA-PRE")' },
          situation: { type: 'string', description: 'Describe the situation (e.g., "claiming production ready", "schema change")' },
        },
        required: [],
      },
    },
    // P2-007: knowledge_graph
    {
      name: p('knowledge_graph'),
      description: 'Traverse the knowledge cross-reference graph. Find everything connected to a given entity (CR, VR, incident, pattern, command) at configurable depth.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_type: { type: 'string', description: 'Type: cr, vr, incident, pattern, command, chunk' },
          entity_id: { type: 'string', description: 'ID: "CR-6", "VR-SCHEMA", "3", "database-patterns"' },
          depth: { type: 'number', description: 'Traversal depth (default 1, max 3)' },
        },
        required: ['entity_type', 'entity_id'],
      },
    },
    // P2-008: knowledge_command
    {
      name: p('knowledge_command'),
      description: 'Get summary of a slash command\'s purpose, workflow position, and key rules. Search commands by name or keyword.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command name (e.g., "massu-loop", "massu-plan")' },
          keyword: { type: 'string', description: 'Search command descriptions (e.g., "audit", "implement")' },
        },
        required: [],
      },
    },
    // P2-009: knowledge_correct
    {
      name: p('knowledge_correct'),
      description: 'Record a user correction for persistent behavioral learning. Appends structured entry to corrections.md and indexes into knowledge DB.',
      inputSchema: {
        type: 'object',
        properties: {
          wrong: { type: 'string', description: 'What the model did incorrectly' },
          correction: { type: 'string', description: 'The correct behavior (user feedback)' },
          rule: { type: 'string', description: 'Prevention rule in imperative form' },
          cr_rule: { type: 'string', description: 'Linked canonical rule ID (e.g., CR-28). Optional.' },
        },
        required: ['wrong', 'correction', 'rule'],
      },
    },
    // P2-010: knowledge_plan
    {
      name: p('knowledge_plan'),
      description: 'Find plans related to a file, feature, or keyword. Answers "which plan created/modified this file?" and "which files does plan X touch?"',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path to find related plans for (e.g., "src/server/api/routers/orders.ts")' },
          keyword: { type: 'string', description: 'Search plan titles and content by keyword' },
          plan_name: { type: 'string', description: 'Plan filename or slug to get details for' },
          status: { type: 'string', description: 'Filter by implementation status: COMPLETE, IN_PROGRESS, NOT_STARTED' },
        },
        required: [],
      },
    },
    // P2-011: knowledge_gaps
    {
      name: p('knowledge_gaps'),
      description: `Detect documentation blind spots: features, routers, or domains with no corresponding ${claudeDir}/ documentation coverage. Cross-references sentinel features against knowledge documents.`,
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Check gaps for specific domain' },
          check_type: { type: 'string', enum: ['features', 'routers', 'patterns', 'incidents'], description: 'Type of gap check. Default: features' },
        },
        required: [],
      },
    },
    // P2-012: knowledge_effectiveness
    {
      name: p('knowledge_effectiveness'),
      description: 'Track which CR rules and VR checks are most frequently violated or triggered. Cross-references rules against memory observations to rank by effectiveness.',
      inputSchema: {
        type: 'object',
        properties: {
          rule_id: { type: 'string', description: 'Check effectiveness of a specific rule (e.g., CR-28)' },
          top_n: { type: 'number', description: 'Show top N most/least violated rules. Default: 10' },
          mode: { type: 'string', enum: ['most_violated', 'least_violated', 'most_effective', 'detail'], description: 'Ranking mode. Default: most_violated' },
        },
        required: [],
      },
    },
  ];
}

// ============================================================
// Tool Name Matching (3-function pattern)
// ============================================================

const KNOWLEDGE_BASE_NAMES = new Set([
  'knowledge_search',
  'knowledge_rule',
  'knowledge_incident',
  'knowledge_schema_check',
  'knowledge_pattern',
  'knowledge_verification',
  'knowledge_graph',
  'knowledge_command',
  'knowledge_correct',
  'knowledge_plan',
  'knowledge_gaps',
  'knowledge_effectiveness',
]);

export function isKnowledgeTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return KNOWLEDGE_BASE_NAMES.has(baseName);
}

// ============================================================
// Tool Handler Router
// ============================================================

export function handleKnowledgeToolCall(
  name: string,
  args: Record<string, unknown>,
  db: Database.Database
): ToolResult {
  // P4-002: Lazy re-index before any query
  ensureKnowledgeIndexed(db);

  if (!hasData(db)) {
    return text('No knowledge indexed yet. The knowledge DB will be populated automatically on next MCP server restart.');
  }

  const baseName = stripPrefix(name);

  switch (baseName) {
    case 'knowledge_search':
      return handleSearch(db, args);
    case 'knowledge_rule':
      return handleRule(db, args);
    case 'knowledge_incident':
      return handleIncident(db, args);
    case 'knowledge_schema_check':
      return handleSchemaCheck(db, args);
    case 'knowledge_pattern':
      return handlePattern(db, args);
    case 'knowledge_verification':
      return handleVerification(db, args);
    case 'knowledge_graph':
      return handleGraph(db, args);
    case 'knowledge_command':
      return handleCommand(db, args);
    case 'knowledge_correct':
      return handleCorrect(db, args);
    case 'knowledge_plan':
      return handlePlan(db, args);
    case 'knowledge_gaps':
      return handleGaps(db, args);
    case 'knowledge_effectiveness':
      return handleEffectiveness(db, args);
    default:
      return text(`Unknown knowledge tool: ${name}`);
  }
}

// ============================================================
// P2-001: knowledge_search
// ============================================================

function handleSearch(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const claudeDir = getConfig().conventions?.claudeDirName ?? '.claude';
  const query = args.query as string;
  const category = args.category as string | undefined;
  const chunkType = args.chunk_type as string | undefined;
  const limit = Math.min((args.limit as number) || 10, 50);

  if (!query) return text('Error: query is required');

  const lines: string[] = [];
  lines.push(`## Knowledge Search: "${query}"`);
  lines.push('');

  try {
    // Build FTS5 query with optional filters
    let sql = `
      SELECT kc.id, kc.heading, kc.content, kc.chunk_type, kc.metadata,
             kd.file_path, kd.category, kd.title,
             rank
      FROM knowledge_fts
      JOIN knowledge_chunks kc ON kc.id = knowledge_fts.rowid
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE knowledge_fts MATCH ?
    `;
    const params: (string | number)[] = [sanitizeFts5Query(query)];

    if (category) {
      sql += ' AND kd.category = ?';
      params.push(category);
    }
    if (chunkType) {
      sql += ' AND kc.chunk_type = ?';
      params.push(chunkType);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    const results = db.prepare(sql).all(...params) as {
      id: number; heading: string; content: string; chunk_type: string;
      metadata: string; file_path: string; category: string; title: string; rank: number;
    }[];

    if (results.length === 0) {
      lines.push('No matches found.');
      lines.push('');
      lines.push('Tips: Try broader terms, check spelling, or remove filters.');
    } else {
      lines.push(`Found ${results.length} result(s):`);
      lines.push('');

      for (const r of results) {
        const preview = r.content.length > 500 ? r.content.substring(0, 500) + '...' : r.content;
        lines.push(`### ${r.heading || r.title} [${r.chunk_type}]`);
        lines.push(`**File**: ${claudeDir}/${r.file_path} | **Category**: ${r.category}`);
        lines.push('');
        lines.push(preview);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }
  } catch (error) {
    lines.push(`Search error: ${error instanceof Error ? error.message : String(error)}`);
    lines.push('');
    lines.push('Tip: FTS5 uses match syntax. For exact phrase, wrap in double quotes: "BigInt serialization"');
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-002: knowledge_rule
// ============================================================

function handleRule(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const ruleId = args.rule_id as string | undefined;
  const keyword = args.keyword as string | undefined;
  const withIncidents = args.with_incidents !== false; // default true

  const lines: string[] = [];

  if (ruleId) {
    // Exact lookup
    const rule = db.prepare('SELECT * FROM knowledge_rules WHERE rule_id = ?').get(ruleId) as {
      rule_id: string; rule_text: string; vr_type: string; reference_path: string;
      severity: string; prevention_summary: string;
    } | undefined;

    if (!rule) {
      return text(`Rule ${ruleId} not found in knowledge base. Try ${p('knowledge_search')} with query: "${ruleId}" or ${p('knowledge_rule')} with keyword to search rule text.`);
    }

    lines.push(`## ${rule.rule_id}: ${rule.rule_text}`);
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Verification** | ${rule.vr_type || 'N/A'} |`);
    lines.push(`| **Reference** | ${rule.reference_path || 'N/A'} |`);
    lines.push(`| **Severity** | ${rule.severity || 'HIGH'} |`);
    if (rule.prevention_summary) {
      lines.push(`| **Prevention** | ${rule.prevention_summary} |`);
    }
    lines.push('');

    // Get linked VR details
    if (rule.vr_type) {
      const vrTypes = rule.vr_type.split(/[,\s]+/).filter(v => v.startsWith('VR-'));
      for (const vrType of vrTypes) {
        const vr = db.prepare('SELECT * FROM knowledge_verifications WHERE vr_type = ?').get(vrType) as {
          vr_type: string; command: string; expected: string; use_when: string;
        } | undefined;
        if (vr) {
          lines.push(`### Verification: ${vr.vr_type}`);
          lines.push(`- **Command**: \`${vr.command}\``);
          lines.push(`- **Expected**: ${vr.expected}`);
          lines.push(`- **Use When**: ${vr.use_when}`);
          lines.push('');
        }
      }
    }

    // Get linked incidents
    if (withIncidents) {
      const edges = db.prepare(
        "SELECT source_id FROM knowledge_edges WHERE target_type = 'cr' AND target_id = ? AND source_type = 'incident'"
      ).all(ruleId) as { source_id: string }[];

      if (edges.length > 0) {
        lines.push('### Related Incidents');
        for (const edge of edges) {
          const incident = db.prepare('SELECT * FROM knowledge_incidents WHERE incident_num = ?').get(parseInt(edge.source_id, 10)) as {
            incident_num: number; date: string; type: string; gap_found: string; prevention: string;
          } | undefined;
          if (incident) {
            lines.push(`- **Incident #${incident.incident_num}** (${incident.date}): ${incident.type}`);
            lines.push(`  Gap: ${incident.gap_found}`);
            lines.push(`  Prevention: ${incident.prevention}`);
          }
        }
        lines.push('');
      }
    }
  } else if (keyword) {
    // Search by keyword
    const rules = db.prepare(
      'SELECT * FROM knowledge_rules WHERE rule_text LIKE ? OR rule_id LIKE ? ORDER BY rule_id'
    ).all(`%${keyword}%`, `%${keyword}%`) as {
      rule_id: string; rule_text: string; vr_type: string; reference_path: string;
    }[];

    lines.push(`## Rules matching "${keyword}" (${rules.length} found)`);
    lines.push('');

    for (const rule of rules) {
      lines.push(`- **${rule.rule_id}**: ${rule.rule_text} | VR: ${rule.vr_type || 'N/A'} | Ref: ${rule.reference_path || 'N/A'}`);
    }
  } else {
    // List all rules
    const rules = db.prepare('SELECT * FROM knowledge_rules ORDER BY rule_id').all() as {
      rule_id: string; rule_text: string; vr_type: string;
    }[];

    lines.push(`## All Canonical Rules (${rules.length} total)`);
    lines.push('');

    for (const rule of rules) {
      lines.push(`- **${rule.rule_id}**: ${rule.rule_text} (${rule.vr_type || 'N/A'})`);
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-003: knowledge_incident
// ============================================================

function handleIncident(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const incidentNum = args.incident_num as number | undefined;
  const keyword = args.keyword as string | undefined;
  const type = args.type as string | undefined;

  const lines: string[] = [];

  if (incidentNum) {
    // Exact lookup
    const incident = db.prepare('SELECT * FROM knowledge_incidents WHERE incident_num = ?').get(incidentNum) as {
      incident_num: number; date: string; type: string; gap_found: string;
      prevention: string; cr_added: string; root_cause: string; user_quote: string;
    } | undefined;

    if (!incident) {
      return text(`Incident #${incidentNum} not found in knowledge base. Try ${p('knowledge_incident')} with keyword to search incident descriptions.`);
    }

    lines.push(`## Incident #${incident.incident_num}`);
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Date** | ${incident.date} |`);
    lines.push(`| **Type** | ${incident.type} |`);
    lines.push(`| **Gap Found** | ${incident.gap_found} |`);
    lines.push(`| **Prevention** | ${incident.prevention} |`);
    if (incident.cr_added) lines.push(`| **CR Added** | ${incident.cr_added} |`);
    if (incident.root_cause) lines.push(`| **Root Cause** | ${incident.root_cause} |`);
    if (incident.user_quote) lines.push(`| **User Quote** | ${incident.user_quote.replace(/\|/g, '\\|')} |`);
    lines.push('');

    // Show linked CRs
    const edges = db.prepare(
      "SELECT target_id FROM knowledge_edges WHERE source_type = 'incident' AND source_id = ? AND target_type = 'cr'"
    ).all(String(incidentNum)) as { target_id: string }[];

    if (edges.length > 0) {
      lines.push('### Linked Rules');
      for (const edge of edges) {
        const rule = db.prepare('SELECT rule_id, rule_text FROM knowledge_rules WHERE rule_id = ?').get(edge.target_id) as { rule_id: string; rule_text: string } | undefined;
        if (rule) {
          lines.push(`- **${rule.rule_id}**: ${rule.rule_text}`);
        }
      }
      lines.push('');
    }
  } else {
    // Search or filter
    let sql = 'SELECT * FROM knowledge_incidents WHERE 1=1';
    const params: string[] = [];

    if (keyword) {
      sql += ' AND (gap_found LIKE ? OR prevention LIKE ? OR root_cause LIKE ? OR type LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw, kw);
    }
    if (type) {
      sql += ' AND type LIKE ?';
      params.push(`%${type}%`);
    }

    sql += ' ORDER BY incident_num';

    const incidents = db.prepare(sql).all(...params) as {
      incident_num: number; date: string; type: string; gap_found: string;
      prevention: string; cr_added: string;
    }[];

    const desc = keyword ? `matching "${keyword}"` : type ? `type "${type}"` : 'all';
    lines.push(`## Incidents ${desc} (${incidents.length} found)`);
    lines.push('');

    for (const inc of incidents) {
      lines.push(`### #${inc.incident_num} (${inc.date}) — ${inc.type}`);
      lines.push(`- **Gap**: ${inc.gap_found}`);
      lines.push(`- **Prevention**: ${inc.prevention}`);
      if (inc.cr_added) lines.push(`- **CR Added**: ${inc.cr_added}`);
      lines.push('');
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-004: knowledge_schema_check
// ============================================================

function handleSchemaCheck(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const table = args.table as string | undefined;
  const column = args.column as string | undefined;

  const lines: string[] = [];

  if (table) {
    const mismatches = db.prepare(
      'SELECT * FROM knowledge_schema_mismatches WHERE table_name = ?'
    ).all(table) as { table_name: string; wrong_column: string; correct_column: string; source: string }[];

    if (mismatches.length > 0) {
      lines.push(`## Schema Mismatches for \`${table}\``);
      lines.push('');
      lines.push('| WRONG Column | CORRECT Column | Source |');
      lines.push('|-------------|----------------|--------|');
      for (const m of mismatches) {
        lines.push(`| \`${m.wrong_column}\` | \`${m.correct_column}\` | ${m.source} |`);
      }
      lines.push('');
      lines.push('**WARNING**: Using the WRONG column will cause runtime errors. Always use the CORRECT column.');
    } else {
      lines.push(`No known schema mismatches for table \`${table}\`.`);
    }
  }

  if (column) {
    const mismatches = db.prepare(
      'SELECT * FROM knowledge_schema_mismatches WHERE wrong_column = ?'
    ).all(column) as { table_name: string; wrong_column: string; correct_column: string; source: string }[];

    if (mismatches.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`## Column \`${column}\` is KNOWN WRONG in:`);
      lines.push('');
      for (const m of mismatches) {
        lines.push(`- **${m.table_name}**.${m.wrong_column} → should be **${m.correct_column}**`);
      }
    } else if (!table) {
      lines.push(`Column \`${column}\` has no known mismatches.`);
    }
  }

  if (!table && !column) {
    // Show all mismatches
    const all = db.prepare('SELECT * FROM knowledge_schema_mismatches ORDER BY table_name').all() as {
      table_name: string; wrong_column: string; correct_column: string;
    }[];

    lines.push(`## All Known Schema Mismatches (${all.length} total)`);
    lines.push('');
    lines.push('| Table | WRONG | CORRECT |');
    lines.push('|-------|-------|---------|');
    for (const m of all) {
      lines.push(`| ${m.table_name} | \`${m.wrong_column}\` | \`${m.correct_column}\` |`);
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-005: knowledge_pattern
// ============================================================

function handlePattern(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const claudeDir = getConfig().conventions?.claudeDirName ?? '.claude';
  const domain = args.domain as string;
  const topic = args.topic as string | undefined;

  if (!domain) return text('Error: domain is required');

  const lines: string[] = [];
  lines.push(`## Pattern Guidance: ${domain}${topic ? ` / ${topic}` : ''}`);
  lines.push('');

  // Find pattern documents matching the domain
  const domainPatterns = [
    `${domain}-patterns`,
    `${domain}`,
    `patterns-quickref`,
  ];

  // First: get chunks from domain-specific pattern files
  const docs = db.prepare(
    "SELECT id, file_path, title FROM knowledge_documents WHERE category = 'patterns' OR category = 'reference' OR category = 'root'"
  ).all() as { id: number; file_path: string; title: string }[];

  const relevantDocs = docs.filter(d =>
    domainPatterns.some(pat => d.file_path.toLowerCase().includes(pat.toLowerCase()))
  );

  if (relevantDocs.length === 0) {
    // Fall back to FTS search
    lines.push(`No dedicated pattern file found for domain "${domain}". Searching all knowledge...`);
    lines.push('');
  }

  if (topic && relevantDocs.length > 0) {
    // Search within domain-specific docs for the topic
    const docIds = relevantDocs.map(d => d.id);
    const placeholders = docIds.map(() => '?').join(',');

    try {
      const topicResults = db.prepare(`
        SELECT kc.heading, kc.content, kc.chunk_type, kd.file_path
        FROM knowledge_fts
        JOIN knowledge_chunks kc ON kc.id = knowledge_fts.rowid
        JOIN knowledge_documents kd ON kd.id = kc.document_id
        WHERE knowledge_fts MATCH ?
        AND kc.document_id IN (${placeholders})
        ORDER BY rank
        LIMIT 10
      `).all(sanitizeFts5Query(topic), ...docIds) as {
        heading: string; content: string; chunk_type: string; file_path: string;
      }[];

      if (topicResults.length > 0) {
        for (const r of topicResults) {
          lines.push(`### ${r.heading || '(section)'} [${r.chunk_type}]`);
          lines.push(`*Source: ${claudeDir}/${r.file_path}*`);
          lines.push('');
          lines.push(r.content.length > 800 ? r.content.substring(0, 800) + '...' : r.content);
          lines.push('');
          lines.push('---');
          lines.push('');
        }
      } else {
        lines.push(`No specific sections found for topic "${topic}" in ${domain} patterns.`);
        lines.push('');
      }
    } catch {
      // FTS5 syntax error — fall through to direct search
      lines.push(`FTS5 search failed for topic "${topic}". Showing all ${domain} sections instead.`);
      lines.push('');
    }
  }

  if (!topic && relevantDocs.length > 0) {
    // Show all sections from the domain pattern file
    for (const doc of relevantDocs.slice(0, 2)) {
      const chunks = db.prepare(
        "SELECT heading, content, chunk_type FROM knowledge_chunks WHERE document_id = ? AND chunk_type = 'section' ORDER BY line_start"
      ).all(doc.id) as { heading: string; content: string; chunk_type: string }[];

      lines.push(`### From: ${claudeDir}/${doc.file_path}`);
      lines.push('');
      lines.push(`**Sections** (${chunks.length} total):`);
      for (const c of chunks) {
        const preview = c.content.length > 100 ? c.content.substring(0, 100) + '...' : c.content;
        lines.push(`- **${c.heading || '(untitled)'}**: ${preview}`);
      }
      lines.push('');
    }
  }

  // If no results from domain docs, try broad FTS
  if (relevantDocs.length === 0 || lines.length < 5) {
    const searchTerm = topic ? `${domain} ${topic}` : domain;
    try {
      const ftsResults = db.prepare(`
        SELECT kc.heading, kc.content, kc.chunk_type, kd.file_path
        FROM knowledge_fts
        JOIN knowledge_chunks kc ON kc.id = knowledge_fts.rowid
        JOIN knowledge_documents kd ON kd.id = kc.document_id
        WHERE knowledge_fts MATCH ?
        ORDER BY rank
        LIMIT 5
      `).all(sanitizeFts5Query(searchTerm)) as {
        heading: string; content: string; chunk_type: string; file_path: string;
      }[];

      if (ftsResults.length > 0) {
        lines.push('### Broad Search Results');
        lines.push('');
        for (const r of ftsResults) {
          lines.push(`- **${r.heading || '(section)'}** (${claudeDir}/${r.file_path}): ${r.content.substring(0, 200)}...`);
        }
      }
    } catch {
      // FTS syntax error — skip
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-006: knowledge_verification
// ============================================================

function handleVerification(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const vrType = args.vr_type as string | undefined;
  const situation = args.situation as string | undefined;

  const lines: string[] = [];

  if (vrType) {
    const vr = db.prepare('SELECT * FROM knowledge_verifications WHERE vr_type = ?').get(vrType) as {
      vr_type: string; command: string; expected: string; use_when: string; catches: string; category: string;
    } | undefined;

    if (!vr) {
      return text(`Verification type ${vrType} not found. Use ${p('knowledge_search')} to find related checks.`);
    }

    lines.push(`## ${vr.vr_type}`);
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Command** | \`${vr.command}\` |`);
    lines.push(`| **Expected** | ${vr.expected} |`);
    lines.push(`| **Use When** | ${vr.use_when} |`);
    if (vr.catches) lines.push(`| **Catches** | ${vr.catches} |`);
    if (vr.category) lines.push(`| **Category** | ${vr.category} |`);
  } else if (situation) {
    // Search use_when field
    const results = db.prepare(
      'SELECT * FROM knowledge_verifications WHERE use_when LIKE ? OR vr_type LIKE ? OR catches LIKE ? ORDER BY vr_type'
    ).all(`%${situation}%`, `%${situation}%`, `%${situation}%`) as {
      vr_type: string; command: string; expected: string; use_when: string; catches: string;
    }[];

    lines.push(`## Verifications for "${situation}" (${results.length} found)`);
    lines.push('');

    for (const vr of results) {
      lines.push(`### ${vr.vr_type}`);
      lines.push(`- **Command**: \`${vr.command}\``);
      lines.push(`- **Expected**: ${vr.expected}`);
      lines.push(`- **Use When**: ${vr.use_when}`);
      lines.push('');
    }
  } else {
    // List all
    const all = db.prepare('SELECT vr_type, command, use_when FROM knowledge_verifications ORDER BY vr_type').all() as {
      vr_type: string; command: string; use_when: string;
    }[];

    lines.push(`## All Verification Types (${all.length} total)`);
    lines.push('');

    for (const vr of all) {
      lines.push(`- **${vr.vr_type}**: \`${vr.command}\` — ${vr.use_when}`);
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-007: knowledge_graph
// ============================================================

function handleGraph(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const entityType = args.entity_type as string;
  const entityId = args.entity_id as string;
  const maxDepth = Math.min((args.depth as number) || 1, 3);

  if (!entityType || !entityId) return text('Error: entity_type and entity_id are required');

  const lines: string[] = [];
  lines.push(`## Knowledge Graph: ${entityType}/${entityId} (depth ${maxDepth})`);
  lines.push('');

  // BFS traversal
  type Entity = { type: string; id: string };
  const visited = new Set<string>();
  let currentLevel: Entity[] = [{ type: entityType, id: entityId }];
  visited.add(`${entityType}:${entityId}`);

  for (let depth = 0; depth < maxDepth && currentLevel.length > 0; depth++) {
    const nextLevel: Entity[] = [];

    lines.push(`### Depth ${depth + 1}`);
    lines.push('');

    for (const entity of currentLevel) {
      // Find outgoing edges
      const outgoing = db.prepare(
        'SELECT target_type, target_id, edge_type FROM knowledge_edges WHERE source_type = ? AND source_id = ?'
      ).all(entity.type, entity.id) as { target_type: string; target_id: string; edge_type: string }[];

      // Find incoming edges
      const incoming = db.prepare(
        'SELECT source_type, source_id, edge_type FROM knowledge_edges WHERE target_type = ? AND target_id = ?'
      ).all(entity.type, entity.id) as { source_type: string; source_id: string; edge_type: string }[];

      for (const edge of outgoing) {
        const key = `${edge.target_type}:${edge.target_id}`;
        if (!visited.has(key)) {
          visited.add(key);
          lines.push(`- ${entity.type}/${entity.id} —[${edge.edge_type}]→ **${edge.target_type}/${edge.target_id}**`);
          nextLevel.push({ type: edge.target_type, id: edge.target_id });
        }
      }

      for (const edge of incoming) {
        const key = `${edge.source_type}:${edge.source_id}`;
        if (!visited.has(key)) {
          visited.add(key);
          lines.push(`- **${edge.source_type}/${edge.source_id}** —[${edge.edge_type}]→ ${entity.type}/${entity.id}`);
          nextLevel.push({ type: edge.source_type, id: edge.source_id });
        }
      }
    }

    if (nextLevel.length === 0) {
      lines.push('(no further connections)');
    }
    lines.push('');

    currentLevel = nextLevel;
  }

  // Summary
  lines.push(`**Total connected entities**: ${visited.size - 1}`);

  return text(lines.join('\n'));
}

// ============================================================
// P2-008: knowledge_command
// ============================================================

function handleCommand(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const claudeDir = getConfig().conventions?.claudeDirName ?? '.claude';
  const command = args.command as string | undefined;
  const keyword = args.keyword as string | undefined;

  const lines: string[] = [];

  if (command) {
    // Exact command lookup — find the command chunk
    // Support both prefixed (massu-xxx) and unprefixed (xxx) lookups
    const chunks = db.prepare(`
      SELECT kc.heading, kc.content, kd.file_path, kd.title, kd.description
      FROM knowledge_chunks kc
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE kc.chunk_type = 'command' AND (kc.heading = ? OR kc.heading = ?)
      LIMIT 1
    `).all(command, command.replace('massu-', '')) as {
      heading: string; content: string; file_path: string; title: string; description: string;
    }[];

    if (chunks.length === 0) {
      // Try searching by file path
      const doc = db.prepare(
        "SELECT id, file_path, title, description FROM knowledge_documents WHERE category = 'commands' AND file_path LIKE ?"
      ).get(`%${command}%`) as { id: number; file_path: string; title: string; description: string } | undefined;

      if (!doc) {
        return text(`Command "${command}" not found. Use keyword search to find related commands.`);
      }

      // Get the first section of this command's document
      const sections = db.prepare(
        "SELECT heading, content FROM knowledge_chunks WHERE document_id = ? AND chunk_type = 'section' ORDER BY line_start LIMIT 3"
      ).all(doc.id) as { heading: string; content: string }[];

      lines.push(`## Command: ${command}`);
      lines.push(`**File**: ${claudeDir}/${doc.file_path}`);
      if (doc.description) lines.push(`**Description**: ${doc.description}`);
      lines.push('');

      for (const s of sections) {
        lines.push(`### ${s.heading}`);
        lines.push(s.content.length > 500 ? s.content.substring(0, 500) + '...' : s.content);
        lines.push('');
      }
    } else {
      const chunk = chunks[0];
      lines.push(`## Command: ${chunk.heading}`);
      lines.push(`**File**: ${claudeDir}/${chunk.file_path}`);
      if (chunk.description) lines.push(`**Description**: ${chunk.description}`);
      lines.push('');
      lines.push(chunk.content);
    }
  } else if (keyword) {
    // Search commands
    const results = db.prepare(`
      SELECT kc.heading, kc.content, kd.file_path, kd.title
      FROM knowledge_chunks kc
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE kc.chunk_type = 'command' AND (kc.content LIKE ? OR kc.heading LIKE ?)
      ORDER BY kc.heading
    `).all(`%${keyword}%`, `%${keyword}%`) as {
      heading: string; content: string; file_path: string; title: string;
    }[];

    lines.push(`## Commands matching "${keyword}" (${results.length} found)`);
    lines.push('');

    for (const r of results) {
      const preview = r.content.substring(0, 200).replace(/\n/g, ' ');
      lines.push(`- **${r.heading}** (${claudeDir}/${r.file_path}): ${preview}...`);
    }
  } else {
    // List all commands
    const commands = db.prepare(`
      SELECT kc.heading, kd.file_path, kd.description
      FROM knowledge_chunks kc
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE kc.chunk_type = 'command'
      ORDER BY kc.heading
    `).all() as { heading: string; file_path: string; description: string }[];

    lines.push(`## All Commands (${commands.length} total)`);
    lines.push('');

    for (const cmd of commands) {
      lines.push(`- **${cmd.heading}** (${claudeDir}/${cmd.file_path})${cmd.description ? ': ' + cmd.description : ''}`);
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-009: knowledge_correct
// ============================================================

function handleCorrect(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const wrong = args.wrong as string;
  const correction = args.correction as string;
  const rule = args.rule as string;
  const crRule = args.cr_rule as string | undefined;

  if (!wrong || !correction || !rule) {
    return text('Error: wrong, correction, and rule are all required.');
  }

  // 1. Append to corrections.md
  const correctionsPath = resolve(getResolvedPaths().memoryDir, 'corrections.md');
  const today = new Date().toISOString().split('T')[0];
  const title = rule.slice(0, 60);

  const entry = `\n### ${today} - ${title}\n- **Wrong**: ${wrong}\n- **Correction**: ${correction}\n- **Rule**: ${rule}\n${crRule ? `- **CR**: ${crRule}\n` : ''}\n`;

  // Read existing content, find insertion point (before ## Archived if present, else append)
  let existing = '';
  try { existing = readFileSync(correctionsPath, 'utf-8'); } catch { /* new file */ }

  const archiveIdx = existing.indexOf('## Archived');
  if (archiveIdx > 0) {
    const before = existing.slice(0, archiveIdx);
    const after = existing.slice(archiveIdx);
    writeFileSync(correctionsPath, before + entry + after);
  } else {
    appendFileSync(correctionsPath, entry);
  }

  // 2. Index into knowledge DB immediately (insert chunk + edge)
  const doc = db.prepare('SELECT id FROM knowledge_documents WHERE file_path LIKE ?').get('%corrections.md') as { id: number } | undefined;
  if (doc) {
    db.prepare('INSERT INTO knowledge_chunks (document_id, chunk_type, heading, content, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(doc.id, 'section', `Correction: ${title}`,
        `Wrong: ${wrong}\nCorrection: ${correction}\nRule: ${rule}`,
        JSON.stringify({ is_correction: true, date: today, cr_rule: crRule }));

    if (crRule) {
      db.prepare('INSERT OR IGNORE INTO knowledge_edges (source_type, source_id, target_type, target_id, edge_type) VALUES (?, ?, ?, ?, ?)')
        .run('correction', title, 'cr', crRule, 'enforces');
    }
  }

  return text(`Correction recorded:\n- **Date**: ${today}\n- **Wrong**: ${wrong}\n- **Rule**: ${rule}\n${crRule ? `- **CR**: ${crRule}\n` : ''}File: corrections.md updated`);
}

// ============================================================
// P2-010: knowledge_plan
// ============================================================

function handlePlan(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const file = args.file as string | undefined;
  const keyword = args.keyword as string | undefined;
  const planName = args.plan_name as string | undefined;
  const status = args.status as string | undefined;

  const lines: string[] = [];

  if (file) {
    // Find plans that reference this file
    const results = db.prepare(`
      SELECT kd.file_path, kd.title, kc.content
      FROM knowledge_chunks kc
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE kd.category = 'plan'
      AND kc.heading = 'Referenced Files'
      AND kc.content LIKE ?
      ORDER BY kd.file_path DESC
      LIMIT 20
    `).all(`%${basename(file)}%`) as { file_path: string; title: string; content: string }[];

    lines.push(`## Plans referencing \`${file}\` (${results.length} found)`);
    lines.push('');

    for (const r of results) {
      lines.push(`- **${r.title}** (${r.file_path})`);
    }
  } else if (keyword) {
    // FTS search scoped to plan documents
    try {
      const results = db.prepare(`
        SELECT DISTINCT kd.file_path, kd.title
        FROM knowledge_fts kf
        JOIN knowledge_chunks kc ON kc.id = kf.rowid
        JOIN knowledge_documents kd ON kd.id = kc.document_id
        WHERE kf.content MATCH ? AND kd.category = 'plan'
        ORDER BY rank
        LIMIT 20
      `).all(sanitizeFts5Query(keyword)) as { file_path: string; title: string }[];

      lines.push(`## Plans matching "${keyword}" (${results.length} found)`);
      lines.push('');

      for (const r of results) {
        lines.push(`- **${r.title}** (${r.file_path})`);
      }
    } catch {
      lines.push(`FTS search error for "${keyword}". Try simpler terms.`);
    }
  } else if (planName) {
    // Find specific plan by filename
    const doc = db.prepare(
      "SELECT id, file_path, title, description FROM knowledge_documents WHERE category = 'plan' AND file_path LIKE ? LIMIT 1"
    ).get(`%${planName}%`) as { id: number; file_path: string; title: string; description: string } | undefined;

    if (!doc) {
      return text(`Plan "${planName}" not found. Try keyword search.`);
    }

    lines.push(`## Plan: ${doc.title}`);
    lines.push(`**File**: ${doc.file_path}`);
    if (doc.description) lines.push(`**Description**: ${doc.description}`);
    lines.push('');

    // Get plan items
    const items = db.prepare(
      "SELECT heading, content FROM knowledge_chunks WHERE document_id = ? AND metadata LIKE '%plan_item_id%' ORDER BY heading"
    ).all(doc.id) as { heading: string; content: string }[];

    if (items.length > 0) {
      lines.push(`### Plan Items (${items.length})`);
      for (const item of items) {
        lines.push(`- ${item.content}`);
      }
      lines.push('');
    }

    // Get implementation status
    const statusChunk = db.prepare(
      "SELECT content FROM knowledge_chunks WHERE document_id = ? AND heading = 'IMPLEMENTATION STATUS' LIMIT 1"
    ).get(doc.id) as { content: string } | undefined;

    if (statusChunk) {
      lines.push('### Implementation Status');
      lines.push(statusChunk.content.substring(0, 1000));
      lines.push('');
    }

    // Get referenced files
    const fileRefs = db.prepare(
      "SELECT content FROM knowledge_chunks WHERE document_id = ? AND heading = 'Referenced Files' LIMIT 1"
    ).get(doc.id) as { content: string } | undefined;

    if (fileRefs) {
      lines.push('### Referenced Files');
      lines.push(fileRefs.content.substring(0, 500));
    }
  } else if (status) {
    // Filter plans by status
    const docs = db.prepare(
      "SELECT kd.file_path, kd.title, kc.content FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id WHERE kd.category = 'plan' AND kc.heading = 'IMPLEMENTATION STATUS' AND kc.content LIKE ? ORDER BY kd.file_path DESC"
    ).all(`%${status}%`) as { file_path: string; title: string; content: string }[];

    lines.push(`## Plans with status "${status}" (${docs.length} found)`);
    lines.push('');

    for (const d of docs) {
      lines.push(`- **${d.title}** (${d.file_path})`);
    }
  } else {
    // List all plans
    const plans = db.prepare(
      "SELECT file_path, title FROM knowledge_documents WHERE category = 'plan' ORDER BY file_path DESC LIMIT 50"
    ).all() as { file_path: string; title: string }[];

    lines.push(`## All Plans (${plans.length} indexed)`);
    lines.push('');

    for (const plan of plans) {
      lines.push(`- **${plan.title}** (${plan.file_path})`);
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-011: knowledge_gaps
// ============================================================

function handleGaps(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const domain = args.domain as string | undefined;
  const checkType = (args.check_type as string) || 'features';

  const lines: string[] = [];
  lines.push(`## Knowledge Gap Analysis (${checkType})`);
  lines.push('');

  if (checkType === 'features') {
    // Query sentinel features from data DB (massu_sentinel table)
    let dataDb: Database.Database | null = null;
    try {
      dataDb = getDataDb();

      let sql = "SELECT feature_key, title, domain, status FROM massu_sentinel WHERE status = 'active'";
      const params: string[] = [];
      if (domain) {
        sql += ' AND domain LIKE ?';
        params.push(`%${domain}%`);
      }
      sql += ' ORDER BY domain, feature_key';

      const features = dataDb.prepare(sql).all(...params) as {
        feature_key: string; title: string; domain: string; status: string;
      }[];

      lines.push(`| Feature | Domain | Knowledge Hits | Status |`);
      lines.push(`|---------|--------|----------------|--------|`);

      let gapCount = 0;
      let coveredCount = 0;

      for (const feat of features) {
        // Search knowledge DB for this feature
        let hits = 0;
        try {
          const searchTerm = feat.title.replace(/['"]/g, '');
          const results = db.prepare(
            `SELECT COUNT(*) as cnt FROM knowledge_fts WHERE content MATCH ?`
          ).get(sanitizeFts5Query(searchTerm)) as { cnt: number };
          hits = results.cnt;
        } catch {
          // FTS error — try LIKE fallback
          const results = db.prepare(
            `SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE content LIKE ?`
          ).get(`%${feat.feature_key}%`) as { cnt: number };
          hits = results.cnt;
        }

        const gapStatus = hits === 0 ? 'GAP' : hits < 3 ? 'THIN' : 'COVERED';
        if (gapStatus === 'GAP') gapCount++;
        else coveredCount++;

        lines.push(`| ${feat.feature_key} | ${feat.domain} | ${hits} | ${gapStatus} |`);
      }

      lines.push('');
      lines.push(`**Summary**: ${coveredCount} covered, ${gapCount} gaps out of ${features.length} features`);
    } catch (error) {
      lines.push(`Error querying sentinel: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      dataDb?.close();
    }
  } else if (checkType === 'routers') {
    // List router files and check knowledge coverage
    try {
      const routersDir = getResolvedPaths().routersDir;
      const routerFiles = readdirSync(routersDir)
        .filter(f => f.endsWith('.ts') && !f.startsWith('_'));

      lines.push(`| Router | Knowledge Hits | Status |`);
      lines.push(`|--------|----------------|--------|`);

      for (const file of routerFiles) {
        const routerName = file.replace('.ts', '');
        const results = db.prepare(
          `SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE content LIKE ?`
        ).get(`%${routerName}%`) as { cnt: number };

        const routerStatus = results.cnt === 0 ? 'GAP' : results.cnt < 3 ? 'THIN' : 'COVERED';
        lines.push(`| ${routerName} | ${results.cnt} | ${routerStatus} |`);
      }
    } catch (error) {
      lines.push(`Error scanning routers: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (checkType === 'patterns') {
    // Check if domains have pattern documentation
    const patternDocs = db.prepare(
      "SELECT file_path, title FROM knowledge_documents WHERE category = 'patterns'"
    ).all() as { file_path: string; title: string }[];

    const documentedDomains = new Set(patternDocs.map(d => d.title.replace('-patterns', '').replace(' Patterns', '').toLowerCase()));

    lines.push('### Pattern Coverage');
    lines.push(`Documented domains: ${[...documentedDomains].join(', ')}`);
    lines.push('');

    // Check sentinel domains against pattern docs
    let dataDb: Database.Database | null = null;
    try {
      dataDb = getDataDb();

      const domains = dataDb.prepare(
        "SELECT DISTINCT domain FROM massu_sentinel WHERE status = 'active' ORDER BY domain"
      ).all() as { domain: string }[];

      for (const d of domains) {
        const hasPattern = documentedDomains.has(d.domain.toLowerCase());
        lines.push(`- **${d.domain}**: ${hasPattern ? 'COVERED' : 'GAP'}`);
      }
    } catch { /* sentinel not available */ }
    finally { dataDb?.close(); }
  } else if (checkType === 'incidents') {
    // Find domains with incidents but no prevention patterns
    const incidents = db.prepare(
      "SELECT type, COUNT(*) as cnt FROM knowledge_incidents GROUP BY type ORDER BY cnt DESC"
    ).all() as { type: string; cnt: number }[];

    lines.push('### Incident-to-Pattern Coverage');
    lines.push(`| Incident Type | Count | Pattern Coverage |`);
    lines.push(`|---------------|-------|-----------------|`);

    for (const inc of incidents) {
      const patternHits = db.prepare(
        "SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE content LIKE ? AND document_id IN (SELECT id FROM knowledge_documents WHERE category = 'patterns')"
      ).get(`%${inc.type}%`) as { cnt: number };

      const incStatus = patternHits.cnt === 0 ? 'GAP' : 'COVERED';
      lines.push(`| ${inc.type} | ${inc.cnt} | ${incStatus} (${patternHits.cnt} hits) |`);
    }
  }

  return text(lines.join('\n'));
}

// ============================================================
// P2-012: knowledge_effectiveness
// ============================================================

function handleEffectiveness(db: Database.Database, args: Record<string, unknown>): ToolResult {
  const ruleId = args.rule_id as string | undefined;
  const topN = Math.min((args.top_n as number) || 10, 50);
  const mode = (args.mode as string) || 'most_violated';

  const lines: string[] = [];

  // Get all CR rules from knowledge DB
  const allRules = db.prepare('SELECT rule_id, rule_text FROM knowledge_rules ORDER BY rule_id').all() as {
    rule_id: string; rule_text: string;
  }[];

  // Try to get violation data from memory DB
  let memoryDb: InstanceType<typeof Database> | null = null;
  const violationCounts = new Map<string, number>();
  const lastViolated = new Map<string, string>();

  try {
    memoryDb = getMemoryDb();

    // Count observations that reference CR rules
    const observations = memoryDb.prepare(`
      SELECT cr_rule, COUNT(*) as cnt, MAX(created_at) as last_at
      FROM observations
      WHERE cr_rule IS NOT NULL AND cr_rule != ''
      GROUP BY cr_rule
    `).all() as { cr_rule: string; cnt: number; last_at: string }[];

    for (const obs of observations) {
      violationCounts.set(obs.cr_rule, obs.cnt);
      lastViolated.set(obs.cr_rule, obs.last_at);
    }
  } catch { /* Memory DB not available */ }
  finally { memoryDb?.close(); }

  if (ruleId || mode === 'detail') {
    const targetRule = ruleId || '';
    const rule = allRules.find(r => r.rule_id === targetRule);

    if (!rule) {
      return text(`Rule ${targetRule} not found.`);
    }

    lines.push(`## Rule Effectiveness: ${rule.rule_id}`);
    lines.push(`**Text**: ${rule.rule_text}`);
    lines.push('');

    const violations = violationCounts.get(rule.rule_id) || 0;
    const lastAt = lastViolated.get(rule.rule_id) || 'Never';

    // Count linked incidents
    const incidentEdges = db.prepare(
      "SELECT COUNT(*) as cnt FROM knowledge_edges WHERE target_type = 'cr' AND target_id = ? AND source_type = 'incident'"
    ).get(rule.rule_id) as { cnt: number };

    // Count correction links
    const correctionEdges = db.prepare(
      "SELECT COUNT(*) as cnt FROM knowledge_edges WHERE target_type = 'cr' AND target_id = ? AND source_type = 'correction'"
    ).get(rule.rule_id) as { cnt: number };

    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Violations Observed | ${violations} |`);
    lines.push(`| Last Violated | ${lastAt} |`);
    lines.push(`| Linked Incidents | ${incidentEdges.cnt} |`);
    lines.push(`| Linked Corrections | ${correctionEdges.cnt} |`);
    lines.push(`| Effectiveness Score | ${violations === 0 ? 'HIGH (never violated)' : violations < 3 ? 'MEDIUM' : 'LOW (frequently violated)'} |`);
  } else {
    // Ranking mode
    const rulesWithCounts = allRules.map(r => ({
      ...r,
      violations: violationCounts.get(r.rule_id) || 0,
      last_at: lastViolated.get(r.rule_id) || 'Never',
    }));

    if (mode === 'most_violated') {
      rulesWithCounts.sort((a, b) => b.violations - a.violations);
      lines.push(`## Most Violated Rules (Top ${topN})`);
    } else if (mode === 'least_violated') {
      rulesWithCounts.sort((a, b) => a.violations - b.violations);
      lines.push(`## Least Violated Rules (Top ${topN})`);
    } else if (mode === 'most_effective') {
      // Most effective = most violations observed (frequently caught and prevented)
      rulesWithCounts.sort((a, b) => b.violations - a.violations);
      lines.push(`## Most Effective Rules (Top ${topN})`);
      lines.push('*Rules that catch the most issues*');
    }

    lines.push('');
    lines.push(`| Rule | Text | Violations | Last Violated |`);
    lines.push(`|------|------|------------|---------------|`);

    for (const r of rulesWithCounts.slice(0, topN)) {
      const ruleText = r.rule_text.length > 40 ? r.rule_text.substring(0, 40) + '...' : r.rule_text;
      lines.push(`| ${r.rule_id} | ${ruleText} | ${r.violations} | ${r.last_at} |`);
    }
  }

  return text(lines.join('\n'));
}

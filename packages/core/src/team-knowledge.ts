// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';
import { p, text } from './tool-helpers.ts';
import { getConfig } from './config.ts';

// ============================================================
// Team Knowledge Graph
// ============================================================

/**
 * Calculate expertise score for a developer in a module.
 * Based on session depth (how many sessions) and observation quality.
 */
export function calculateExpertise(
  sessionCount: number,
  observationCount: number
): number {
  const config = getConfig();
  const sessionWeight = config.team?.expertise_weights?.session ?? 20;
  const observationWeight = config.team?.expertise_weights?.observation ?? 10;

  const sessionScore = Math.log2(sessionCount + 1) * sessionWeight;
  const obsScore = Math.log2(observationCount + 1) * observationWeight;
  return Math.min(100, Math.round(sessionScore + obsScore));
}

/**
 * Update developer expertise based on session observations.
 */
export function updateExpertise(
  db: Database.Database,
  developerId: string,
  sessionId: string
): void {
  const fileChanges = db.prepare(`
    SELECT DISTINCT files_involved FROM observations
    WHERE session_id = ? AND type IN ('file_change', 'feature', 'bugfix', 'refactor')
  `).all(sessionId) as Array<{ files_involved: string }>;

  const modules = new Set<string>();
  for (const fc of fileChanges) {
    try {
      const files = JSON.parse(fc.files_involved) as string[];
      for (const file of files) {
        const module = extractModule(file);
        if (module) modules.add(module);
      }
    } catch { /* skip */ }
  }

  for (const module of modules) {
    const existing = db.prepare(
      'SELECT session_count, observation_count FROM developer_expertise WHERE developer_id = ? AND module = ?'
    ).get(developerId, module) as { session_count: number; observation_count: number } | undefined;

    const sessionCount = (existing?.session_count ?? 0) + 1;
    const obsCount = (existing?.observation_count ?? 0) + fileChanges.length;
    const score = calculateExpertise(sessionCount, obsCount);

    db.prepare(`
      INSERT INTO developer_expertise (developer_id, module, session_count, observation_count, expertise_score, last_active)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(developer_id, module) DO UPDATE SET
        session_count = ?,
        observation_count = ?,
        expertise_score = ?,
        last_active = datetime('now')
    `).run(
      developerId, module, sessionCount, obsCount, score,
      sessionCount, obsCount, score
    );
  }
}

/**
 * Detect potential conflicts between developers working on same files.
 */
export function detectConflicts(
  db: Database.Database,
  daysBack: number = 7
): Array<{
  filePath: string;
  developerA: string;
  developerB: string;
  conflictType: string;
}> {
  const conflicts = db.prepare(`
    SELECT so1.file_path,
           so1.developer_id as developer_a,
           so2.developer_id as developer_b,
           'concurrent_edit' as conflict_type
    FROM shared_observations so1
    JOIN shared_observations so2 ON so1.file_path = so2.file_path
    WHERE so1.developer_id != so2.developer_id
      AND so1.file_path IS NOT NULL
      AND so1.created_at >= datetime('now', ?)
      AND so2.created_at >= datetime('now', ?)
    GROUP BY so1.file_path, so1.developer_id, so2.developer_id
  `).all(`-${daysBack} days`, `-${daysBack} days`) as Array<{
    file_path: string;
    developer_a: string;
    developer_b: string;
    conflict_type: string;
  }>;

  return conflicts.map(c => ({
    filePath: c.file_path,
    developerA: c.developer_a,
    developerB: c.developer_b,
    conflictType: c.conflict_type,
  }));
}

/**
 * Share an observation for team visibility.
 */
export function shareObservation(
  db: Database.Database,
  developerId: string,
  project: string,
  observationType: string,
  summary: string,
  opts?: {
    originalId?: number;
    filePath?: string;
    module?: string;
    severity?: number;
  }
): number {
  const result = db.prepare(`
    INSERT INTO shared_observations
    (original_id, developer_id, project, observation_type, summary, file_path, module, severity, is_shared, shared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, datetime('now'))
  `).run(
    opts?.originalId ?? null,
    developerId, project, observationType, summary,
    opts?.filePath ?? null,
    opts?.module ?? null,
    opts?.severity ?? 3
  );
  return Number(result.lastInsertRowid);
}

/**
 * Extract business module from a file path.
 * Uses configurable module extraction patterns if provided.
 */
function extractModule(filePath: string): string | null {
  // Route-based modules
  const routerMatch = filePath.match(/routers\/([^/.]+)/);
  if (routerMatch) return routerMatch[1];

  // Page-based modules
  const pageMatch = filePath.match(/app\/\(([^)]+)\)/);
  if (pageMatch) return pageMatch[1];

  // Component-based
  const compMatch = filePath.match(/components\/([^/.]+)/);
  if (compMatch) return compMatch[1];

  return null;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getTeamToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('team_search'),
      description: 'Search team-shared observations. Find what other developers learned about a module or file.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          module: { type: 'string', description: 'Filter by business module' },
        },
        required: ['query'],
      },
    },
    {
      name: p('team_expertise'),
      description: 'Who knows what. Shows developers ranked by expertise for a module or file area.',
      inputSchema: {
        type: 'object',
        properties: {
          module: { type: 'string', description: 'Business module (e.g., orders, products, design)' },
          file_path: { type: 'string', description: 'File path to find experts for' },
        },
        required: [],
      },
    },
    {
      name: p('team_conflicts'),
      description: 'Detect concurrent work conflicts. Find areas where multiple developers are making changes.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Check specific file for conflicts' },
          days: { type: 'number', description: 'Days to look back (default: 7)' },
        },
        required: [],
      },
    },
  ];
}

const TEAM_BASE_NAMES = new Set(['team_search', 'team_expertise', 'team_conflicts']);

export function isTeamTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return TEAM_BASE_NAMES.has(baseName);
}

export function handleTeamToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'team_search':
        return handleTeamSearch(args, memoryDb);
      case 'team_expertise':
        return handleTeamExpertise(args, memoryDb);
      case 'team_conflicts':
        return handleTeamConflicts(args, memoryDb);
      default:
        return text(`Unknown team tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('team_search')} { query: "pattern" }, ${p('team_expertise')} { module: "tasks" }`);
  }
}

function handleTeamSearch(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const query = args.query as string;
  if (!query) return text(`Usage: ${p('team_search')} { query: "search term", module: "optional-module" } - Search team-shared observations.`);

  const module = args.module as string | undefined;

  let sql = `
    SELECT id, developer_id, observation_type, summary, file_path, module, severity, created_at
    FROM shared_observations
    WHERE is_shared = TRUE AND summary LIKE ?
  `;
  const params: (string | number)[] = [`%${query}%`];

  if (module) {
    sql += ' AND module = ?';
    params.push(module);
  }

  sql += ' ORDER BY created_at DESC LIMIT 20';

  const results = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  if (results.length === 0) {
    return text(`No shared observations found for "${query}". Team knowledge is populated when developers share observations across sessions. Try: ${p('team_expertise')} {} to see module expertise, or broaden your search term.`);
  }

  const lines = [
    `## Team Knowledge: "${query}" (${results.length} results)`,
    '',
    '| Developer | Type | Summary | Module | Date |',
    '|-----------|------|---------|--------|------|',
  ];

  for (const r of results) {
    lines.push(
      `| ${r.developer_id} | ${r.observation_type} | ${(r.summary as string).slice(0, 60)} | ${r.module ?? '-'} | ${(r.created_at as string).split('T')[0]} |`
    );
  }

  return text(lines.join('\n'));
}

function handleTeamExpertise(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const module = args.module as string | undefined;
  const filePath = args.file_path as string | undefined;

  let targetModule = module;
  if (!targetModule && filePath) {
    targetModule = extractModule(filePath) ?? undefined;
  }

  if (!targetModule) {
    const modules = db.prepare(`
      SELECT module, COUNT(DISTINCT developer_id) as developers, MAX(expertise_score) as top_score
      FROM developer_expertise
      GROUP BY module
      ORDER BY developers DESC
    `).all() as Array<Record<string, unknown>>;

    if (modules.length === 0) {
      return text(`No expertise data yet. Expertise is built automatically as developers work on modules across sessions. Try: ${p('team_search')} { query: "keyword" } to search shared observations instead.`);
    }

    const lines = [
      '## Team Expertise Overview',
      '',
      '| Module | Developers | Top Score |',
      '|--------|-----------|-----------|',
    ];

    for (const m of modules) {
      lines.push(`| ${m.module} | ${m.developers} | ${m.top_score} |`);
    }

    lines.push('');
    lines.push(`Use ${p('team_expertise')} { module: "module_name" } to see developers ranked by expertise.`);

    return text(lines.join('\n'));
  }

  const experts = db.prepare(`
    SELECT developer_id, expertise_score, session_count, observation_count, last_active
    FROM developer_expertise
    WHERE module = ?
    ORDER BY expertise_score DESC
  `).all(targetModule) as Array<Record<string, unknown>>;

  if (experts.length === 0) {
    return text(`No expertise data for module "${targetModule}". Expertise builds as developers work on files in this module across sessions. Try: ${p('team_expertise')} {} to see all modules with tracked expertise.`);
  }

  const lines = [
    `## Expertise: ${targetModule}`,
    '',
    '| Developer | Score | Sessions | Observations | Last Active |',
    '|-----------|-------|----------|--------------|-------------|',
  ];

  for (const e of experts) {
    lines.push(
      `| ${e.developer_id} | ${e.expertise_score} | ${e.session_count} | ${e.observation_count} | ${(e.last_active as string).split('T')[0]} |`
    );
  }

  return text(lines.join('\n'));
}

function handleTeamConflicts(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const days = (args.days as number) ?? 7;
  const filePath = args.file_path as string | undefined;

  if (filePath) {
    const conflicts = db.prepare(`
      SELECT developer_a, developer_b, conflict_type, detected_at, resolved
      FROM knowledge_conflicts
      WHERE file_path = ?
      ORDER BY detected_at DESC LIMIT 10
    `).all(filePath) as Array<Record<string, unknown>>;

    if (conflicts.length === 0) {
      return text(`No conflicts detected for "${filePath}". Conflicts are detected when multiple developers modify the same file within the lookback window. Try: ${p('team_conflicts')} { days: 30 } to check for conflicts across all files.`);
    }

    const lines = [
      `## Conflicts: ${filePath}`,
      '',
    ];

    for (const c of conflicts) {
      lines.push(`- ${c.developer_a} vs ${c.developer_b} (${c.conflict_type}) - ${c.resolved ? 'resolved' : 'ACTIVE'}`);
    }

    return text(lines.join('\n'));
  }

  // General conflict detection
  const conflicts = detectConflicts(db, days);

  if (conflicts.length === 0) {
    return text(`No concurrent work conflicts detected in the last ${days} days. Conflicts are tracked when multiple developers modify the same files. Try a longer time range: ${p('team_conflicts')} { days: 90 }.`);
  }

  const lines = [
    `## Work Conflicts (${days} days)`,
    `Detected: ${conflicts.length}`,
    '',
    '| File | Developer A | Developer B | Type |',
    '|------|-----------|-----------|------|',
  ];

  for (const c of conflicts) {
    lines.push(`| ${c.filePath} | ${c.developerA} | ${c.developerB} | ${c.conflictType} |`);
  }

  return text(lines.join('\n'));
}


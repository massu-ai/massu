// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';
import { classifyPythonFileDomain } from './python/domain-enforcer.ts';

/** Get the configured tool prefix */
function p(name: string): string {
  return `${getConfig().toolPrefix}_${name}`;
}

function stripPrefix(name: string): string {
  const pfx = getConfig().toolPrefix + '_';
  return name.startsWith(pfx) ? name.slice(pfx.length) : name;
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

/** Safely parse a JSON array from SQLite, returning [] on error */
function safeParseArray(json: string): unknown[] {
  try { return JSON.parse(json); } catch { return []; }
}

/**
 * Python tool definitions — only included when python.root is configured.
 */
export function getPythonToolDefinitions(): ToolDefinition[] {
  const config = getConfig();
  if (!config.python?.root) return [];

  return [
    {
      name: p('py_imports'),
      description: 'Query the Python import graph. Show imports for a file, reverse lookup (who imports this), or transitive dependencies.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Python file path (relative to project root) to show imports for' },
          imported_by: { type: 'string', description: 'Python file path to find reverse imports (who imports this file)' },
          transitive: { type: 'boolean', description: 'If true, traverse import graph transitively' },
          depth: { type: 'number', description: 'Max depth for transitive traversal (default: 5)' },
        },
        required: [],
      },
    },
    {
      name: p('py_routes'),
      description: 'List and filter FastAPI/Flask routes. Find routes by method, path, file. Show unauthenticated routes or routes with no frontend callers.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'Filter by HTTP method (GET, POST, etc.)' },
          path: { type: 'string', description: 'Filter by route path pattern' },
          file: { type: 'string', description: 'Filter by source file' },
          unauthenticated: { type: 'boolean', description: 'Show only unauthenticated routes' },
          uncoupled: { type: 'boolean', description: 'Show only routes with no frontend callers' },
          limit: { type: 'number', description: 'Max results to return (default: 500)' },
        },
        required: [],
      },
    },
    {
      name: p('py_coupling'),
      description: 'Show frontend-to-backend coupling map. Find which frontend files call which backend routes.',
      inputSchema: {
        type: 'object',
        properties: {
          frontend_file: { type: 'string', description: 'Filter by frontend file' },
          backend_path: { type: 'string', description: 'Filter by backend route path' },
        },
        required: [],
      },
    },
    {
      name: p('py_models'),
      description: 'SQLAlchemy model catalog. View models, FK graph, column details, or verify column references in a file.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model class name to inspect' },
          table: { type: 'string', description: 'Table name to inspect' },
          fk_graph: { type: 'boolean', description: 'Show foreign key relationship graph' },
          verify_file: { type: 'string', description: 'File path to verify column references against models' },
          limit: { type: 'number', description: 'Max results to return (default: 500)' },
        },
        required: [],
      },
    },
    {
      name: p('py_migrations'),
      description: 'Alembic migration information. View migration chain, specific revision details, or detect drift between models and migrations.',
      inputSchema: {
        type: 'object',
        properties: {
          revision: { type: 'string', description: 'Specific revision ID to inspect' },
          chain: { type: 'boolean', description: 'Show full migration chain' },
          drift: { type: 'boolean', description: 'Detect drift between models and migration state' },
          limit: { type: 'number', description: 'Max results to return (default: 500)' },
        },
        required: [],
      },
    },
    {
      name: p('py_domains'),
      description: 'Python domain boundary information. Classify files, show cross-domain imports, or list files in a domain.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File to classify into a domain' },
          crossings: { type: 'boolean', description: 'Show all cross-domain import violations' },
          domain: { type: 'string', description: 'Domain name to list files for' },
        },
        required: [],
      },
    },
    {
      name: p('py_impact'),
      description: 'Full impact analysis for a Python file: affected endpoints, models, frontend pages, and domain crossings.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Python file path to analyze impact for' },
        },
        required: ['file'],
      },
    },
    {
      name: p('py_context'),
      description: 'Complete context for a Python file: applicable rules, imports, domain, routes, models, and impact.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Python file path to get context for' },
        },
        required: ['file'],
      },
    },
  ];
}

/** Check if a tool name is a Python tool */
export function isPythonTool(name: string): boolean {
  const base = stripPrefix(name);
  return base.startsWith('py_');
}

/** Handle Python tool calls */
export function handlePythonToolCall(
  name: string,
  args: Record<string, unknown>,
  dataDb: Database.Database
): ToolResult {
  const baseName = stripPrefix(name);

  switch (baseName) {
    case 'py_imports':
      return handlePyImports(args, dataDb);
    case 'py_routes':
      return handlePyRoutes(args, dataDb);
    case 'py_coupling':
      return handlePyCoupling(args, dataDb);
    case 'py_models':
      return handlePyModels(args, dataDb);
    case 'py_migrations':
      return handlePyMigrations(args, dataDb);
    case 'py_domains':
      return handlePyDomains(args, dataDb);
    case 'py_impact':
      return handlePyImpact(args, dataDb);
    case 'py_context':
      return handlePyContext(args, dataDb);
    default:
      return text(`Unknown Python tool: ${name}`);
  }
}

// === Tool Handlers ===

function handlePyImports(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];
  const file = args.file as string | undefined;
  const importedBy = args.imported_by as string | undefined;
  const transitive = args.transitive as boolean | undefined;
  const maxDepth = Math.min(Math.max((args.depth as number) || 5, 1), 20);

  if (file) {
    if (transitive) {
      lines.push(`## Transitive imports from ${file} (max depth: ${maxDepth})`);
      const visited = new Set<string>();
      function traverse(f: string, depth: number): void {
        if (depth > maxDepth || visited.has(f)) return;
        visited.add(f);
        const imports = dataDb.prepare(
          'SELECT target_file, imported_names FROM massu_py_imports WHERE source_file = ?'
        ).all(f) as { target_file: string; imported_names: string }[];
        for (const imp of imports) {
          const indent = '  '.repeat(depth);
          const names = safeParseArray(imp.imported_names) as string[];
          lines.push(`${indent}- ${imp.target_file}${names.length > 0 ? ': ' + names.join(', ') : ''}`);
          traverse(imp.target_file, depth + 1);
        }
      }
      traverse(file, 0);
    } else {
      const imports = dataDb.prepare(
        'SELECT target_file, import_type, imported_names, line FROM massu_py_imports WHERE source_file = ? ORDER BY line'
      ).all(file) as { target_file: string; import_type: string; imported_names: string; line: number }[];
      lines.push(`## Imports from ${file} (${imports.length} edges)`);
      for (const imp of imports) {
        const names = safeParseArray(imp.imported_names) as string[];
        lines.push(`- L${imp.line} [${imp.import_type}] ${imp.target_file}${names.length > 0 ? ': ' + names.join(', ') : ''}`);
      }
    }
  } else if (importedBy) {
    const importers = dataDb.prepare(
      'SELECT source_file, imported_names, line FROM massu_py_imports WHERE target_file = ? ORDER BY source_file'
    ).all(importedBy) as { source_file: string; imported_names: string; line: number }[];
    lines.push(`## Files importing ${importedBy} (${importers.length} edges)`);
    for (const imp of importers) {
      const names = safeParseArray(imp.imported_names) as string[];
      lines.push(`- ${imp.source_file}:${imp.line}${names.length > 0 ? ' (' + names.join(', ') + ')' : ''}`);
    }
  } else {
    const total = (dataDb.prepare('SELECT COUNT(*) as cnt FROM massu_py_imports').get() as { cnt: number }).cnt;
    const files = (dataDb.prepare('SELECT COUNT(DISTINCT source_file) as cnt FROM massu_py_imports').get() as { cnt: number }).cnt;
    lines.push('## Python Import Index Summary');
    lines.push(`- Total import edges: ${total}`);
    lines.push(`- Files with imports: ${files}`);
    lines.push('');
    lines.push('Use { file: "path" } to see imports for a specific file.');
    lines.push('Use { imported_by: "path" } for reverse lookup.');
  }

  return text(lines.join('\n') || 'No Python import data available. Run sync first.');
}

function handlePyRoutes(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];
  const limit = Math.min(Math.max((args.limit as number) || 500, 1), 5000);
  let query = 'SELECT * FROM massu_py_routes WHERE 1=1';
  const params: unknown[] = [];

  if (args.method) { query += ' AND method = ?'; params.push((args.method as string).toUpperCase()); }
  if (args.path) { query += ' AND path LIKE ?'; params.push(`%${args.path as string}%`); }
  if (args.file) { query += ' AND file = ?'; params.push(args.file); }
  if (args.unauthenticated) { query += ' AND is_authenticated = 0'; }

  query += ` ORDER BY file, line LIMIT ${limit}`;

  const routes = dataDb.prepare(query).all(...params) as {
    id: number; file: string; method: string; path: string; function_name: string;
    dependencies: string; request_model: string | null; response_model: string | null;
    is_authenticated: number; line: number;
  }[];

  if (args.uncoupled) {
    const callerCountStmt = dataDb.prepare('SELECT COUNT(*) as cnt FROM massu_py_route_callers WHERE route_id = ?');
    const uncoupledRoutes = routes.filter(r => {
      const callers = (callerCountStmt.get(r.id) as { cnt: number }).cnt;
      return callers === 0;
    });
    lines.push(`## Uncoupled Routes (${uncoupledRoutes.length} with no frontend callers)`);
    for (const r of uncoupledRoutes) {
      lines.push(`- ${r.method} ${r.path} → ${r.function_name} (${r.file}:${r.line})`);
    }
  } else {
    lines.push(`## Python Routes (${routes.length} found)`);
    for (const r of routes) {
      const auth = r.is_authenticated ? '' : ' [UNAUTH]';
      const deps = safeParseArray(r.dependencies) as string[];
      lines.push(`- ${r.method} ${r.path} → ${r.function_name} (${r.file}:${r.line})${auth}`);
      if (r.response_model) lines.push(`  Response: ${r.response_model}`);
      if (deps.length > 0) lines.push(`  Depends: ${deps.join(', ')}`);
    }
  }

  return text(lines.join('\n') || 'No Python routes found.');
}

function handlePyCoupling(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];
  let query = `
    SELECT rc.frontend_file, rc.call_pattern, rc.line as caller_line,
           r.method, r.path, r.function_name, r.file as backend_file
    FROM massu_py_route_callers rc
    JOIN massu_py_routes r ON rc.route_id = r.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (args.frontend_file) { query += ' AND rc.frontend_file = ?'; params.push(args.frontend_file); }
  if (args.backend_path) { query += ' AND r.path LIKE ?'; params.push(`%${args.backend_path as string}%`); }

  query += ' ORDER BY rc.frontend_file, rc.line';

  const couplings = dataDb.prepare(query).all(...params) as {
    frontend_file: string; call_pattern: string; caller_line: number;
    method: string; path: string; function_name: string; backend_file: string;
  }[];

  lines.push(`## Frontend ↔ Backend Coupling (${couplings.length} connections)`);
  let currentFrontend = '';
  for (const c of couplings) {
    if (c.frontend_file !== currentFrontend) {
      currentFrontend = c.frontend_file;
      lines.push(`\n### ${currentFrontend}`);
    }
    lines.push(`- L${c.caller_line}: ${c.call_pattern} → ${c.method} ${c.path} (${c.backend_file})`);
  }

  return text(lines.join('\n') || 'No coupling data found.');
}

function handlePyModels(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];

  if (args.fk_graph) {
    const edges = dataDb.prepare('SELECT * FROM massu_py_fk_edges ORDER BY source_table').all() as {
      source_table: string; source_column: string; target_table: string; target_column: string;
    }[];
    lines.push(`## Foreign Key Graph (${edges.length} edges)`);
    for (const e of edges) {
      lines.push(`- ${e.source_table}.${e.source_column} → ${e.target_table}.${e.target_column}`);
    }
  } else if (args.model || args.table) {
    const search = (args.model || args.table) as string;
    const model = dataDb.prepare(
      'SELECT * FROM massu_py_models WHERE class_name = ? OR table_name = ?'
    ).get(search, search) as {
      class_name: string; table_name: string; file: string; line: number;
      columns: string; relationships: string; foreign_keys: string;
    } | undefined;

    if (!model) return text(`Model "${search}" not found.`);

    lines.push(`## ${model.class_name} (table: ${model.table_name || 'N/A'})`);
    lines.push(`File: ${model.file}:${model.line}`);

    const cols = safeParseArray(model.columns) as { name: string; type: string; nullable?: boolean; primary_key?: boolean }[];
    if (cols.length > 0) {
      lines.push('\n### Columns');
      for (const col of cols) {
        lines.push(`- ${col.name}: ${col.type}${col.nullable ? '?' : ''}${col.primary_key ? ' [PK]' : ''}`);
      }
    }

    const rels = safeParseArray(model.relationships) as { name: string; target: string; back_populates?: string }[];
    if (rels.length > 0) {
      lines.push('\n### Relationships');
      for (const rel of rels) {
        lines.push(`- ${rel.name} → ${rel.target}${rel.back_populates ? ` (back_populates: ${rel.back_populates})` : ''}`);
      }
    }

    const fks = safeParseArray(model.foreign_keys) as { column: string; target: string }[];
    if (fks.length > 0) {
      lines.push('\n### Foreign Keys');
      for (const fk of fks) {
        lines.push(`- ${fk.column} → ${fk.target}`);
      }
    }
  } else {
    const limit = Math.min(Math.max((args.limit as number) || 500, 1), 5000);
    const models = dataDb.prepare(`SELECT class_name, table_name, file, line FROM massu_py_models ORDER BY class_name LIMIT ${limit}`).all() as {
      class_name: string; table_name: string; file: string; line: number;
    }[];
    lines.push(`## Python Models (${models.length})`);
    for (const m of models) {
      lines.push(`- ${m.class_name} (${m.table_name || 'no table'}) — ${m.file}:${m.line}`);
    }
  }

  return text(lines.join('\n') || 'No Python models found.');
}

function handlePyMigrations(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];

  if (args.drift) {
    // Compare models against migration operations
    const models = dataDb.prepare('SELECT class_name, table_name, columns FROM massu_py_models').all() as {
      class_name: string; table_name: string; columns: string;
    }[];
    const migrations = dataDb.prepare('SELECT revision, operations FROM massu_py_migrations').all() as {
      revision: string; operations: string;
    }[];

    const migratedTables = new Set<string>();
    for (const m of migrations) {
      const ops = safeParseArray(m.operations) as { type: string; table?: string; column?: string }[];
      for (const op of ops) {
        if (op.table) migratedTables.add(op.table);
      }
    }

    lines.push('## Migration Drift Report');
    const unmigrated = models.filter(m => m.table_name && !migratedTables.has(m.table_name));
    if (unmigrated.length > 0) {
      lines.push(`\n### Models with no migration (${unmigrated.length})`);
      for (const m of unmigrated) {
        lines.push(`- ${m.class_name} (table: ${m.table_name})`);
      }
    } else {
      lines.push('All models have corresponding migrations.');
    }
  } else if (args.chain) {
    const limit = Math.min(Math.max((args.limit as number) || 500, 1), 5000);
    const migrations = dataDb.prepare(`SELECT * FROM massu_py_migrations ORDER BY id LIMIT ${limit}`).all() as {
      revision: string; down_revision: string | null; file: string; description: string | null; is_head: number;
    }[];
    lines.push(`## Migration Chain (${migrations.length} revisions)`);
    for (const m of migrations) {
      const head = m.is_head ? ' [HEAD]' : '';
      lines.push(`- ${m.revision}${head} ← ${m.down_revision || 'BASE'}: ${m.description || '(no description)'} (${m.file})`);
    }
  } else if (args.revision) {
    const m = dataDb.prepare('SELECT * FROM massu_py_migrations WHERE revision = ?').get(args.revision) as {
      revision: string; down_revision: string | null; file: string; description: string | null;
      operations: string; is_head: number;
    } | undefined;
    if (!m) return text(`Revision "${args.revision}" not found.`);
    lines.push(`## Revision: ${m.revision}`);
    lines.push(`Down: ${m.down_revision || 'BASE'}`);
    lines.push(`File: ${m.file}`);
    lines.push(`Description: ${m.description || 'N/A'}`);
    const ops = safeParseArray(m.operations) as { type: string; table?: string; column?: string }[];
    if (ops.length > 0) {
      lines.push('\n### Operations');
      for (const op of ops) {
        lines.push(`- ${op.type}: ${op.table || op.column || ''}`);
      }
    }
  } else {
    const total = (dataDb.prepare('SELECT COUNT(*) as cnt FROM massu_py_migrations').get() as { cnt: number }).cnt;
    const head = dataDb.prepare('SELECT revision FROM massu_py_migrations WHERE is_head = 1').get() as { revision: string } | undefined;
    lines.push('## Migration Summary');
    lines.push(`- Total revisions: ${total}`);
    lines.push(`- Current head: ${head?.revision || 'N/A'}`);
  }

  return text(lines.join('\n') || 'No Python migration data found.');
}

function handlePyDomains(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];
  const config = getConfig();
  const domains = config.python?.domains || [];

  if (args.file) {
    const file = args.file as string;
    const domain = classifyPythonFileDomain(file);
    lines.push(`## ${file}`);
    lines.push(`Domain: ${domain}`);
    const domainConfig = domains.find(d => d.name === domain);
    if (domainConfig) {
      lines.push(`Allowed imports from: ${domainConfig.allowed_imports_from.join(', ') || 'any'}`);
    }
  } else if (args.crossings) {
    const imports = dataDb.prepare('SELECT source_file, target_file FROM massu_py_imports').all() as {
      source_file: string; target_file: string;
    }[];
    const violations: string[] = [];
    for (const imp of imports) {
      const srcDomain = classifyPythonFileDomain(imp.source_file);
      const tgtDomain = classifyPythonFileDomain(imp.target_file);
      if (srcDomain !== tgtDomain && srcDomain !== 'Unknown' && tgtDomain !== 'Unknown') {
        const srcConfig = domains.find(d => d.name === srcDomain);
        if (srcConfig && !srcConfig.allowed_imports_from.includes(tgtDomain)) {
          violations.push(`${imp.source_file} (${srcDomain}) → ${imp.target_file} (${tgtDomain})`);
        }
      }
    }
    lines.push(`## Cross-Domain Violations (${violations.length})`);
    for (const v of violations.slice(0, 50)) {
      lines.push(`- ${v}`);
    }
    if (violations.length > 50) lines.push(`... and ${violations.length - 50} more`);
  } else if (args.domain) {
    const domainName = args.domain as string;
    const allFiles = dataDb.prepare('SELECT DISTINCT source_file FROM massu_py_imports UNION SELECT DISTINCT target_file FROM massu_py_imports').all() as { source_file: string }[];
    const filesInDomain = allFiles.filter(f => classifyPythonFileDomain(f.source_file) === domainName);
    lines.push(`## Domain: ${domainName} (${filesInDomain.length} files)`);
    for (const f of filesInDomain) {
      lines.push(`- ${f.source_file}`);
    }
  } else {
    lines.push('## Python Domain Summary');
    for (const d of domains) {
      lines.push(`- **${d.name}**: packages ${d.packages.join(', ')}, imports from: ${d.allowed_imports_from.join(', ') || 'any'}`);
    }
  }

  return text(lines.join('\n') || 'No Python domains configured.');
}

function handlePyImpact(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const file = args.file as string;
  const lines: string[] = [`## Impact Analysis: ${file}`, ''];

  // 1. Who imports this file
  const importedBy = dataDb.prepare(
    'SELECT source_file FROM massu_py_imports WHERE target_file = ?'
  ).all(file) as { source_file: string }[];
  lines.push(`### Imported By (${importedBy.length} files)`);
  for (const imp of importedBy.slice(0, 20)) {
    lines.push(`- ${imp.source_file}`);
  }

  // 2. Routes in this file
  const routes = dataDb.prepare(
    'SELECT method, path, function_name FROM massu_py_routes WHERE file = ?'
  ).all(file) as { method: string; path: string; function_name: string }[];
  if (routes.length > 0) {
    lines.push(`\n### Routes Defined (${routes.length})`);
    for (const r of routes) {
      lines.push(`- ${r.method} ${r.path} → ${r.function_name}`);
    }
  }

  // 3. Models in this file
  const models = dataDb.prepare(
    'SELECT class_name, table_name FROM massu_py_models WHERE file = ?'
  ).all(file) as { class_name: string; table_name: string }[];
  if (models.length > 0) {
    lines.push(`\n### Models Defined (${models.length})`);
    for (const m of models) {
      lines.push(`- ${m.class_name} (${m.table_name || 'no table'})`);
    }
  }

  // 4. Frontend callers (via routes)
  const routeIds = dataDb.prepare('SELECT id FROM massu_py_routes WHERE file = ?').all(file) as { id: number }[];
  if (routeIds.length > 0) {
    const placeholders = routeIds.map(() => '?').join(',');
    const callers = dataDb.prepare(
      `SELECT DISTINCT frontend_file FROM massu_py_route_callers WHERE route_id IN (${placeholders})`
    ).all(...routeIds.map(r => r.id)) as { frontend_file: string }[];
    if (callers.length > 0) {
      lines.push(`\n### Frontend Callers (${callers.length} files)`);
      for (const c of callers) {
        lines.push(`- ${c.frontend_file}`);
      }
    }
  }

  // 5. Domain
  const config = getConfig();
  const domain = classifyPythonFileDomain(file);
  lines.push(`\n### Domain: ${domain}`);

  return text(lines.join('\n'));
}

function handlePyContext(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const file = args.file as string;
  const lines: string[] = [`## Python Context: ${file}`, ''];
  const config = getConfig();

  // Domain
  const domain = classifyPythonFileDomain(file);
  lines.push(`**Domain**: ${domain}`);

  // Imports
  const imports = dataDb.prepare(
    'SELECT target_file, imported_names FROM massu_py_imports WHERE source_file = ? LIMIT 20'
  ).all(file) as { target_file: string; imported_names: string }[];
  if (imports.length > 0) {
    lines.push('\n### Imports');
    for (const imp of imports) {
      const names = safeParseArray(imp.imported_names) as string[];
      lines.push(`- ${imp.target_file}${names.length > 0 ? ': ' + names.join(', ') : ''}`);
    }
  }

  // Imported by
  const importedBy = dataDb.prepare(
    'SELECT source_file FROM massu_py_imports WHERE target_file = ? LIMIT 10'
  ).all(file) as { source_file: string }[];
  if (importedBy.length > 0) {
    lines.push('\n### Imported By');
    for (const imp of importedBy) {
      lines.push(`- ${imp.source_file}`);
    }
  }

  // Routes
  const routes = dataDb.prepare('SELECT method, path, function_name, line FROM massu_py_routes WHERE file = ?')
    .all(file) as { method: string; path: string; function_name: string; line: number }[];
  if (routes.length > 0) {
    lines.push('\n### Routes');
    for (const r of routes) {
      lines.push(`- ${r.method} ${r.path} → ${r.function_name} (L${r.line})`);
    }
  }

  // Models
  const models = dataDb.prepare('SELECT class_name, table_name, line FROM massu_py_models WHERE file = ?')
    .all(file) as { class_name: string; table_name: string; line: number }[];
  if (models.length > 0) {
    lines.push('\n### Models');
    for (const m of models) {
      lines.push(`- ${m.class_name} (${m.table_name || 'N/A'}) L${m.line}`);
    }
  }

  // Applicable rules from config
  const rules = config.rules || [];
  const matchingRules = rules.filter(r => {
    const pattern = r.pattern;
    if (pattern === '**') return true;
    if (pattern.includes('**/*.py')) return file.endsWith('.py');
    return file.includes(pattern.replace(/\*\*/g, ''));
  });
  if (matchingRules.length > 0) {
    lines.push('\n### Applicable Rules');
    for (const rule of matchingRules) {
      for (const r of rule.rules) {
        lines.push(`- ${r}`);
      }
    }
  }

  return text(lines.join('\n'));
}


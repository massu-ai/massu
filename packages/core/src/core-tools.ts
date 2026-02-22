// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import { matchRules } from './rules.ts';
import { buildImportIndex } from './import-resolver.ts';
import { buildTrpcIndex } from './trpc-index.ts';
import { buildPageDeps, findAffectedPages } from './page-deps.ts';
import { buildMiddlewareTree, isInMiddlewareTree } from './middleware-tree.ts';
import { classifyFile, findCrossDomainImports, getFilesInDomain } from './domains.ts';
import { parsePrismaSchema, detectMismatches, findColumnUsageInRouters } from './schema-mapper.ts';
import { isDataStale, updateBuildTimestamp } from './db.ts';
import { runFeatureScan } from './sentinel-scanner.ts';
import { ensureWithinRoot } from './security-utils.ts';
import { getConfig, getProjectRoot } from './config.ts';
import { p, stripPrefix, text } from './tool-helpers.ts';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';

// ============================================================
// Core Tools: sync, context, trpc_map, coupling_check, impact, domains, schema
// ============================================================

const CORE_BASE_NAMES = new Set([
  'sync', 'context', 'trpc_map', 'coupling_check', 'impact', 'domains', 'schema',
]);

export function isCoreTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return CORE_BASE_NAMES.has(baseName);
}

/**
 * Ensure indexes are built and up-to-date.
 * Lazy initialization: only rebuilds if stale.
 */
export function ensureIndexes(dataDb: Database.Database, codegraphDb: Database.Database, force: boolean = false): string {
  if (!force && !isDataStale(dataDb, codegraphDb)) {
    return 'Indexes are up-to-date.';
  }

  const results: string[] = [];

  const importCount = buildImportIndex(dataDb, codegraphDb);
  results.push(`Import edges: ${importCount}`);

  const config = getConfig();

  if (config.framework.router === 'trpc') {
    const trpcStats = buildTrpcIndex(dataDb);
    results.push(`tRPC procedures: ${trpcStats.totalProcedures} (${trpcStats.withCallers} with UI, ${trpcStats.withoutCallers} without)`);
  }

  const pageCount = buildPageDeps(dataDb, codegraphDb);
  results.push(`Page deps: ${pageCount} pages`);

  if (config.paths.middleware) {
    const middlewareCount = buildMiddlewareTree(dataDb);
    results.push(`Middleware tree: ${middlewareCount} files`);
  }

  updateBuildTimestamp(dataDb);
  return `Indexes rebuilt:\n${results.join('\n')}`;
}

export function getCoreToolDefinitions(): ToolDefinition[] {
  const config = getConfig();

  return [
    {
      name: p('sync'),
      description: 'Force rebuild all indexes (import edges, tRPC mappings, page deps, middleware tree). Run this after significant code changes.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: p('context'),
      description: 'Get context for a file: applicable rules, pattern warnings, schema mismatch alerts, and whether the file is in the middleware import tree.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path relative to project root' },
        },
        required: ['file'],
      },
    },
    ...(config.framework.router === 'trpc' ? [
      {
        name: p('trpc_map'),
        description: 'Map tRPC procedures to their UI call sites. Find which components call a router, which procedures have no UI callers, or list all procedures for a router.',
        inputSchema: {
          type: 'object',
          properties: {
            router: { type: 'string', description: 'Router name (e.g., "orders")' },
            procedure: { type: 'string', description: 'Procedure name to search across all routers' },
            uncoupled: { type: 'boolean', description: 'If true, show only procedures with ZERO UI callers' },
          },
          required: [],
        },
      },
      {
        name: p('coupling_check'),
        description: 'Automated coupling check. Finds all procedures with zero UI callers and components not rendered in any page.',
        inputSchema: {
          type: 'object',
          properties: {
            staged_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: only check these specific files',
            },
          },
          required: [],
        },
      },
    ] : []),
    {
      name: p('impact'),
      description: 'Full impact analysis for a file: which pages are affected, which database tables are in the chain, middleware tree membership, domain crossings.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path relative to project root' },
        },
        required: ['file'],
      },
    },
    ...(config.domains.length > 0 ? [{
      name: p('domains'),
      description: 'Domain boundary information. Classify a file into its domain, show cross-domain imports, or list all files in a domain.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File to classify into a domain' },
          crossings: { type: 'boolean', description: 'Show all cross-domain imports (violations highlighted)' },
          domain: { type: 'string', description: 'Domain name to list all files for' },
        },
        required: [],
      },
    }] : []),
    ...(config.framework.orm === 'prisma' ? [{
      name: p('schema'),
      description: 'Prisma schema cross-reference. Show columns for a table, detect mismatches between code and schema, or verify column references in a file.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table/model name to inspect' },
          mismatches: { type: 'boolean', description: 'Show all detected column name mismatches' },
          verify: { type: 'string', description: 'File path to verify column references against schema' },
        },
        required: [],
      },
    }] : []),
  ];
}

export function handleCoreToolCall(
  name: string,
  args: Record<string, unknown>,
  dataDb: Database.Database,
  codegraphDb: Database.Database
): ToolResult {
  const baseName = stripPrefix(name);
  switch (baseName) {
    case 'sync':
      return handleSync(dataDb, codegraphDb);
    case 'context':
      return handleContext(args.file as string, dataDb, codegraphDb);
    case 'trpc_map':
      return handleTrpcMap(args, dataDb);
    case 'coupling_check':
      return handleCouplingCheck(args, dataDb, codegraphDb);
    case 'impact':
      return handleImpact(args.file as string, dataDb, codegraphDb);
    case 'domains':
      return handleDomains(args, dataDb, codegraphDb);
    case 'schema':
      return handleSchema(args);
    default:
      return text(`Unknown core tool: ${name}`);
  }
}

// === Tool Handlers ===

function handleSync(dataDb: Database.Database, codegraphDb: Database.Database): ToolResult {
  const result = ensureIndexes(dataDb, codegraphDb, true);

  // Run feature auto-discovery after index rebuild
  try {
    const scanResult = runFeatureScan(dataDb);
    return text(`${result}\n\nFeature scan: ${scanResult.registered} features registered (${scanResult.fromProcedures} from procedures, ${scanResult.fromPages} from pages, ${scanResult.fromComponents} from components)`);
  } catch (error) {
    return text(`${result}\n\nFeature scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleContext(file: string, dataDb: Database.Database, codegraphDb: Database.Database): ToolResult {
  const lines: string[] = [];

  // 1. CodeGraph context
  const nodes = codegraphDb.prepare(
    "SELECT name, kind, start_line, end_line FROM nodes WHERE file_path = ? ORDER BY start_line"
  ).all(file) as { name: string; kind: string; start_line: number; end_line: number }[];

  if (nodes.length > 0) {
    lines.push('## CodeGraph Nodes');
    for (const node of nodes.slice(0, 30)) {
      lines.push(`- ${node.kind}: ${node.name} (L${node.start_line}-${node.end_line})`);
    }
    if (nodes.length > 30) {
      lines.push(`... and ${nodes.length - 30} more`);
    }
    lines.push('');
  }

  // 2. Applicable rules
  const rules = matchRules(file);
  if (rules.length > 0) {
    lines.push('## Applicable Rules');
    for (const rule of rules) {
      const severity = rule.severity ? `[${rule.severity}]` : '';
      for (const r of rule.rules) {
        lines.push(`- ${severity} ${r}`);
      }
      if (rule.patternFile) {
        lines.push(`  See: .claude/${rule.patternFile}`);
      }
    }
    lines.push('');
  }

  // 3. Middleware tree check
  if (isInMiddlewareTree(dataDb, file)) {
    lines.push('## WARNING: Middleware Import Tree');
    lines.push('This file is imported (directly or transitively) by the middleware entry point.');
    lines.push('NO Node.js dependencies allowed (pino, winston, fs, crypto, path, child_process).');
    lines.push('');
  }

  // 4. Domain classification
  const domain = classifyFile(file);
  lines.push(`## Domain: ${domain}`);
  lines.push('');

  // 5. Import edges
  const imports = dataDb.prepare(
    'SELECT target_file, imported_names FROM massu_imports WHERE source_file = ? LIMIT 20'
  ).all(file) as { target_file: string; imported_names: string }[];

  if (imports.length > 0) {
    lines.push('## Imports (from this file)');
    for (const imp of imports) {
      const names = JSON.parse(imp.imported_names);
      lines.push(`- ${imp.target_file}${names.length > 0 ? ': ' + names.join(', ') : ''}`);
    }
    lines.push('');
  }

  // 6. Imported BY
  const importedBy = dataDb.prepare(
    'SELECT source_file FROM massu_imports WHERE target_file = ? LIMIT 20'
  ).all(file) as { source_file: string }[];

  if (importedBy.length > 0) {
    lines.push('## Imported By');
    for (const imp of importedBy) {
      lines.push(`- ${imp.source_file}`);
    }
    lines.push('');
  }

  return text(lines.join('\n') || 'No context available for this file.');
}

function handleTrpcMap(args: Record<string, unknown>, dataDb: Database.Database): ToolResult {
  const lines: string[] = [];

  if (args.uncoupled) {
    const uncoupled = dataDb.prepare(
      'SELECT router_name, procedure_name, procedure_type, router_file FROM massu_trpc_procedures WHERE has_ui_caller = 0 ORDER BY router_name, procedure_name'
    ).all() as { router_name: string; procedure_name: string; procedure_type: string; router_file: string }[];

    lines.push(`## Uncoupled Procedures (${uncoupled.length} total)`);
    lines.push('These procedures have ZERO UI callers.');
    lines.push('');

    let currentRouter = '';
    for (const proc of uncoupled) {
      if (proc.router_name !== currentRouter) {
        currentRouter = proc.router_name;
        lines.push(`### ${currentRouter} (${proc.router_file})`);
      }
      lines.push(`- ${proc.procedure_name} (${proc.procedure_type})`);
    }
  } else if (args.router) {
    const procs = dataDb.prepare(
      'SELECT id, procedure_name, procedure_type, has_ui_caller FROM massu_trpc_procedures WHERE router_name = ? ORDER BY procedure_name'
    ).all(args.router as string) as { id: number; procedure_name: string; procedure_type: string; has_ui_caller: number }[];

    lines.push(`## Router: ${args.router} (${procs.length} procedures)`);
    lines.push('');

    for (const proc of procs) {
      const status = proc.has_ui_caller ? '' : ' [NO UI CALLERS]';
      lines.push(`### ${args.router}.${proc.procedure_name} (${proc.procedure_type})${status}`);

      const callSites = dataDb.prepare(
        'SELECT file, line, call_pattern FROM massu_trpc_call_sites WHERE procedure_id = ?'
      ).all(proc.id) as { file: string; line: number; call_pattern: string }[];

      if (callSites.length > 0) {
        lines.push('UI Call Sites:');
        for (const site of callSites) {
          lines.push(`  - ${site.file}:${site.line} -> ${site.call_pattern}`);
        }
      } else {
        lines.push('UI Call Sites: NONE');
      }
      lines.push('');
    }
  } else if (args.procedure) {
    const procs = dataDb.prepare(
      'SELECT id, router_name, router_file, procedure_type, has_ui_caller FROM massu_trpc_procedures WHERE procedure_name = ? ORDER BY router_name'
    ).all(args.procedure as string) as { id: number; router_name: string; router_file: string; procedure_type: string; has_ui_caller: number }[];

    lines.push(`## Procedure "${args.procedure}" found in ${procs.length} routers`);
    lines.push('');

    for (const proc of procs) {
      lines.push(`### ${proc.router_name}.${args.procedure} (${proc.procedure_type})`);
      lines.push(`File: ${proc.router_file}`);

      const callSites = dataDb.prepare(
        'SELECT file, line, call_pattern FROM massu_trpc_call_sites WHERE procedure_id = ?'
      ).all(proc.id) as { file: string; line: number; call_pattern: string }[];

      if (callSites.length > 0) {
        lines.push('UI Call Sites:');
        for (const site of callSites) {
          lines.push(`  - ${site.file}:${site.line} -> ${site.call_pattern}`);
        }
      } else {
        lines.push('UI Call Sites: NONE');
      }
      lines.push('');
    }
  } else {
    const total = dataDb.prepare('SELECT COUNT(*) as count FROM massu_trpc_procedures').get() as { count: number };
    const coupled = dataDb.prepare('SELECT COUNT(*) as count FROM massu_trpc_procedures WHERE has_ui_caller = 1').get() as { count: number };
    const uncoupled = total.count - coupled.count;

    lines.push('## tRPC Procedure Summary');
    lines.push(`- Total procedures: ${total.count}`);
    lines.push(`- With UI callers: ${coupled.count}`);
    lines.push(`- Without UI callers: ${uncoupled}`);
    lines.push('');
    lines.push('Use { router: "name" } to see details for a specific router.');
    lines.push('Use { uncoupled: true } to see all procedures without UI callers.');
  }

  return text(lines.join('\n'));
}

function handleCouplingCheck(args: Record<string, unknown>, dataDb: Database.Database, codegraphDb: Database.Database): ToolResult {
  const lines: string[] = [];
  const stagedFiles = args.staged_files as string[] | undefined;

  let uncoupledProcs;
  if (stagedFiles) {
    uncoupledProcs = dataDb.prepare(
      `SELECT router_name, procedure_name, procedure_type, router_file FROM massu_trpc_procedures WHERE has_ui_caller = 0 AND router_file IN (${stagedFiles.map(() => '?').join(',')})`
    ).all(...stagedFiles) as { router_name: string; procedure_name: string; procedure_type: string; router_file: string }[];
  } else {
    uncoupledProcs = dataDb.prepare(
      'SELECT router_name, procedure_name, procedure_type, router_file FROM massu_trpc_procedures WHERE has_ui_caller = 0'
    ).all() as { router_name: string; procedure_name: string; procedure_type: string; router_file: string }[];
  }

  lines.push('## Coupling Check Results');
  lines.push('');

  if (uncoupledProcs.length > 0) {
    lines.push(`### Uncoupled Procedures: ${uncoupledProcs.length}`);
    for (const proc of uncoupledProcs) {
      lines.push(`- ${proc.router_name}.${proc.procedure_name} (${proc.procedure_type}) in ${proc.router_file}`);
    }
    lines.push('');
  } else {
    lines.push('### Uncoupled Procedures: 0 (PASS)');
    lines.push('');
  }

  const allPages = codegraphDb.prepare(
    "SELECT path FROM files WHERE path LIKE 'src/app/%/page.tsx' OR path = 'src/app/page.tsx'"
  ).all() as { path: string }[];

  const pageImports = new Set<string>();
  for (const page of allPages) {
    const imports = dataDb.prepare(
      'SELECT target_file FROM massu_imports WHERE source_file = ?'
    ).all(page.path) as { target_file: string }[];
    for (const imp of imports) {
      pageImports.add(imp.target_file);
    }
  }

  let componentFiles: { path: string }[];
  if (stagedFiles) {
    const placeholders = stagedFiles.map(() => '?').join(',');
    componentFiles = codegraphDb.prepare(
      `SELECT path FROM files WHERE path LIKE 'src/components/%' AND path IN (${placeholders})`
    ).all(...stagedFiles) as { path: string }[];
  } else {
    componentFiles = [];
  }

  const orphanComponents = componentFiles.filter(f => !pageImports.has(f.path));
  if (orphanComponents.length > 0) {
    lines.push(`### Orphan Components: ${orphanComponents.length}`);
    for (const comp of orphanComponents) {
      lines.push(`- ${comp.path} (not imported by any page.tsx)`);
    }
    lines.push('');
  }

  const totalIssues = uncoupledProcs.length + orphanComponents.length;
  lines.push(`### RESULT: ${totalIssues === 0 ? 'PASS' : `FAIL (${totalIssues} issues)`}`);

  return text(lines.join('\n'));
}

function handleImpact(file: string, dataDb: Database.Database, codegraphDb: Database.Database): ToolResult {
  const lines: string[] = [];

  lines.push(`## Impact Analysis: ${file}`);
  lines.push('');

  const affectedPages = findAffectedPages(dataDb, file);

  if (affectedPages.length > 0) {
    const portals = [...new Set(affectedPages.map(p => p.portal))];
    const allTables = [...new Set(affectedPages.flatMap(p => p.tables))];
    const allRouters = [...new Set(affectedPages.flatMap(p => p.routers))];

    lines.push(`### Pages Affected: ${affectedPages.length}`);
    for (const page of affectedPages) {
      lines.push(`- ${page.route} (${page.portal})`);
    }
    lines.push('');

    lines.push(`### Scopes Affected: ${portals.join(', ')}`);
    lines.push('');

    if (allRouters.length > 0) {
      lines.push(`### Routers Called (via hooks/components):`);
      for (const router of allRouters) {
        lines.push(`- ${router}`);
      }
      lines.push('');
    }

    if (allTables.length > 0) {
      lines.push(`### Database Tables:`);
      for (const table of allTables) {
        lines.push(`- ${table}`);
      }
      lines.push('');
    }
  } else {
    lines.push('No pages affected (file may not be in any page dependency chain).');
    lines.push('');
  }

  const inMiddleware = isInMiddlewareTree(dataDb, file);
  if (inMiddleware) {
    lines.push('### WARNING: In Middleware Import Tree');
    lines.push('Changes to this file affect Edge Runtime. No Node.js deps allowed.');
  } else {
    lines.push('### Middleware: NOT in middleware import tree (safe)');
  }
  lines.push('');

  const fileDomain = classifyFile(file);
  lines.push(`### Domain: ${fileDomain}`);

  const imports = dataDb.prepare(
    'SELECT target_file FROM massu_imports WHERE source_file = ?'
  ).all(file) as { target_file: string }[];

  const crossings: string[] = [];
  for (const imp of imports) {
    const targetDomain = classifyFile(imp.target_file);
    if (targetDomain !== fileDomain && targetDomain !== 'Unknown') {
      crossings.push(`${imp.target_file} (${targetDomain})`);
    }
  }

  if (crossings.length > 0) {
    lines.push(`### Domain Crossings: ${crossings.length}`);
    for (const crossing of crossings) {
      lines.push(`- -> ${crossing}`);
    }
  }

  return text(lines.join('\n'));
}

function handleDomains(args: Record<string, unknown>, dataDb: Database.Database, codegraphDb: Database.Database): ToolResult {
  const lines: string[] = [];
  const domains = getConfig().domains;

  if (args.file) {
    const file = args.file as string;
    const domain = classifyFile(file);
    lines.push(`## ${file}`);
    lines.push(`Domain: ${domain}`);

    const domainConfig = domains.find(d => d.name === domain);
    if (domainConfig) {
      lines.push(`Allowed imports from: ${domainConfig.allowedImportsFrom.join(', ') || 'any domain (system)'}`);
    }
  } else if (args.crossings) {
    const crossings = findCrossDomainImports(dataDb);
    const violations = crossings.filter(c => !c.allowed);
    const allowed = crossings.filter(c => c.allowed);

    lines.push(`## Cross-Domain Import Analysis`);
    lines.push(`Total crossings: ${crossings.length}`);
    lines.push(`Violations: ${violations.length}`);
    lines.push(`Allowed: ${allowed.length}`);
    lines.push('');

    if (violations.length > 0) {
      lines.push('### Violations (Disallowed Cross-Domain Imports)');
      for (const v of violations.slice(0, 50)) {
        lines.push(`- ${v.source} (${v.sourceDomain}) -> ${v.target} (${v.targetDomain})`);
      }
      if (violations.length > 50) {
        lines.push(`... and ${violations.length - 50} more`);
      }
    }
  } else if (args.domain) {
    const domainName = args.domain as string;
    const files = getFilesInDomain(dataDb, codegraphDb, domainName);
    const config = domains.find(d => d.name === domainName);

    lines.push(`## Domain: ${domainName}`);
    if (config) {
      lines.push(`Allowed imports from: ${config.allowedImportsFrom.join(', ') || 'any domain (system)'}`);
    }
    lines.push('');

    lines.push(`### Routers (${files.routers.length})`);
    for (const r of files.routers) lines.push(`- ${r}`);
    lines.push('');

    lines.push(`### Pages (${files.pages.length})`);
    for (const p of files.pages) lines.push(`- ${p}`);
    lines.push('');

    lines.push(`### Components (${files.components.length})`);
    for (const c of files.components.slice(0, 30)) lines.push(`- ${c}`);
    if (files.components.length > 30) lines.push(`... and ${files.components.length - 30} more`);
  } else {
    lines.push('## Domain Summary');
    for (const domain of domains) {
      lines.push(`- **${domain.name}**: ${domain.routers.length} router patterns, imports from: ${domain.allowedImportsFrom.join(', ') || 'any'}`);
    }
  }

  return text(lines.join('\n'));
}

function handleSchema(args: Record<string, unknown>): ToolResult {
  const lines: string[] = [];
  const models = parsePrismaSchema();

  if (args.mismatches) {
    const mismatches = detectMismatches(models);

    lines.push(`## Schema Mismatches Detected: ${mismatches.length}`);
    lines.push('');

    for (const m of mismatches) {
      lines.push(`### ${m.table}.${m.codeColumn} [${m.severity}]`);
      lines.push(`Code uses "${m.codeColumn}" but this column does NOT exist in the schema.`);
      lines.push(`Files affected:`);
      for (const f of m.files) {
        lines.push(`  - ${f}`);
      }
      lines.push('');
    }

    if (mismatches.length === 0) {
      lines.push('No known mismatches detected in code.');
    }
  } else if (args.table) {
    const tableName = args.table as string;
    const model = models.find(m => m.tableName === tableName || m.name === tableName);

    if (!model) {
      return text(`Model/table "${tableName}" not found in Prisma schema.`);
    }

    lines.push(`## ${model.name} (table: ${model.tableName})`);
    lines.push('');
    lines.push('### Fields');
    for (const field of model.fields) {
      const nullable = field.nullable ? '?' : '';
      const relation = field.isRelation ? ' [RELATION]' : '';
      lines.push(`- ${field.name}: ${field.type}${nullable}${relation}`);
    }
    lines.push('');

    const usage = findColumnUsageInRouters(model.tableName);
    if (usage.size > 0) {
      lines.push('### Column Usage in Routers');
      for (const [col, usages] of usage) {
        const validField = model.fields.find(f => f.name === col);
        const status = validField ? '' : ' [NOT IN SCHEMA]';
        lines.push(`- ${col}${status}: ${usages.length} references`);
      }
    }
  } else if (args.verify) {
    const file = args.verify as string;
    lines.push(`## Schema Verification: ${file}`);
    lines.push('Checking all column references against Prisma schema...');
    lines.push('');

    ensureWithinRoot(file, getProjectRoot());
    const absPath = resolve(getProjectRoot(), file);

    if (!existsSync(absPath)) {
      return text(`File not found: ${file}`);
    }

    const source = readFileSync(absPath, 'utf-8');

    // Use configurable db access pattern
    const config = getConfig();
    const dbPattern = config.dbAccessPattern ?? 'ctx.db.{table}';
    const regexStr = dbPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace('\\{table\\}', '(\\w+)');
    const tableRegex = new RegExp(regexStr + '\\.', 'g');
    const tableRefs = new Set<string>();
    let match;
    while ((match = tableRegex.exec(source)) !== null) {
      tableRefs.add(match[1]);
    }

    for (const table of tableRefs) {
      const model = models.find(m => m.tableName === table || m.name.toLowerCase() === table);
      if (!model) {
        lines.push(`### ${table}: MODEL NOT FOUND IN SCHEMA`);
        continue;
      }

      lines.push(`### ${table} (model: ${model.name})`);
      const fieldNames = new Set(model.fields.map(f => f.name));
      lines.push(`Schema has ${fieldNames.size} fields.`);
      lines.push('');
    }
  } else {
    lines.push(`## Prisma Schema Summary`);
    lines.push(`Models: ${models.length}`);
    lines.push('');

    const mismatches = detectMismatches(models);
    if (mismatches.length > 0) {
      lines.push(`### Active Mismatches: ${mismatches.length}`);
      for (const m of mismatches) {
        lines.push(`- ${m.table}.${m.codeColumn} [${m.severity}]`);
      }
    }
  }

  return text(lines.join('\n'));
}

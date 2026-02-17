// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import {
  searchFeatures,
  getFeatureDetail,
  getFeatureImpact,
  validateFeatures,
  upsertFeature,
  linkComponent,
  linkProcedure,
  linkPage,
  logChange,
  checkParity,
} from './sentinel-db.ts';
import type { ComponentRole, FeatureStatus, FeaturePriority } from './sentinel-types.ts';
import { getConfig } from './config.ts';

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

// ============================================================
// Sentinel: MCP Tool Definitions & Handlers
// ============================================================

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}

export function getSentinelToolDefinitions(): ToolDefinition[] {
  return [
    // P2-001: sentinel_search
    {
      name: p('sentinel_search'),
      description: 'Search and list features in the Sentinel feature registry. Supports FTS5 full-text search and domain/status/portal filters.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Full-text search query (FTS5 syntax)' },
          domain: { type: 'string', description: 'Filter by domain (e.g., production, design, crm)' },
          subdomain: { type: 'string', description: 'Filter by subdomain (e.g., factory-review)' },
          status: { type: 'string', description: 'Filter by status: planned, active, deprecated, removed' },
          portal: { type: 'string', description: 'Filter by portal scope: internal, factory, designer, customer' },
          page_route: { type: 'string', description: 'Filter by page route (e.g., /production/factory-reviews/[id])' },
        },
        required: [],
      },
    },
    // P2-002: sentinel_detail
    {
      name: p('sentinel_detail'),
      description: 'Get full feature details including all linked components, procedures, pages, dependencies, and changelog.',
      inputSchema: {
        type: 'object',
        properties: {
          feature_key: { type: 'string', description: 'Feature key (e.g., factory-review.pdf-export)' },
          feature_id: { type: 'number', description: 'Feature ID (alternative to feature_key)' },
        },
        required: [],
      },
    },
    // P2-003: sentinel_impact
    {
      name: p('sentinel_impact'),
      description: 'Pre-deletion impact analysis. Shows which features would be orphaned, degraded, or unaffected if specified files are deleted. BLOCKS if critical features would be orphaned.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of file paths to analyze (relative to project root)',
          },
        },
        required: ['files'],
      },
    },
    // P2-004: sentinel_validate
    {
      name: p('sentinel_validate'),
      description: 'Validate all active features have living implementation files. Reports alive, orphaned, and degraded features.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Optional: only validate features in this domain' },
          fix: { type: 'boolean', description: 'If true, auto-mark dead features as deprecated' },
        },
        required: [],
      },
    },
    // P2-005: sentinel_register
    {
      name: p('sentinel_register'),
      description: 'Register or update a feature in the sentinel registry. Links components, procedures, and pages.',
      inputSchema: {
        type: 'object',
        properties: {
          feature_key: { type: 'string', description: 'Unique feature key (e.g., factory-review.pdf-export)' },
          domain: { type: 'string', description: 'Domain (e.g., production, design, crm)' },
          title: { type: 'string', description: 'Human-readable title' },
          description: { type: 'string', description: 'Feature description / user story' },
          status: { type: 'string', description: 'planned | active | deprecated | removed' },
          priority: { type: 'string', description: 'critical | standard | nice-to-have' },
          portal_scope: { type: 'array', items: { type: 'string' }, description: 'Portal scope array' },
          components: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                is_primary: { type: 'boolean' },
              },
              required: ['file'],
            },
            description: 'Component files to link',
          },
          procedures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                router: { type: 'string' },
                procedure: { type: 'string' },
                type: { type: 'string' },
              },
              required: ['router', 'procedure'],
            },
            description: 'tRPC procedures to link',
          },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                route: { type: 'string' },
                portal: { type: 'string' },
              },
              required: ['route'],
            },
            description: 'Page routes to link',
          },
        },
        required: ['feature_key', 'domain', 'title'],
      },
    },
    // P2-006: sentinel_parity
    {
      name: p('sentinel_parity'),
      description: 'Compare two sets of files for feature parity. Shows features in old but not new (GAPs), features in both (DONE), and features only in new (NEW).',
      inputSchema: {
        type: 'object',
        properties: {
          old_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Old implementation files',
          },
          new_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'New implementation files',
          },
        },
        required: ['old_files', 'new_files'],
      },
    },
  ];
}

// ============================================================
// Tool Handler Router
// ============================================================

export function handleSentinelToolCall(
  name: string,
  args: Record<string, unknown>,
  dataDb: Database.Database
): ToolResult {
  const prefix = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

  switch (baseName) {
    case 'sentinel_search':
      return handleSearch(args, dataDb);
    case 'sentinel_detail':
      return handleDetail(args, dataDb);
    case 'sentinel_impact':
      return handleImpact(args, dataDb);
    case 'sentinel_validate':
      return handleValidate(args, dataDb);
    case 'sentinel_register':
      return handleRegister(args, dataDb);
    case 'sentinel_parity':
      return handleParityCheck(args, dataDb);
    default:
      return text(`Unknown sentinel tool: ${name}`);
  }
}

// ============================================================
// Individual Handlers
// ============================================================

function handleSearch(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const query = (args.query as string) || '';
  const filters = {
    domain: args.domain as string | undefined,
    subdomain: args.subdomain as string | undefined,
    status: args.status as string | undefined,
    portal: args.portal as string | undefined,
    page_route: args.page_route as string | undefined,
  };

  const results = searchFeatures(db, query, filters);
  const lines: string[] = [];

  lines.push(`## Sentinel Search Results (${results.length} features)`);
  if (query) lines.push(`Query: "${query}"`);
  const activeFilters = Object.entries(filters).filter(([, v]) => v);
  if (activeFilters.length > 0) {
    lines.push(`Filters: ${activeFilters.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push('');

  if (results.length === 0) {
    lines.push('No features found matching criteria.');
    return text(lines.join('\n'));
  }

  let currentDomain = '';
  for (const f of results) {
    if (f.domain !== currentDomain) {
      currentDomain = f.domain;
      lines.push(`### ${currentDomain}`);
    }
    const sub = f.subdomain ? `[${f.subdomain}]` : '';
    const priority = f.priority === 'critical' ? ' [CRITICAL]' : '';
    lines.push(`- **${f.feature_key}** ${sub}${priority}: ${f.title} (${f.component_count}C/${f.procedure_count}P/${f.page_count}R) [${f.status}]`);
  }

  return text(lines.join('\n'));
}

function handleDetail(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const key = args.feature_key as string | undefined;
  const id = args.feature_id as number | undefined;

  if (!key && !id) {
    return text('Error: Provide either feature_key or feature_id');
  }

  const detail = getFeatureDetail(db, id || key!);
  if (!detail) {
    return text(`Feature not found: ${key || id}`);
  }

  const lines: string[] = [];
  lines.push(`## Feature: ${detail.feature_key}`);
  lines.push(`- **Title**: ${detail.title}`);
  lines.push(`- **Domain**: ${detail.domain}${detail.subdomain ? '/' + detail.subdomain : ''}`);
  lines.push(`- **Status**: ${detail.status}`);
  lines.push(`- **Priority**: ${detail.priority}`);
  if (detail.description) lines.push(`- **Description**: ${detail.description}`);
  if (detail.portal_scope.length > 0) lines.push(`- **Portals**: ${detail.portal_scope.join(', ')}`);
  lines.push('');

  if (detail.components.length > 0) {
    lines.push(`### Components (${detail.components.length})`);
    for (const c of detail.components) {
      const primary = c.is_primary ? ' [PRIMARY]' : '';
      lines.push(`- ${c.component_file}${c.component_name ? ':' + c.component_name : ''} (${c.role})${primary}`);
    }
    lines.push('');
  }

  if (detail.procedures.length > 0) {
    lines.push(`### Procedures (${detail.procedures.length})`);
    for (const p of detail.procedures) {
      lines.push(`- ${p.router_name}.${p.procedure_name}${p.procedure_type ? ' (' + p.procedure_type + ')' : ''}`);
    }
    lines.push('');
  }

  if (detail.pages.length > 0) {
    lines.push(`### Pages (${detail.pages.length})`);
    for (const p of detail.pages) {
      lines.push(`- ${p.page_route}${p.portal ? ' (' + p.portal + ')' : ''}`);
    }
    lines.push('');
  }

  if (detail.dependencies.length > 0) {
    lines.push(`### Dependencies (${detail.dependencies.length})`);
    for (const d of detail.dependencies) {
      lines.push(`- ${d.dependency_type}: feature #${d.depends_on_feature_id}`);
    }
    lines.push('');
  }

  if (detail.changelog.length > 0) {
    lines.push(`### Changelog (last ${detail.changelog.length})`);
    for (const c of detail.changelog.slice(0, 10)) {
      lines.push(`- [${c.created_at}] ${c.change_type}: ${c.change_detail || '(no detail)'}${c.commit_hash ? ' @' + c.commit_hash.substring(0, 8) : ''}`);
    }
  }

  return text(lines.join('\n'));
}

function handleImpact(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const files = args.files as string[];
  if (!files || files.length === 0) {
    return text('Error: Provide files array');
  }

  const report = getFeatureImpact(db, files);
  const lines: string[] = [];

  lines.push(`## Feature Impact Analysis`);
  lines.push(`Files analyzed: ${report.files_analyzed.length}`);
  lines.push('');

  if (report.blocked) {
    lines.push(`### ${report.block_reason}`);
    lines.push('');
  }

  lines.push(`### Summary`);
  lines.push(`- Orphaned: ${report.orphaned.length} (no primary components left)`);
  lines.push(`- Degraded: ${report.degraded.length} (some components removed)`);
  lines.push(`- Unaffected: ${report.unaffected.length}`);
  lines.push('');

  if (report.orphaned.length > 0) {
    lines.push('### Orphaned Features (BLOCKING)');
    for (const item of report.orphaned) {
      lines.push(`- **${item.feature.feature_key}** [${item.feature.priority}]: ${item.feature.title}`);
      lines.push(`  Files being deleted: ${item.affected_files.join(', ')}`);
      if (item.remaining_files.length > 0) {
        lines.push(`  Remaining (non-primary): ${item.remaining_files.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (report.degraded.length > 0) {
    lines.push('### Degraded Features (Warning)');
    for (const item of report.degraded) {
      lines.push(`- **${item.feature.feature_key}**: ${item.feature.title}`);
      lines.push(`  Removed: ${item.affected_files.join(', ')}`);
      lines.push(`  Remaining: ${item.remaining_files.join(', ')}`);
    }
    lines.push('');
  }

  return text(lines.join('\n'));
}

function handleValidate(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const domain = args.domain as string | undefined;
  const fix = args.fix as boolean | undefined;

  const report = validateFeatures(db, domain);
  const lines: string[] = [];

  lines.push(`## Feature Validation Report`);
  if (domain) lines.push(`Domain filter: ${domain}`);
  lines.push('');

  lines.push(`### Summary`);
  lines.push(`- Alive: ${report.alive}`);
  lines.push(`- Orphaned: ${report.orphaned}`);
  lines.push(`- Degraded: ${report.degraded}`);
  lines.push(`- Total: ${report.alive + report.orphaned + report.degraded}`);
  lines.push('');

  const issues = report.details.filter(d => d.status !== 'alive');
  if (issues.length > 0) {
    lines.push('### Issues');
    for (const item of issues) {
      lines.push(`- **${item.feature.feature_key}** [${item.status.toUpperCase()}]`);
      if (item.missing_components.length > 0) {
        lines.push(`  Missing components: ${item.missing_components.join(', ')}`);
      }
      if (item.missing_procedures.length > 0) {
        lines.push(`  Missing procedures: ${item.missing_procedures.map(p => `${p.router}.${p.procedure}`).join(', ')}`);
      }
      if (item.missing_pages.length > 0) {
        lines.push(`  Missing pages: ${item.missing_pages.join(', ')}`);
      }
    }
    lines.push('');

    if (fix) {
      lines.push('### Auto-Fix Applied');
      for (const item of issues.filter(i => i.status === 'orphaned')) {
        db.prepare("UPDATE massu_sentinel SET status = 'deprecated', updated_at = datetime('now') WHERE id = ?").run(item.feature.id);
        logChange(db, item.feature.id, 'deprecated', 'Auto-deprecated: all primary components missing');
        lines.push(`- Deprecated: ${item.feature.feature_key}`);
      }
    }
  } else {
    lines.push('All active features are alive. No issues found.');
  }

  const result = report.orphaned === 0 ? 'PASS' : 'FAIL';
  lines.push(`### RESULT: ${result}`);

  return text(lines.join('\n'));
}

function handleRegister(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const featureKey = args.feature_key as string;
  const domain = args.domain as string;
  const title = args.title as string;

  if (!featureKey || !domain || !title) {
    return text('Error: feature_key, domain, and title are required');
  }

  const featureId = upsertFeature(db, {
    feature_key: featureKey,
    domain,
    subdomain: args.subdomain as string | undefined,
    title,
    description: args.description as string | undefined,
    status: args.status as FeatureStatus | undefined,
    priority: args.priority as FeaturePriority | undefined,
    portal_scope: args.portal_scope as string[] | undefined,
  });

  // Link components
  const components = args.components as { file: string; name?: string; role?: string; is_primary?: boolean }[] | undefined;
  if (components) {
    for (const c of components) {
      linkComponent(db, featureId, c.file, c.name || null, (c.role as ComponentRole) || 'implementation', c.is_primary || false);
    }
  }

  // Link procedures
  const procedures = args.procedures as { router: string; procedure: string; type?: string }[] | undefined;
  if (procedures) {
    for (const p of procedures) {
      linkProcedure(db, featureId, p.router, p.procedure, p.type);
    }
  }

  // Link pages
  const pages = args.pages as { route: string; portal?: string }[] | undefined;
  if (pages) {
    for (const p of pages) {
      linkPage(db, featureId, p.route, p.portal);
    }
  }

  logChange(db, featureId, 'created', `Registered via ${p('sentinel_register')}`);

  return text(`Feature registered: ${featureKey} (ID: ${featureId})\nComponents: ${components?.length || 0}, Procedures: ${procedures?.length || 0}, Pages: ${pages?.length || 0}`);
}

function handleParityCheck(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const oldFiles = args.old_files as string[];
  const newFiles = args.new_files as string[];

  if (!oldFiles || !newFiles) {
    return text('Error: Provide both old_files and new_files arrays');
  }

  const report = checkParity(db, oldFiles, newFiles);
  const lines: string[] = [];

  lines.push(`## Feature Parity Report`);
  lines.push(`Old files: ${oldFiles.length}, New files: ${newFiles.length}`);
  lines.push(`**Parity: ${report.parity_percentage}%**`);
  lines.push('');

  if (report.done.length > 0) {
    lines.push(`### DONE (${report.done.length} features carried forward)`);
    for (const item of report.done) {
      lines.push(`- ${item.feature_key}: ${item.title}`);
    }
    lines.push('');
  }

  if (report.gaps.length > 0) {
    lines.push(`### GAPS (${report.gaps.length} features MISSING in new implementation)`);
    for (const item of report.gaps) {
      lines.push(`- **${item.feature_key}**: ${item.title}`);
      lines.push(`  Old: ${item.old_files.join(', ')}`);
    }
    lines.push('');
  }

  if (report.new_features.length > 0) {
    lines.push(`### NEW (${report.new_features.length} features only in new)`);
    for (const item of report.new_features) {
      lines.push(`- ${item.feature_key}: ${item.title}`);
    }
    lines.push('');
  }

  const result = report.gaps.length === 0 ? 'PASS' : `FAIL (${report.gaps.length} gaps)`;
  lines.push(`### RESULT: ${result}`);

  return text(lines.join('\n'));
}

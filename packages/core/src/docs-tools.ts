// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { readFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { getConfig, getResolvedPaths } from './config.ts';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';
import { p, text } from './tool-helpers.ts';

// ============================================================
// Help Site Auto-Sync: MCP Docs Tools
// docs_audit + docs_coverage
// ============================================================

const DOCS_BASE_NAMES = new Set(['docs_audit', 'docs_coverage']);

export function isDocsTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return DOCS_BASE_NAMES.has(baseName);
}

interface DocsMapping {
  id: string;
  helpPage: string;
  appRoutes: string[];
  routers: string[];
  components: string[];
  keywords: string[];
}

interface DocsMap {
  version: number;
  mappings: DocsMapping[];
  userGuideInheritance: {
    examples: Record<string, string>;
  };
}

interface AuditResult {
  helpPage: string;
  mappingId: string;
  status: 'STALE' | 'NEW' | 'OK';
  reason: string;
  sections: string[];
  changedFiles: string[];
  suggestedAction: string;
}

interface AuditReport {
  affectedPages: AuditResult[];
  summary: string;
}

interface CoverageEntry {
  id: string;
  helpPage: string;
  exists: boolean;
  hasContent: boolean;
  lineCount: number;
  lastVerified: string | null;
  status: string | null;
}

interface CoverageReport {
  totalMappings: number;
  pagesExisting: number;
  pagesWithContent: number;
  coveragePercent: number;
  entries: CoverageEntry[];
  gaps: string[];
}

// ============================================================
// Tool Definitions
// ============================================================

export function getDocsToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('docs_audit'),
      description: 'Audit which help site pages need updating based on changed files. Maps code changes to affected documentation pages using docs-map.json.',
      inputSchema: {
        type: 'object',
        properties: {
          changed_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of changed files from git diff (relative to project root)',
          },
          commit_message: {
            type: 'string',
            description: 'Optional commit message for context',
          },
        },
        required: ['changed_files'],
      },
    },
    {
      name: p('docs_coverage'),
      description: 'Report docs coverage: which help pages exist, have content, and are up-to-date. Identifies documentation gaps.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Optional: filter by mapping ID (e.g., "dashboard", "users")',
          },
        },
        required: [],
      },
    },
  ];
}

// ============================================================
// Tool Handler Router
// ============================================================

export function handleDocsToolCall(
  name: string,
  args: Record<string, unknown>
): ToolResult {
  const prefix = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

  switch (baseName) {
    case 'docs_audit':
      return handleDocsAudit(args);
    case 'docs_coverage':
      return handleDocsCoverage(args);
    default:
      return text(`Unknown docs tool: ${name}`);
  }
}

// ============================================================
// Core Logic
// ============================================================

function loadDocsMap(): DocsMap {
  const mapPath = getResolvedPaths().docsMapPath;
  if (!existsSync(mapPath)) {
    throw new Error(`docs-map.json not found at ${mapPath}`);
  }
  return JSON.parse(readFileSync(mapPath, 'utf-8'));
}

/**
 * Check if a file path matches a glob-like pattern.
 * Supports ** (any depth) and * (single segment).
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

/**
 * Find which mappings are affected by a set of changed files.
 */
function findAffectedMappings(docsMap: DocsMap, changedFiles: string[]): Map<string, string[]> {
  // Map of mapping ID -> list of changed files that triggered it
  const affected = new Map<string, string[]>();

  for (const file of changedFiles) {
    const fileName = basename(file);

    for (const mapping of docsMap.mappings) {
      let matched = false;

      // Check app routes (glob patterns)
      for (const routePattern of mapping.appRoutes) {
        if (matchesPattern(file, routePattern)) {
          matched = true;
          break;
        }
      }

      // Check routers (filename match)
      if (!matched) {
        for (const router of mapping.routers) {
          if (fileName === router || file.endsWith(`/routers/${router}`)) {
            matched = true;
            break;
          }
        }
      }

      // Check components (glob patterns)
      if (!matched) {
        for (const compPattern of mapping.components) {
          if (matchesPattern(file, compPattern)) {
            matched = true;
            break;
          }
        }
      }

      if (matched) {
        const existing = affected.get(mapping.id) || [];
        existing.push(file);
        affected.set(mapping.id, existing);
      }
    }

    // Check user guide inheritance
    // If a file matches a parent feature, the user guide also needs review
    // (handled implicitly - the parent mapping is what gets flagged)
  }

  return affected;
}

/**
 * Extract headings (H2/H3) from MDX content.
 */
function extractSections(content: string): string[] {
  const headingRegex = /^#{2,3}\s+(.+)$/gm;
  const sections: string[] = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    sections.push(match[0].trim());
  }
  return sections;
}

/**
 * Extract frontmatter from MDX content.
 */
function extractFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---')) return null;
  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) return null;

  const frontmatterStr = content.substring(3, endIndex).trim();
  const result: Record<string, string> = {};

  for (const line of frontmatterStr.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract procedure names from a router file.
 */
function extractProcedureNames(routerPath: string): string[] {
  const absPath = resolve(getResolvedPaths().srcDir, '..', routerPath);
  if (!existsSync(absPath)) {
    // Try from project root
    const altPath = resolve(getResolvedPaths().srcDir, '../server/api/routers', basename(routerPath));
    if (!existsSync(altPath)) return [];
    return extractProcedureNamesFromContent(readFileSync(altPath, 'utf-8'));
  }
  return extractProcedureNamesFromContent(readFileSync(absPath, 'utf-8'));
}

function extractProcedureNamesFromContent(content: string): string[] {
  const procRegex = /\.(?:query|mutation)\s*\(/g;
  const nameRegex = /(\w+)\s*:\s*(?:protected|public)Procedure/g;
  const procedures: string[] = [];

  let match;
  while ((match = nameRegex.exec(content)) !== null) {
    procedures.push(match[1]);
  }

  return procedures;
}

/**
 * Check if MDX content mentions a procedure/feature name.
 */
function contentMentions(content: string, term: string): boolean {
  // Check for the term in various formats
  const lowerContent = content.toLowerCase();
  const lowerTerm = term.toLowerCase();

  // Direct mention
  if (lowerContent.includes(lowerTerm)) return true;

  // camelCase to words: bulkUpdateStatus -> bulk update status
  const words = term.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  if (lowerContent.includes(words)) return true;

  // kebab-case
  const kebab = term.replace(/([A-Z])/g, '-$1').toLowerCase().trim().replace(/^-/, '');
  if (lowerContent.includes(kebab)) return true;

  return false;
}

// ============================================================
// Tool Handlers
// ============================================================

function handleDocsAudit(args: Record<string, unknown>): ToolResult {
  const changedFiles = args.changed_files as string[];
  const commitMessage = (args.commit_message as string) || '';

  if (!changedFiles || changedFiles.length === 0) {
    return text(JSON.stringify({ affectedPages: [], summary: 'No changed files provided.' }));
  }

  const docsMap = loadDocsMap();
  const affectedMappings = findAffectedMappings(docsMap, changedFiles);

  if (affectedMappings.size === 0) {
    return text(JSON.stringify({
      affectedPages: [],
      summary: `0 help pages affected by ${changedFiles.length} changed files. No docs update needed.`,
    }));
  }

  const results: AuditResult[] = [];

  for (const [mappingId, triggeringFiles] of affectedMappings) {
    const mapping = docsMap.mappings.find(m => m.id === mappingId);
    if (!mapping) continue;

    const helpPagePath = resolve(getResolvedPaths().helpSitePath, mapping.helpPage);

    if (!existsSync(helpPagePath)) {
      results.push({
        helpPage: mapping.helpPage,
        mappingId,
        status: 'NEW',
        reason: `Help page does not exist: ${mapping.helpPage}`,
        sections: [],
        changedFiles: triggeringFiles,
        suggestedAction: `Create ${mapping.helpPage} with documentation for this feature`,
      });
      continue;
    }

    const content = readFileSync(helpPagePath, 'utf-8');
    const sections = extractSections(content);
    const frontmatter = extractFrontmatter(content);

    // Check for staleness indicators
    const staleReasons: string[] = [];

    // Check router changes - are new procedures documented?
    for (const file of triggeringFiles) {
      const fileName = basename(file);
      if (mapping.routers.includes(fileName)) {
        const procedures = extractProcedureNames(file);
        const undocumented = procedures.filter(p => !contentMentions(content, p));
        if (undocumented.length > 0) {
          staleReasons.push(
            `Router ${fileName}: procedures not documented: ${undocumented.slice(0, 5).join(', ')}${undocumented.length > 5 ? ` (+${undocumented.length - 5} more)` : ''}`
          );
        }
      }
    }

    // Check if lastVerified is old (> 30 days)
    if (frontmatter?.lastVerified) {
      const lastDate = new Date(frontmatter.lastVerified);
      const daysSince = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince > 30) {
        staleReasons.push(`lastVerified is ${daysSince} days old`);
      }
    } else {
      staleReasons.push('No lastVerified frontmatter');
    }

    // Check commit message for new feature indicators
    if (commitMessage && /\b(add|new|feature|implement)\b/i.test(commitMessage)) {
      staleReasons.push(`Commit message suggests new functionality: "${commitMessage}"`);
    }

    const status = staleReasons.length > 0 ? 'STALE' : 'OK';

    results.push({
      helpPage: mapping.helpPage,
      mappingId,
      status,
      reason: staleReasons.length > 0 ? staleReasons.join('; ') : 'Content appears current',
      sections,
      changedFiles: triggeringFiles,
      suggestedAction: status === 'STALE'
        ? `Review and update ${mapping.helpPage} to reflect changes in: ${triggeringFiles.map(f => basename(f)).join(', ')}`
        : 'No action needed',
    });

    // Also flag inherited user guides
    for (const [guideName, parentId] of Object.entries(docsMap.userGuideInheritance.examples)) {
      if (parentId === mappingId) {
        const guidePath = resolve(getResolvedPaths().helpSitePath, `pages/user-guides/${guideName}/index.mdx`);
        if (existsSync(guidePath)) {
          const guideContent = readFileSync(guidePath, 'utf-8');
          const guideFrontmatter = extractFrontmatter(guideContent);

          if (!guideFrontmatter?.lastVerified || status === 'STALE') {
            results.push({
              helpPage: `pages/user-guides/${guideName}/index.mdx`,
              mappingId: `${mappingId}:${guideName}`,
              status: 'STALE',
              reason: `Inherited from parent mapping "${mappingId}" which has changes`,
              sections: extractSections(guideContent),
              changedFiles: triggeringFiles,
              suggestedAction: `Review user guide "${guideName}" for consistency with updated ${mapping.helpPage}`,
            });
          }
        }
      }
    }
  }

  const staleCount = results.filter(r => r.status === 'STALE').length;
  const newCount = results.filter(r => r.status === 'NEW').length;
  const okCount = results.filter(r => r.status === 'OK').length;

  const report: AuditReport = {
    affectedPages: results,
    summary: `${results.length} pages checked: ${staleCount} STALE, ${newCount} NEW, ${okCount} OK. ${staleCount + newCount > 0 ? `${staleCount + newCount} pages need updates.` : 'All docs are current.'}`,
  };

  return text(JSON.stringify(report, null, 2));
}

function handleDocsCoverage(args: Record<string, unknown>): ToolResult {
  const filterDomain = args.domain as string | undefined;
  const docsMap = loadDocsMap();

  const entries: CoverageEntry[] = [];
  const gaps: string[] = [];

  const mappings = filterDomain
    ? docsMap.mappings.filter(m => m.id === filterDomain)
    : docsMap.mappings;

  for (const mapping of mappings) {
    const helpPagePath = resolve(getResolvedPaths().helpSitePath, mapping.helpPage);
    const exists = existsSync(helpPagePath);
    let hasContent = false;
    let lineCount = 0;
    let lastVerified: string | null = null;
    let status: string | null = null;

    if (exists) {
      const content = readFileSync(helpPagePath, 'utf-8');
      lineCount = content.split('\n').length;
      hasContent = lineCount > 10; // More than just frontmatter

      const frontmatter = extractFrontmatter(content);
      if (frontmatter) {
        lastVerified = frontmatter.lastVerified || null;
        status = frontmatter.status || null;
      }
    } else {
      gaps.push(`${mapping.id}: Help page missing (${mapping.helpPage})`);
    }

    entries.push({
      id: mapping.id,
      helpPage: mapping.helpPage,
      exists,
      hasContent,
      lineCount,
      lastVerified,
      status,
    });
  }

  const report: CoverageReport = {
    totalMappings: mappings.length,
    pagesExisting: entries.filter(e => e.exists).length,
    pagesWithContent: entries.filter(e => e.hasContent).length,
    coveragePercent: Math.round((entries.filter(e => e.hasContent).length / mappings.length) * 100),
    entries,
    gaps,
  };

  const lines: string[] = [];
  lines.push(`## Docs Coverage Report${filterDomain ? ` (${filterDomain})` : ''}`);
  lines.push('');
  lines.push(`- Total mappings: ${report.totalMappings}`);
  lines.push(`- Pages existing: ${report.pagesExisting}`);
  lines.push(`- Pages with content: ${report.pagesWithContent}`);
  lines.push(`- Coverage: ${report.coveragePercent}%`);
  lines.push('');

  if (report.gaps.length > 0) {
    lines.push('### Gaps');
    for (const gap of report.gaps) {
      lines.push(`- ${gap}`);
    }
    lines.push('');
  }

  lines.push('### Page Status');
  for (const entry of report.entries) {
    const verified = entry.lastVerified ? ` (verified: ${entry.lastVerified})` : ' (not verified)';
    const pageStatus = entry.status ? ` [${entry.status}]` : '';
    const icon = entry.hasContent ? 'OK' : entry.exists ? 'THIN' : 'MISSING';
    lines.push(`- [${icon}] ${entry.id}: ${entry.helpPage}${verified}${pageStatus} (${entry.lineCount} lines)`);
  }

  return text(lines.join('\n'));
}


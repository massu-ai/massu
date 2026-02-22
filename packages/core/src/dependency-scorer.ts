// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';
import { p, text } from './tool-helpers.ts';
import { getConfig } from './config.ts';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ============================================================
// Dependency Risk Scoring
// ============================================================

export interface DepRiskFactors {
  vulnerabilities: number;
  lastPublishDays: number | null;
  weeklyDownloads: number | null;
  license: string | null;
  bundleSizeKb: number | null;
  previousRemovals: number;
}

/** Default restrictive licenses. Configurable via security.restrictive_licenses */
const DEFAULT_RESTRICTIVE_LICENSES = ['GPL', 'AGPL', 'SSPL'];

/**
 * Get restrictive license list from config or defaults.
 */
function getRestrictiveLicenses(): string[] {
  return getConfig().security?.restrictive_licenses ?? DEFAULT_RESTRICTIVE_LICENSES;
}

/**
 * Calculate risk score for a dependency.
 * 0 = safe, 100 = critical risk.
 */
export function calculateDepRisk(factors: DepRiskFactors): number {
  let risk = 0;
  const restrictiveLicenses = getRestrictiveLicenses();

  // Vulnerabilities (heaviest weight)
  risk += Math.min(40, factors.vulnerabilities * 15);

  // Staleness (no publish in 2+ years is risky)
  if (factors.lastPublishDays !== null) {
    if (factors.lastPublishDays > 730) risk += 20;
    else if (factors.lastPublishDays > 365) risk += 10;
    else if (factors.lastPublishDays > 180) risk += 5;
  }

  // Low popularity
  if (factors.weeklyDownloads !== null) {
    if (factors.weeklyDownloads < 100) risk += 15;
    else if (factors.weeklyDownloads < 1000) risk += 8;
    else if (factors.weeklyDownloads < 10000) risk += 3;
  }

  // License issues
  if (factors.license) {
    if (restrictiveLicenses.some(l => factors.license!.toUpperCase().includes(l))) {
      risk += 10;
    }
  } else {
    risk += 5; // Unknown license
  }

  // Historical churn (AI added then removed)
  risk += Math.min(15, factors.previousRemovals * 5);

  return Math.min(100, risk);
}

/**
 * Get installed packages from package.json.
 */
export function getInstalledPackages(projectRoot: string): Map<string, string> {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return new Map();

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const packages = new Map<string, string>();
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      packages.set(name, version as string);
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      packages.set(name, version as string);
    }
    return packages;
  } catch {
    return new Map();
  }
}

/**
 * Store a dependency assessment.
 */
export function storeAssessment(
  db: Database.Database,
  packageName: string,
  version: string | null,
  riskScore: number,
  factors: DepRiskFactors
): void {
  db.prepare(`
    INSERT INTO dependency_assessments
    (package_name, version, risk_score, vulnerabilities, last_publish_days,
     weekly_downloads, license, bundle_size_kb, previous_removals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    packageName, version, riskScore,
    factors.vulnerabilities, factors.lastPublishDays,
    factors.weeklyDownloads, factors.license,
    factors.bundleSizeKb, factors.previousRemovals
  );
}

/**
 * Get historical removal count for a package.
 */
export function getPreviousRemovals(db: Database.Database, packageName: string): number {
  const row = db.prepare(`
    SELECT MAX(previous_removals) as removals
    FROM dependency_assessments WHERE package_name = ?
  `).get(packageName) as { removals: number | null } | undefined;
  return row?.removals ?? 0;
}

/** Default alternative mappings. Configurable via security.dep_alternatives */
const DEFAULT_ALTERNATIVES: Record<string, string[]> = {
  'moment': ['date-fns', 'dayjs', 'luxon'],
  'lodash': ['lodash-es', 'radash', 'remeda'],
  'axios': ['ky', 'got', 'undici'],
  'express': ['fastify', 'hono', 'elysia'],
  'chalk': ['picocolors', 'kleur', 'colorette'],
  'uuid': ['nanoid', 'cuid2', 'ulid'],
  'request': ['got', 'node-fetch', 'undici'],
  'underscore': ['lodash-es', 'radash'],
};

/**
 * Get alternative mappings from config or defaults.
 */
function getAlternatives(): Record<string, string[]> {
  return getConfig().security?.dep_alternatives ?? DEFAULT_ALTERNATIVES;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getDependencyToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('dep_score'),
      description: 'Assess a dependency before adding it. Returns risk score, factors, and recommendation.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: { type: 'string', description: 'npm package name' },
          version: { type: 'string', description: 'Specific version to assess' },
        },
        required: ['package_name'],
      },
    },
    {
      name: p('dep_alternatives'),
      description: 'Suggest alternatives to a package. Checks already-installed packages first.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: { type: 'string', description: 'Package to find alternatives for' },
          purpose: { type: 'string', description: 'What you need the package for' },
        },
        required: ['package_name'],
      },
    },
  ];
}

const DEPENDENCY_BASE_NAMES = new Set(['dep_score', 'dep_alternatives']);

export function isDependencyTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return DEPENDENCY_BASE_NAMES.has(baseName);
}

export function handleDependencyToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'dep_score':
        return handleDepCheck(args, memoryDb);
      case 'dep_alternatives':
        return handleDepAlternatives(args, memoryDb);
      default:
        return text(`Unknown dependency tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('dep_score')} { package_name: "express" }, ${p('dep_alternatives')} { package_name: "moment" }`);
  }
}

function handleDepCheck(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const packageName = args.package_name as string;
  if (!packageName) return text(`Usage: ${p('dep_score')} { package_name: "express", version: "4.18.0" } - Assess risk of adding/updating a dependency.`);
  const version = args.version as string | undefined;

  // Check if already installed
  const config = getConfig();
  const installed = getInstalledPackages(config.project.root);
  const isInstalled = installed.has(packageName);

  // Check historical assessments
  const previous = db.prepare(`
    SELECT * FROM dependency_assessments
    WHERE package_name = ?
    ORDER BY assessed_at DESC LIMIT 1
  `).get(packageName) as Record<string, unknown> | undefined;

  const previousRemovals = getPreviousRemovals(db, packageName);

  // Build factors from available data
  const factors: DepRiskFactors = {
    vulnerabilities: previous ? (previous.vulnerabilities as number) : 0,
    lastPublishDays: previous ? (previous.last_publish_days as number | null) : null,
    weeklyDownloads: previous ? (previous.weekly_downloads as number | null) : null,
    license: previous ? (previous.license as string | null) : null,
    bundleSizeKb: previous ? (previous.bundle_size_kb as number | null) : null,
    previousRemovals,
  };

  const riskScore = calculateDepRisk(factors);

  const recommendation = riskScore >= 60 ? 'AVOID'
    : riskScore >= 30 ? 'CAUTION'
    : 'OK';

  const lines = [
    `## Dependency Check: ${packageName}${version ? `@${version}` : ''}`,
    `Risk Score: **${riskScore}/100** [${recommendation}]`,
    `Currently installed: ${isInstalled ? `Yes (${installed.get(packageName)})` : 'No'}`,
    '',
    '### Risk Factors',
    `| Factor | Value | Risk |`,
    `|--------|-------|------|`,
  ];

  if (factors.vulnerabilities > 0) {
    lines.push(`| Vulnerabilities | ${factors.vulnerabilities} | +${Math.min(40, factors.vulnerabilities * 15)} |`);
  }
  if (factors.lastPublishDays !== null) {
    lines.push(`| Last Published | ${factors.lastPublishDays} days ago | ${factors.lastPublishDays > 365 ? '+10' : '0'} |`);
  }
  if (factors.weeklyDownloads !== null) {
    lines.push(`| Weekly Downloads | ${factors.weeklyDownloads.toLocaleString()} | ${factors.weeklyDownloads < 1000 ? '+8' : '0'} |`);
  }
  if (factors.license) {
    lines.push(`| License | ${factors.license} | 0 |`);
  }
  if (previousRemovals > 0) {
    lines.push(`| Previous Removals | ${previousRemovals}x | +${Math.min(15, previousRemovals * 5)} |`);
  }

  if (!previous) {
    lines.push('');
    lines.push(`*Note: No previous assessment data. Run \`npm audit\` for vulnerability data, then re-run ${p('dep_score')} for a more accurate score.*`);
  }

  // Store assessment
  storeAssessment(db, packageName, version ?? null, riskScore, factors);

  return text(lines.join('\n'));
}

function handleDepAlternatives(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const packageName = args.package_name as string;
  const purpose = args.purpose as string | undefined;
  if (!packageName) return text(`Usage: ${p('dep_alternatives')} { package_name: "lodash", purpose: "utility functions" } - Find safer/lighter alternatives.`);

  const config = getConfig();
  const installed = getInstalledPackages(config.project.root);
  const alternativeMappings = getAlternatives();

  const lines = [
    `## Alternatives to: ${packageName}`,
    purpose ? `Purpose: ${purpose}` : '',
    '',
  ];

  // Check if any alternatives are already installed
  const alts = alternativeMappings[packageName] ?? [];
  const installedAlts = alts.filter(a => installed.has(a));

  if (installedAlts.length > 0) {
    lines.push('### Already Installed');
    for (const alt of installedAlts) {
      lines.push(`- **${alt}** (${installed.get(alt)}) - already in your dependencies`);
    }
    lines.push('');
  }

  if (alts.length > 0) {
    const notInstalled = alts.filter(a => !installed.has(a));
    if (notInstalled.length > 0) {
      lines.push('### Known Alternatives');
      for (const alt of notInstalled) {
        // Check previous assessments
        const prev = db.prepare(
          'SELECT risk_score FROM dependency_assessments WHERE package_name = ? ORDER BY assessed_at DESC LIMIT 1'
        ).get(alt) as { risk_score: number } | undefined;
        const riskInfo = prev ? ` (risk: ${prev.risk_score})` : '';
        lines.push(`- ${alt}${riskInfo}`);
      }
    }
  } else {
    lines.push(`No known alternative mappings for "${packageName}". Consider searching npm for packages that serve: ${purpose ?? packageName}. You can add custom alternative mappings via the \`security.dep_alternatives\` config key.`);
  }

  return text(lines.filter(Boolean).join('\n'));
}


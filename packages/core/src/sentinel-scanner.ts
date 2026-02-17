// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, basename, dirname, relative } from 'path';
import {
  upsertFeature,
  linkComponent,
  linkProcedure,
  linkPage,
  logChange,
} from './sentinel-db.ts';
import type { FeatureInput, FeaturePriority } from './sentinel-types.ts';
import { getConfig, getProjectRoot } from './config.ts';

// ============================================================
// Sentinel: Feature Auto-Discovery Scanner
// ============================================================

interface DiscoveredFeature extends FeatureInput {
  components: { file: string; name: string | null; role: 'implementation' | 'ui' | 'data' | 'utility'; isPrimary: boolean }[];
  procedures: { router: string; procedure: string; type: string }[];
  pages: { route: string; portal: string | null }[];
}

// ============================================================
// Domain inference from file path
// ============================================================

function inferDomain(filePath: string): string {
  const domains = getConfig().domains;
  const path = filePath.toLowerCase();

  // Try to match against configured domain page patterns and router patterns
  for (const domain of domains) {
    const domainLower = domain.name.toLowerCase();
    // Check if any router name appears in the path
    for (const router of domain.routers) {
      const routerLower = router.replace(/\*/g, '').toLowerCase();
      if (routerLower && path.includes(routerLower)) {
        return domainLower;
      }
    }
    // Check if domain name keyword appears in the path
    const nameWords = domainLower.split(/[\/\s]+/);
    for (const word of nameWords) {
      if (word.length > 2 && path.includes('/' + word + '/')) {
        return domainLower;
      }
    }
  }

  return 'system';
}

function inferSubdomain(routerName: string, procedureName: string): string {
  // Convert camelCase router to kebab-case subdomain
  return routerName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
}

function kebabToTitle(kebab: string): string {
  return kebab
    .split(/[-_.]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ============================================================
// @feature annotation parser
// ============================================================

interface FeatureAnnotation {
  featureKey: string;
  title?: string;
  priority?: string;
  description?: string;
}

function parseFeatureAnnotations(source: string): FeatureAnnotation[] {
  const annotations: FeatureAnnotation[] = [];
  const regex = /@feature\s+([\w.-]+)/g;
  const titleRegex = /@feature-title\s+(.+)/g;
  const priorityRegex = /@feature-priority\s+(\w+)/g;

  let match;
  while ((match = regex.exec(source)) !== null) {
    const annotation: FeatureAnnotation = { featureKey: match[1] };

    // Look for companion annotations in nearby text
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(source.length, match.index + 300);
    const context = source.substring(contextStart, contextEnd);

    const titleMatch = /@feature-title\s+(.+)/.exec(context);
    if (titleMatch) annotation.title = titleMatch[1].trim();

    const priorityMatch = /@feature-priority\s+(\w+)/.exec(context);
    if (priorityMatch) annotation.priority = priorityMatch[1].trim();

    annotations.push(annotation);
  }

  return annotations;
}

// ============================================================
// Scanner: tRPC Procedures -> Features
// ============================================================

function scanTrpcProcedures(dataDb: Database.Database): DiscoveredFeature[] {
  const features: DiscoveredFeature[] = [];
  const featureMap = new Map<string, DiscoveredFeature>();

  const procedures = dataDb.prepare(`
    SELECT router_name, procedure_name, procedure_type, router_file
    FROM massu_trpc_procedures
    ORDER BY router_name, procedure_name
  `).all() as { router_name: string; procedure_name: string; procedure_type: string; router_file: string }[];

  for (const proc of procedures) {
    const subdomain = inferSubdomain(proc.router_name, proc.procedure_name);
    const domain = inferDomain(proc.router_file);

    // Group procedures by router into features
    const featureKey = `${subdomain}.${proc.procedure_name}`;
    const routerFeatureKey = `${subdomain}.crud`;

    // Individual procedure-level feature
    if (!featureMap.has(featureKey)) {
      featureMap.set(featureKey, {
        feature_key: featureKey,
        domain,
        subdomain,
        title: `${kebabToTitle(subdomain)} - ${kebabToTitle(proc.procedure_name)}`,
        status: 'active',
        priority: 'standard',
        components: [],
        procedures: [],
        pages: [],
      });
    }

    const feature = featureMap.get(featureKey)!;
    feature.procedures.push({
      router: proc.router_name,
      procedure: proc.procedure_name,
      type: proc.procedure_type,
    });

    // Link the router file as a component
    if (!feature.components.some(c => c.file === proc.router_file)) {
      feature.components.push({
        file: proc.router_file,
        name: null,
        role: 'data',
        isPrimary: false,
      });
    }
  }

  return Array.from(featureMap.values());
}

// ============================================================
// Scanner: Page Routes -> Features
// ============================================================

function scanPageRoutes(dataDb: Database.Database): DiscoveredFeature[] {
  const features: DiscoveredFeature[] = [];

  const pages = dataDb.prepare(`
    SELECT page_file, route, portal, components, hooks, routers
    FROM massu_page_deps
    ORDER BY route
  `).all() as { page_file: string; route: string; portal: string; components: string; hooks: string; routers: string }[];

  for (const page of pages) {
    const domain = inferDomain(page.route);
    const routeParts = page.route.split('/').filter(Boolean);
    const subdomain = routeParts.length > 1 ? routeParts.slice(0, 2).join('-') : routeParts[0] || 'root';

    // Skip layout pages, error pages, etc.
    if (page.route.includes('error') || page.route.includes('not-found') || page.route === '/') continue;

    const featureKey = `page.${page.route.replace(/\//g, '.').replace(/^\.|\.$/g, '').replace(/\[(\w+)\]/g, '_$1_')}`;

    const components = JSON.parse(page.components || '[]') as string[];
    const routers = JSON.parse(page.routers || '[]') as string[];

    const feature: DiscoveredFeature = {
      feature_key: featureKey,
      domain,
      subdomain: subdomain.replace(/\//g, '-'),
      title: `Page: ${page.route}`,
      status: 'active',
      priority: 'standard',
      portal_scope: [page.portal],
      components: [
        { file: page.page_file, name: null, role: 'ui', isPrimary: true },
        ...components.map(c => ({ file: c, name: null as string | null, role: 'ui' as const, isPrimary: false })),
      ],
      procedures: [],
      pages: [{ route: page.route, portal: page.portal }],
    };

    features.push(feature);
  }

  return features;
}

// ============================================================
// Scanner: Component Exports -> Features
// ============================================================

function scanComponentExports(dataDb: Database.Database): DiscoveredFeature[] {
  const features: DiscoveredFeature[] = [];

  // Scan component directories for interactive features
  const config = getConfig();
  const projectRoot = getProjectRoot();
  const componentsBase = config.paths.components ?? (config.paths.source + '/components');

  // Build component dirs from domain names + a generic scan
  const componentDirs: string[] = [];
  const basePath = resolve(projectRoot, componentsBase);
  if (existsSync(basePath)) {
    try {
      const entries = readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          componentDirs.push(componentsBase + '/' + entry.name);
        }
      }
    } catch {
      // Skip if unreadable
    }
  }

  for (const dir of componentDirs) {
    const absDir = resolve(projectRoot, dir);
    if (!existsSync(absDir)) continue;

    const files = walkDir(absDir).filter(f => f.endsWith('.tsx') || f.endsWith('.ts'));
    for (const file of files) {
      const relPath = relative(projectRoot, file);
      const source = readFileSync(file, 'utf-8');

      // Parse @feature annotations
      const annotations = parseFeatureAnnotations(source);
      if (annotations.length > 0) {
        for (const ann of annotations) {
          const domain = inferDomain(relPath);
          const parts = ann.featureKey.split('.');
          const feature: DiscoveredFeature = {
            feature_key: ann.featureKey,
            domain,
            subdomain: parts[0],
            title: ann.title || kebabToTitle(ann.featureKey),
            description: ann.description,
            status: 'active',
            priority: (ann.priority as FeaturePriority) || 'standard',
            components: [{ file: relPath, name: null, role: 'implementation', isPrimary: true }],
            procedures: [],
            pages: [],
          };
          features.push(feature);
        }
      }

      // Detect interactive features: exported functions with mutation/handler patterns
      const hasHandlers = /onClick|onSubmit|useMutation|api\.\w+\.\w+\.use/.test(source);
      const exportMatch = /export\s+(?:default\s+)?(?:function|const)\s+(\w+)/.exec(source);

      if (hasHandlers && exportMatch) {
        const componentName = exportMatch[1];
        const domain = inferDomain(relPath);
        const subdomain = basename(dirname(relPath));
        const featureKey = `component.${subdomain}.${componentName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}`;

        // Only add if not already covered by annotation
        if (!annotations.some(a => a.featureKey === featureKey)) {
          features.push({
            feature_key: featureKey,
            domain,
            subdomain,
            title: `${componentName}`,
            status: 'active',
            priority: 'standard',
            components: [{ file: relPath, name: componentName, role: 'implementation', isPrimary: true }],
            procedures: [],
            pages: [],
          });
        }
      }
    }
  }

  return features;
}

// ============================================================
// Utility: Walk directory recursively
// ============================================================

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...walkDir(fullPath));
        } else {
          results.push(fullPath);
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return results;
}

// ============================================================
// Main Scanner Entry Point
// ============================================================

export interface ScanResult {
  totalDiscovered: number;
  fromProcedures: number;
  fromPages: number;
  fromComponents: number;
  registered: number;
}

export function runFeatureScan(dataDb: Database.Database): ScanResult {
  const procedureFeatures = scanTrpcProcedures(dataDb);
  const pageFeatures = scanPageRoutes(dataDb);
  const componentFeatures = scanComponentExports(dataDb);

  // Merge: annotations take priority, then components, then pages, then procedures
  const allFeatures = new Map<string, DiscoveredFeature>();

  // Add procedures first (lowest priority)
  for (const f of procedureFeatures) {
    allFeatures.set(f.feature_key, f);
  }

  // Add pages
  for (const f of pageFeatures) {
    allFeatures.set(f.feature_key, f);
  }

  // Add components (highest priority from scanning)
  for (const f of componentFeatures) {
    allFeatures.set(f.feature_key, f);
  }

  // Register all discovered features
  let registered = 0;
  for (const feature of allFeatures.values()) {
    const featureId = upsertFeature(dataDb, {
      feature_key: feature.feature_key,
      domain: feature.domain,
      subdomain: feature.subdomain,
      title: feature.title,
      description: feature.description,
      status: feature.status,
      priority: feature.priority,
      portal_scope: feature.portal_scope,
    });

    // Link components
    for (const comp of feature.components) {
      linkComponent(dataDb, featureId, comp.file, comp.name, comp.role, comp.isPrimary);
    }

    // Link procedures
    for (const proc of feature.procedures) {
      linkProcedure(dataDb, featureId, proc.router, proc.procedure, proc.type);
    }

    // Link pages
    for (const page of feature.pages) {
      linkPage(dataDb, featureId, page.route, page.portal ?? undefined);
    }

    logChange(dataDb, featureId, 'created', 'Auto-discovered by sentinel scanner', undefined, 'scanner');
    registered++;
  }

  return {
    totalDiscovered: allFeatures.size,
    fromProcedures: procedureFeatures.length,
    fromPages: pageFeatures.length,
    fromComponents: componentFeatures.length,
    registered,
  };
}

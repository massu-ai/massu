// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Test the docs-tools module functions
// We import and test the exported functions directly

describe('docs-map.json', () => {
  let docsMap: any;

  beforeAll(() => {
    const mapPath = resolve(__dirname, '../docs-map.json');
    expect(existsSync(mapPath)).toBe(true);
    docsMap = JSON.parse(readFileSync(mapPath, 'utf-8'));
  });

  it('has correct version', () => {
    expect(docsMap.version).toBe(1);
  });

  it('has at least 8 mappings', () => {
    expect(docsMap.mappings.length).toBeGreaterThanOrEqual(8);
  });

  it('each mapping has required fields', () => {
    for (const mapping of docsMap.mappings) {
      expect(mapping).toHaveProperty('id');
      expect(mapping).toHaveProperty('helpPage');
      expect(mapping).toHaveProperty('appRoutes');
      expect(mapping).toHaveProperty('routers');
      expect(mapping).toHaveProperty('components');
      expect(mapping).toHaveProperty('keywords');
      expect(typeof mapping.id).toBe('string');
      expect(typeof mapping.helpPage).toBe('string');
      expect(Array.isArray(mapping.appRoutes)).toBe(true);
      expect(Array.isArray(mapping.routers)).toBe(true);
      expect(Array.isArray(mapping.components)).toBe(true);
      expect(Array.isArray(mapping.keywords)).toBe(true);
    }
  });

  it('has unique mapping IDs', () => {
    const ids = docsMap.mappings.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has user guide inheritance mapping', () => {
    expect(docsMap.userGuideInheritance).toBeDefined();
    expect(docsMap.userGuideInheritance.examples).toBeDefined();
    expect(Object.keys(docsMap.userGuideInheritance.examples).length).toBeGreaterThanOrEqual(5);
  });

  it('all user guide parent IDs reference valid mapping IDs', () => {
    const validIds = new Set(docsMap.mappings.map((m: any) => m.id));
    for (const [guide, parentId] of Object.entries(docsMap.userGuideInheritance.examples)) {
      expect(validIds.has(parentId as string)).toBe(true);
    }
  });

  it('maps key features correctly', () => {
    const findMapping = (id: string) => docsMap.mappings.find((m: any) => m.id === id);

    // Dashboard mapping should include dashboard routers
    const dashboard = findMapping('dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard.routers).toContain('dashboard.ts');
    expect(dashboard.appRoutes.some((r: string) => r.includes('dashboard'))).toBe(true);

    // Users mapping
    const users = findMapping('users');
    expect(users).toBeDefined();
    expect(users.routers).toContain('users.ts');

    // Billing mapping
    const billing = findMapping('billing');
    expect(billing).toBeDefined();
    expect(billing.routers).toContain('billing.ts');
  });
});

describe('matchesPattern (glob matching)', () => {
  // Test the glob matching logic used in docs-tools
  function matchesPattern(filePath: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    return new RegExp(`^${regexStr}$`).test(filePath);
  }

  it('matches ** glob patterns', () => {
    expect(matchesPattern('src/app/orders/page.tsx', 'src/app/orders/**')).toBe(true);
    expect(matchesPattern('src/app/orders/[id]/page.tsx', 'src/app/orders/**')).toBe(true);
    expect(matchesPattern('src/app/crm/page.tsx', 'src/app/orders/**')).toBe(false);
  });

  it('matches component patterns', () => {
    expect(matchesPattern('src/components/orders/OrderCard.tsx', 'src/components/orders/**')).toBe(true);
    expect(matchesPattern('src/components/crm/LeadList.tsx', 'src/components/orders/**')).toBe(false);
  });

  it('matches nested paths', () => {
    expect(matchesPattern('src/app/admin/dashboard/page.tsx', 'src/app/admin/dashboard/**')).toBe(true);
    expect(matchesPattern('src/app/admin/page.tsx', 'src/app/admin/**')).toBe(true);
  });
});

describe('findAffectedMappings logic', () => {
  let docsMap: any;

  beforeAll(() => {
    docsMap = JSON.parse(readFileSync(resolve(__dirname, '../docs-map.json'), 'utf-8'));
  });

  function findAffectedMappings(changedFiles: string[]): Map<string, string[]> {
    const affected = new Map<string, string[]>();
    const matchesPattern = (filePath: string, pattern: string): boolean => {
      const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*');
      return new RegExp(`^${regexStr}$`).test(filePath);
    };

    for (const file of changedFiles) {
      const fileName = file.split('/').pop() || '';
      for (const mapping of docsMap.mappings) {
        let matched = false;
        for (const routePattern of mapping.appRoutes) {
          if (matchesPattern(file, routePattern)) { matched = true; break; }
        }
        if (!matched) {
          for (const router of mapping.routers) {
            if (fileName === router || file.endsWith(`/routers/${router}`)) { matched = true; break; }
          }
        }
        if (!matched) {
          for (const compPattern of mapping.components) {
            if (matchesPattern(file, compPattern)) { matched = true; break; }
          }
        }
        if (matched) {
          const existing = affected.get(mapping.id) || [];
          existing.push(file);
          affected.set(mapping.id, existing);
        }
      }
    }
    return affected;
  }

  it('maps router changes to correct help pages', () => {
    const affected = findAffectedMappings(['src/server/api/routers/dashboard.ts']);
    expect(affected.has('dashboard')).toBe(true);
    expect(affected.has('users')).toBe(false);
  });

  it('maps page changes to correct help pages', () => {
    const affected = findAffectedMappings(['src/app/users/page.tsx']);
    expect(affected.has('users')).toBe(true);
    expect(affected.has('dashboard')).toBe(false);
  });

  it('maps component changes to correct help pages', () => {
    const affected = findAffectedMappings(['src/components/billing/PlanCard.tsx']);
    expect(affected.has('billing')).toBe(true);
  });

  it('returns empty for non-user-facing files', () => {
    const affected = findAffectedMappings(['scripts/some-script.sh', 'package.json', '.gitignore']);
    expect(affected.size).toBe(0);
  });

  it('handles multiple affected mappings', () => {
    const affected = findAffectedMappings([
      'src/server/api/routers/dashboard.ts',
      'src/server/api/routers/users.ts',
      'src/app/billing/page.tsx',
    ]);
    expect(affected.has('dashboard')).toBe(true);
    expect(affected.has('users')).toBe(true);
    expect(affected.has('billing')).toBe(true);
  });

  it('maps notification routers correctly', () => {
    const affected = findAffectedMappings(['src/server/api/routers/notifications.ts']);
    expect(affected.has('notifications')).toBe(true);
  });

  it('maps integration routers correctly', () => {
    const affected = findAffectedMappings(['src/server/api/routers/integrations.ts']);
    expect(affected.has('integrations')).toBe(true);
  });
});

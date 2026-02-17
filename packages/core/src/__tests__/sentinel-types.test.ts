// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import type {
  Feature,
  FeatureInput,
  FeatureComponent,
  FeatureProcedure,
  FeaturePage,
  FeatureDep,
  FeatureChangeLog,
  FeatureWithCounts,
  FeatureDetail,
  ImpactItem,
  ImpactReport,
  ValidationItem,
  ValidationReport,
  ParityItem,
  ParityReport,
  FeatureStatus,
  FeaturePriority,
  ComponentRole,
  DependencyType,
  ChangeType,
} from '../sentinel-types.ts';

// ============================================================
// Sentinel Types Tests
// Verifies type shapes compile and runtime objects conform.
// ============================================================

// ------------------------------------
// Type guard helpers (runtime checks)
// ------------------------------------

function isFeatureStatus(value: unknown): value is FeatureStatus {
  return (
    typeof value === 'string' &&
    ['planned', 'active', 'deprecated', 'removed'].includes(value)
  );
}

function isFeaturePriority(value: unknown): value is FeaturePriority {
  return (
    typeof value === 'string' &&
    ['critical', 'standard', 'nice-to-have'].includes(value)
  );
}

function isComponentRole(value: unknown): value is ComponentRole {
  return (
    typeof value === 'string' &&
    ['implementation', 'ui', 'data', 'utility'].includes(value)
  );
}

function isDependencyType(value: unknown): value is DependencyType {
  return (
    typeof value === 'string' &&
    ['requires', 'enhances', 'replaces'].includes(value)
  );
}

function isChangeType(value: unknown): value is ChangeType {
  return (
    typeof value === 'string' &&
    ['created', 'updated', 'deprecated', 'removed', 'restored'].includes(value)
  );
}

function isFeature(obj: unknown): obj is Feature {
  if (typeof obj !== 'object' || obj === null) return false;
  const f = obj as Record<string, unknown>;
  return (
    typeof f.id === 'number' &&
    typeof f.feature_key === 'string' &&
    typeof f.domain === 'string' &&
    (f.subdomain === null || typeof f.subdomain === 'string') &&
    typeof f.title === 'string' &&
    (f.description === null || typeof f.description === 'string') &&
    isFeatureStatus(f.status) &&
    isFeaturePriority(f.priority) &&
    Array.isArray(f.portal_scope) &&
    typeof f.created_at === 'string' &&
    typeof f.updated_at === 'string' &&
    (f.removed_at === null || typeof f.removed_at === 'string') &&
    (f.removed_reason === null || typeof f.removed_reason === 'string')
  );
}

// ------------------------------------
// Type literal union tests
// ------------------------------------

describe('FeatureStatus union type', () => {
  it('accepts all valid status values', () => {
    const statuses: FeatureStatus[] = ['planned', 'active', 'deprecated', 'removed'];
    expect(statuses).toHaveLength(4);
    for (const s of statuses) {
      expect(isFeatureStatus(s)).toBe(true);
    }
  });

  it('rejects invalid status values at runtime', () => {
    expect(isFeatureStatus('unknown')).toBe(false);
    expect(isFeatureStatus('')).toBe(false);
    expect(isFeatureStatus(null)).toBe(false);
    expect(isFeatureStatus(42)).toBe(false);
  });
});

describe('FeaturePriority union type', () => {
  it('accepts all valid priority values', () => {
    const priorities: FeaturePriority[] = ['critical', 'standard', 'nice-to-have'];
    expect(priorities).toHaveLength(3);
    for (const p of priorities) {
      expect(isFeaturePriority(p)).toBe(true);
    }
  });

  it('rejects invalid priority values at runtime', () => {
    expect(isFeaturePriority('low')).toBe(false);
    expect(isFeaturePriority('high')).toBe(false);
    expect(isFeaturePriority(null)).toBe(false);
  });
});

describe('ComponentRole union type', () => {
  it('accepts all valid role values', () => {
    const roles: ComponentRole[] = ['implementation', 'ui', 'data', 'utility'];
    expect(roles).toHaveLength(4);
    for (const r of roles) {
      expect(isComponentRole(r)).toBe(true);
    }
  });

  it('rejects invalid role values at runtime', () => {
    expect(isComponentRole('service')).toBe(false);
    expect(isComponentRole('')).toBe(false);
  });
});

describe('DependencyType union type', () => {
  it('accepts all valid dependency types', () => {
    const types: DependencyType[] = ['requires', 'enhances', 'replaces'];
    expect(types).toHaveLength(3);
    for (const t of types) {
      expect(isDependencyType(t)).toBe(true);
    }
  });

  it('rejects invalid dependency types at runtime', () => {
    expect(isDependencyType('uses')).toBe(false);
    expect(isDependencyType(null)).toBe(false);
  });
});

describe('ChangeType union type', () => {
  it('accepts all valid change types', () => {
    const types: ChangeType[] = ['created', 'updated', 'deprecated', 'removed', 'restored'];
    expect(types).toHaveLength(5);
    for (const t of types) {
      expect(isChangeType(t)).toBe(true);
    }
  });

  it('rejects invalid change types at runtime', () => {
    expect(isChangeType('deleted')).toBe(false);
    expect(isChangeType('modified')).toBe(false);
    expect(isChangeType(null)).toBe(false);
  });
});

// ------------------------------------
// Interface conformance tests
// ------------------------------------

describe('Feature interface', () => {
  it('accepts a fully populated Feature object', () => {
    const feature: Feature = {
      id: 1,
      feature_key: 'auth.login',
      domain: 'auth',
      subdomain: 'session',
      title: 'User Login',
      description: 'Handles user authentication',
      status: 'active',
      priority: 'critical',
      portal_scope: ['internal', 'external'],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-15T00:00:00Z',
      removed_at: null,
      removed_reason: null,
    };

    expect(isFeature(feature)).toBe(true);
    expect(feature.id).toBe(1);
    expect(feature.feature_key).toBe('auth.login');
    expect(feature.portal_scope).toEqual(['internal', 'external']);
    expect(feature.removed_at).toBeNull();
  });

  it('accepts a Feature with null optional fields', () => {
    const feature: Feature = {
      id: 2,
      feature_key: 'product.list',
      domain: 'product',
      subdomain: null,
      title: 'Product List',
      description: null,
      status: 'deprecated',
      priority: 'standard',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: '2026-02-01T00:00:00Z',
      removed_reason: 'Feature deprecated in v2',
    };

    expect(isFeature(feature)).toBe(true);
    expect(feature.subdomain).toBeNull();
    expect(feature.description).toBeNull();
    expect(feature.removed_at).toBe('2026-02-01T00:00:00Z');
  });
});

describe('FeatureInput interface', () => {
  it('accepts a minimal FeatureInput (required fields only)', () => {
    const input: FeatureInput = {
      feature_key: 'auth.logout',
      domain: 'auth',
      title: 'User Logout',
    };

    expect(input.feature_key).toBe('auth.logout');
    expect(input.domain).toBe('auth');
    expect(input.title).toBe('User Logout');
    expect(input.subdomain).toBeUndefined();
    expect(input.status).toBeUndefined();
  });

  it('accepts a fully populated FeatureInput', () => {
    const input: FeatureInput = {
      feature_key: 'product.search',
      domain: 'product',
      subdomain: 'catalog',
      title: 'Product Search',
      description: 'Full-text search for products',
      status: 'active',
      priority: 'standard',
      portal_scope: ['internal'],
    };

    expect(input.subdomain).toBe('catalog');
    expect(input.status).toBe('active');
    expect(input.portal_scope).toEqual(['internal']);
  });
});

describe('FeatureComponent interface', () => {
  it('accepts a valid FeatureComponent object', () => {
    const component: FeatureComponent = {
      id: 10,
      feature_id: 1,
      component_file: 'src/components/Login.tsx',
      component_name: 'LoginForm',
      role: 'ui',
      is_primary: true,
    };

    expect(component.id).toBe(10);
    expect(component.feature_id).toBe(1);
    expect(component.component_file).toBe('src/components/Login.tsx');
    expect(isComponentRole(component.role)).toBe(true);
    expect(component.is_primary).toBe(true);
  });

  it('accepts a FeatureComponent with null component_name', () => {
    const component: FeatureComponent = {
      id: 11,
      feature_id: 2,
      component_file: 'src/utils/auth-helpers.ts',
      component_name: null,
      role: 'utility',
      is_primary: false,
    };

    expect(component.component_name).toBeNull();
    expect(component.is_primary).toBe(false);
  });
});

describe('FeatureProcedure interface', () => {
  it('accepts a valid FeatureProcedure object', () => {
    const procedure: FeatureProcedure = {
      id: 20,
      feature_id: 1,
      router_name: 'auth',
      procedure_name: 'login',
      procedure_type: 'mutation',
    };

    expect(procedure.router_name).toBe('auth');
    expect(procedure.procedure_name).toBe('login');
    expect(procedure.procedure_type).toBe('mutation');
  });

  it('accepts a FeatureProcedure with null procedure_type', () => {
    const procedure: FeatureProcedure = {
      id: 21,
      feature_id: 1,
      router_name: 'auth',
      procedure_name: 'getSession',
      procedure_type: null,
    };

    expect(procedure.procedure_type).toBeNull();
  });
});

describe('FeaturePage interface', () => {
  it('accepts a valid FeaturePage object', () => {
    const page: FeaturePage = {
      id: 30,
      feature_id: 1,
      page_route: '/login',
      portal: 'external',
    };

    expect(page.page_route).toBe('/login');
    expect(page.portal).toBe('external');
  });

  it('accepts a FeaturePage with null portal', () => {
    const page: FeaturePage = {
      id: 31,
      feature_id: 1,
      page_route: '/admin/dashboard',
      portal: null,
    };

    expect(page.portal).toBeNull();
  });
});

describe('FeatureDep interface', () => {
  it('accepts a valid FeatureDep object', () => {
    const dep: FeatureDep = {
      id: 40,
      feature_id: 2,
      depends_on_feature_id: 1,
      dependency_type: 'requires',
    };

    expect(dep.feature_id).toBe(2);
    expect(dep.depends_on_feature_id).toBe(1);
    expect(isDependencyType(dep.dependency_type)).toBe(true);
  });

  it('accepts all dependency types in FeatureDep', () => {
    const types: DependencyType[] = ['requires', 'enhances', 'replaces'];
    for (const depType of types) {
      const dep: FeatureDep = {
        id: 1,
        feature_id: 1,
        depends_on_feature_id: 2,
        dependency_type: depType,
      };
      expect(isDependencyType(dep.dependency_type)).toBe(true);
    }
  });
});

describe('FeatureChangeLog interface', () => {
  it('accepts a valid FeatureChangeLog object', () => {
    const log: FeatureChangeLog = {
      id: 50,
      feature_id: 1,
      change_type: 'created',
      changed_by: 'scanner',
      change_detail: 'Auto-discovered feature',
      commit_hash: 'abc123def456',
      created_at: '2026-01-01T00:00:00Z',
    };

    expect(isChangeType(log.change_type)).toBe(true);
    expect(log.changed_by).toBe('scanner');
  });

  it('accepts a FeatureChangeLog with all nullable fields null', () => {
    const log: FeatureChangeLog = {
      id: 51,
      feature_id: 1,
      change_type: 'updated',
      changed_by: null,
      change_detail: null,
      commit_hash: null,
      created_at: '2026-02-01T00:00:00Z',
    };

    expect(log.changed_by).toBeNull();
    expect(log.change_detail).toBeNull();
    expect(log.commit_hash).toBeNull();
  });
});

describe('FeatureWithCounts interface', () => {
  it('extends Feature with count fields', () => {
    const featureWithCounts: FeatureWithCounts = {
      id: 1,
      feature_key: 'auth.login',
      domain: 'auth',
      subdomain: null,
      title: 'User Login',
      description: null,
      status: 'active',
      priority: 'critical',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      removed_reason: null,
      component_count: 3,
      procedure_count: 2,
      page_count: 1,
    };

    expect(isFeature(featureWithCounts)).toBe(true);
    expect(featureWithCounts.component_count).toBe(3);
    expect(featureWithCounts.procedure_count).toBe(2);
    expect(featureWithCounts.page_count).toBe(1);
  });

  it('accepts zero counts', () => {
    const featureWithCounts: FeatureWithCounts = {
      id: 2,
      feature_key: 'empty.feature',
      domain: 'test',
      subdomain: null,
      title: 'Empty Feature',
      description: null,
      status: 'planned',
      priority: 'nice-to-have',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      removed_reason: null,
      component_count: 0,
      procedure_count: 0,
      page_count: 0,
    };

    expect(featureWithCounts.component_count).toBe(0);
    expect(featureWithCounts.procedure_count).toBe(0);
    expect(featureWithCounts.page_count).toBe(0);
  });
});

describe('FeatureDetail interface', () => {
  it('extends Feature with related entity arrays', () => {
    const detail: FeatureDetail = {
      id: 1,
      feature_key: 'auth.login',
      domain: 'auth',
      subdomain: null,
      title: 'User Login',
      description: null,
      status: 'active',
      priority: 'critical',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      removed_reason: null,
      components: [
        {
          id: 1,
          feature_id: 1,
          component_file: 'src/Login.tsx',
          component_name: 'Login',
          role: 'ui',
          is_primary: true,
        },
      ],
      procedures: [
        {
          id: 1,
          feature_id: 1,
          router_name: 'auth',
          procedure_name: 'login',
          procedure_type: 'mutation',
        },
      ],
      pages: [
        {
          id: 1,
          feature_id: 1,
          page_route: '/login',
          portal: 'external',
        },
      ],
      dependencies: [
        {
          id: 1,
          feature_id: 1,
          depends_on_feature_id: 2,
          dependency_type: 'requires',
        },
      ],
      changelog: [
        {
          id: 1,
          feature_id: 1,
          change_type: 'created',
          changed_by: 'scanner',
          change_detail: null,
          commit_hash: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    };

    expect(isFeature(detail)).toBe(true);
    expect(detail.components).toHaveLength(1);
    expect(detail.procedures).toHaveLength(1);
    expect(detail.pages).toHaveLength(1);
    expect(detail.dependencies).toHaveLength(1);
    expect(detail.changelog).toHaveLength(1);
  });

  it('accepts empty arrays for all related entities', () => {
    const detail: FeatureDetail = {
      id: 2,
      feature_key: 'new.feature',
      domain: 'test',
      subdomain: null,
      title: 'New Feature',
      description: null,
      status: 'planned',
      priority: 'standard',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      removed_reason: null,
      components: [],
      procedures: [],
      pages: [],
      dependencies: [],
      changelog: [],
    };

    expect(detail.components).toHaveLength(0);
    expect(detail.procedures).toHaveLength(0);
    expect(detail.dependencies).toHaveLength(0);
  });
});

describe('ImpactItem interface', () => {
  it('accepts a valid ImpactItem with orphaned status', () => {
    const baseFeature: Feature = {
      id: 1,
      feature_key: 'auth.login',
      domain: 'auth',
      subdomain: null,
      title: 'User Login',
      description: null,
      status: 'active',
      priority: 'critical',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      removed_reason: null,
    };

    const item: ImpactItem = {
      feature: baseFeature,
      affected_files: ['src/Login.tsx'],
      remaining_files: [],
      status: 'orphaned',
    };

    expect(item.status).toBe('orphaned');
    expect(item.affected_files).toHaveLength(1);
    expect(item.remaining_files).toHaveLength(0);
  });

  it('accepts all ImpactItem status values', () => {
    const statuses: ImpactItem['status'][] = ['orphaned', 'degraded', 'unaffected'];
    for (const status of statuses) {
      expect(['orphaned', 'degraded', 'unaffected'].includes(status)).toBe(true);
    }
  });
});

describe('ImpactReport interface', () => {
  it('accepts a valid ImpactReport', () => {
    const report: ImpactReport = {
      files_analyzed: ['src/Login.tsx', 'src/helpers.ts'],
      orphaned: [],
      degraded: [],
      unaffected: [],
      blocked: false,
      block_reason: null,
    };

    expect(report.files_analyzed).toHaveLength(2);
    expect(report.blocked).toBe(false);
    expect(report.block_reason).toBeNull();
  });

  it('accepts a blocked ImpactReport', () => {
    const report: ImpactReport = {
      files_analyzed: ['src/Login.tsx'],
      orphaned: [],
      degraded: [],
      unaffected: [],
      blocked: true,
      block_reason: 'Critical feature auth.login is orphaned',
    };

    expect(report.blocked).toBe(true);
    expect(report.block_reason).toBe('Critical feature auth.login is orphaned');
  });
});

describe('ValidationItem interface', () => {
  it('accepts a valid ValidationItem', () => {
    const baseFeature: Feature = {
      id: 1,
      feature_key: 'auth.login',
      domain: 'auth',
      subdomain: null,
      title: 'User Login',
      description: null,
      status: 'active',
      priority: 'critical',
      portal_scope: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      removed_reason: null,
    };

    const item: ValidationItem = {
      feature: baseFeature,
      missing_components: ['src/Login.tsx'],
      missing_procedures: [{ router: 'auth', procedure: 'login' }],
      missing_pages: ['/login'],
      status: 'degraded',
    };

    expect(item.status).toBe('degraded');
    expect(item.missing_components).toHaveLength(1);
    expect(item.missing_procedures[0]).toEqual({ router: 'auth', procedure: 'login' });
  });

  it('accepts all ValidationItem status values', () => {
    const statuses: ValidationItem['status'][] = ['alive', 'orphaned', 'degraded'];
    for (const status of statuses) {
      expect(['alive', 'orphaned', 'degraded'].includes(status)).toBe(true);
    }
  });
});

describe('ValidationReport interface', () => {
  it('accepts a valid ValidationReport', () => {
    const report: ValidationReport = {
      alive: 5,
      orphaned: 1,
      degraded: 2,
      details: [],
    };

    expect(report.alive).toBe(5);
    expect(report.orphaned).toBe(1);
    expect(report.degraded).toBe(2);
    expect(Array.isArray(report.details)).toBe(true);
  });

  it('accepts a zero-count ValidationReport', () => {
    const report: ValidationReport = {
      alive: 0,
      orphaned: 0,
      degraded: 0,
      details: [],
    };

    expect(report.alive + report.orphaned + report.degraded).toBe(0);
  });
});

describe('ParityItem interface', () => {
  it('accepts all ParityItem status values', () => {
    const statuses: ParityItem['status'][] = ['DONE', 'GAP', 'NEW'];
    for (const status of statuses) {
      const item: ParityItem = {
        feature_key: 'test.feature',
        title: 'Test Feature',
        status,
        old_files: ['src/old.ts'],
        new_files: ['src/new.ts'],
      };
      expect(['DONE', 'GAP', 'NEW'].includes(item.status)).toBe(true);
    }
  });

  it('accepts a ParityItem with empty file arrays', () => {
    const item: ParityItem = {
      feature_key: 'new.feature',
      title: 'New Feature',
      status: 'NEW',
      old_files: [],
      new_files: ['src/new-feature.ts'],
    };

    expect(item.old_files).toHaveLength(0);
    expect(item.new_files).toHaveLength(1);
  });
});

describe('ParityReport interface', () => {
  it('accepts a valid ParityReport', () => {
    const report: ParityReport = {
      done: [],
      gaps: [],
      new_features: [],
      parity_percentage: 100,
    };

    expect(report.parity_percentage).toBe(100);
    expect(Array.isArray(report.done)).toBe(true);
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(Array.isArray(report.new_features)).toBe(true);
  });

  it('accepts a partial parity percentage', () => {
    const report: ParityReport = {
      done: [],
      gaps: [],
      new_features: [],
      parity_percentage: 66.67,
    };

    expect(report.parity_percentage).toBeCloseTo(66.67);
  });
});

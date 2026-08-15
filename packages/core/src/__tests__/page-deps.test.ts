// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, vi } from 'vitest';
import { deriveRoute, derivePortal } from '../page-deps.ts';

// The pages dir is DECLARED, not compiled in (plan-2026-08-13-index-builder-
// input-contracts, Q4). These cases used to read the ambient repo config and so
// silently asserted whatever layout the repo happened to have; they now state
// the layout they are testing.
vi.mock('../config.ts', () => ({
  getConfig: () => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript' },
    paths: { source: 'src', pages: 'src/app', aliases: {} },
    domains: [],
  }),
  getProjectRoot: () => '/test/project',
  getResolvedPaths: () => ({ extensions: ['.ts', '.tsx', '.js', '.jsx'] }),
}));

describe('deriveRoute', () => {
  it('derives root route', () => {
    expect(deriveRoute('src/app/page.tsx')).toBe('/');
  });

  it('derives simple route', () => {
    expect(deriveRoute('src/app/orders/page.tsx')).toBe('/orders');
  });

  it('derives nested route', () => {
    expect(deriveRoute('src/app/orders/[id]/page.tsx')).toBe('/orders/[id]');
  });

  it('derives deeply nested route', () => {
    expect(deriveRoute('src/app/admin/settings/security/page.tsx')).toBe('/admin/settings/security');
  });

  it('handles dynamic segments', () => {
    expect(deriveRoute('src/app/products/[id]/edit/page.tsx')).toBe('/products/[id]/edit');
  });

  it('leaves a path outside the declared pages dir alone', () => {
    // The prefix stripped is the DECLARED one. A page file from some other tree
    // is not silently re-rooted — it comes back unchanged apart from the
    // `/page.tsx` suffix, which is the honest answer for "not one of my pages".
    expect(deriveRoute('website/src/app/orders/page.tsx')).toBe('website/src/app/orders');
  });
});

describe('deriveRoute follows the DECLARED pages dir, not a compiled-in one', () => {
  it('strips a monorepo pages dir', async () => {
    // The regression guard for Q4: with `src/app` hardcoded, this returned
    // `website/src/app/orders` and every route in a monorepo carried its
    // directory prefix. Re-imported under a different declared layout so the
    // derivation is proven to FOLLOW the declaration rather than match it once.
    vi.resetModules();
    vi.doMock('../config.ts', () => ({
      getConfig: () => ({
        toolPrefix: 'massu',
        framework: { type: 'typescript' },
        paths: { source: 'website', pages: 'website/src/app', aliases: {} },
        domains: [],
      }),
      getProjectRoot: () => '/test/project',
      getResolvedPaths: () => ({ extensions: ['.ts', '.tsx', '.js', '.jsx'] }),
    }));

    const { deriveRoute: derive } = await import('../page-deps.ts');
    expect(derive('website/src/app/orders/page.tsx')).toBe('/orders');
    expect(derive('website/src/app/page.tsx')).toBe('/');

    vi.doUnmock('../config.ts');
    vi.resetModules();
  });
});

describe('derivePortal', () => {
  // Without accessScopes in config, derivePortal returns the first path segment

  it('identifies admin portal', () => {
    expect(derivePortal('/admin/settings')).toBe('admin');
  });

  it('uses first path segment as scope', () => {
    expect(derivePortal('/portal/orders')).toBe('portal');
  });

  it('identifies designer portal', () => {
    expect(derivePortal('/designer/projects')).toBe('designer');
  });

  it('identifies factory portal', () => {
    expect(derivePortal('/factory/orders')).toBe('factory');
  });

  it('identifies QC portal', () => {
    expect(derivePortal('/qc/inspections')).toBe('qc');
  });

  it('uses first segment for production routes', () => {
    expect(derivePortal('/production/orders')).toBe('production');
  });

  it('uses first segment for top-level routes', () => {
    expect(derivePortal('/orders')).toBe('orders');
    expect(derivePortal('/products')).toBe('products');
  });
});

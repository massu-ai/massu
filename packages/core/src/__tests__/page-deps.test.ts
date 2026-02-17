// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { deriveRoute, derivePortal } from '../page-deps.ts';

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

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { matchRules, globMatch } from '../rules.ts';

describe('globMatch', () => {
  it('matches simple glob patterns', () => {
    expect(globMatch('src/server/api/routers/orders.ts', 'src/server/api/routers/**')).toBe(true);
    expect(globMatch('src/components/orders/OrderCard.tsx', 'src/components/**')).toBe(true);
    expect(globMatch('src/app/orders/page.tsx', 'src/app/**/page.tsx')).toBe(true);
  });

  it('matches wildcard table name patterns', () => {
    expect(globMatch('src/server/api/routers/unified_products.ts', '**/unified_products**')).toBe(true);
    expect(globMatch('src/lib/unified_products/helpers.ts', '**/unified_products**')).toBe(true);
  });

  it('rejects non-matching paths', () => {
    expect(globMatch('src/lib/utils.ts', 'src/server/api/routers/**')).toBe(false);
    expect(globMatch('package.json', 'src/components/**')).toBe(false);
  });

  it('matches middleware.ts exactly', () => {
    expect(globMatch('src/middleware.ts', 'src/middleware.ts')).toBe(true);
    expect(globMatch('src/other-middleware.ts', 'src/middleware.ts')).toBe(false);
  });
});

describe('matchRules', () => {
  // These tests validate against Massu's own config rules:
  //   src/**/*.ts -> ESM imports, better-sqlite3
  //   src/hooks/**/*.ts -> stdin/stdout JSON, exit within 5 seconds, no heavy deps

  it('returns rules for TypeScript source files', () => {
    const rules = matchRules('src/config.ts');
    expect(rules.length).toBeGreaterThan(0);
    const allRuleTexts = rules.flatMap(r => r.rules);
    expect(allRuleTexts.some(r => r.includes('ESM'))).toBe(true);
  });

  it('returns hook-specific rules for hook files', () => {
    const rules = matchRules('src/hooks/post-edit-context.ts');
    // Should match both src/**/*.ts AND src/hooks/**/*.ts patterns
    expect(rules.length).toBeGreaterThanOrEqual(2);
    const allRuleTexts = rules.flatMap(r => r.rules);
    expect(allRuleTexts.some(r => r.includes('stdin'))).toBe(true);
    expect(allRuleTexts.some(r => r.includes('5 seconds'))).toBe(true);
  });

  it('returns no rules for non-matching paths', () => {
    const rules = matchRules('package.json');
    expect(rules.length).toBe(0);
  });

  it('returns rules for deeply nested src files', () => {
    const rules = matchRules('src/deep/nested/module.ts');
    expect(rules.length).toBeGreaterThan(0);
    const allRuleTexts = rules.flatMap(r => r.rules);
    expect(allRuleTexts.some(r => r.includes('better-sqlite3'))).toBe(true);
  });
});

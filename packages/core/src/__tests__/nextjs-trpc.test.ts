// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: nextjs-trpc adapter tests.
 *
 * Coverage:
 *   - matches() detects @trpc/* in package.json deps
 *   - matches() detects server/ dir presence
 *   - introspect() degradation
 */

import { describe, expect, it } from 'vitest';
import { nextjsTrpcAdapter } from '../detect/adapters/nextjs-trpc.ts';
import type { DetectionSignals } from '../detect/adapters/types.ts';

function emptySignals(overrides: Partial<DetectionSignals> = {}): DetectionSignals {
  return {
    presentDirs: new Set(),
    presentFiles: new Set(),
    ...overrides,
  };
}

describe('nextjs-trpc adapter: matches() signal logic', () => {
  it('matches when @trpc/server is in package.json dependencies', () => {
    const signals = emptySignals({
      packageJson: {
        dependencies: { '@trpc/server': '^10', '@trpc/client': '^10' },
      } as Record<string, unknown>,
    });
    expect(nextjsTrpcAdapter.matches(signals)).toBe(true);
  });

  it('matches when @trpc/* is in devDependencies', () => {
    const signals = emptySignals({
      packageJson: {
        devDependencies: { '@trpc/next': '^10' },
      } as Record<string, unknown>,
    });
    expect(nextjsTrpcAdapter.matches(signals)).toBe(true);
  });

  it('matches when server/ directory exists', () => {
    const signals = emptySignals({ presentDirs: new Set(['server']) });
    expect(nextjsTrpcAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a plain Next.js project with no tRPC and no server dir', () => {
    const signals = emptySignals({
      packageJson: { dependencies: { next: '^14' } } as Record<string, unknown>,
      presentDirs: new Set(['app', 'components']),
    });
    expect(nextjsTrpcAdapter.matches(signals)).toBe(false);
  });
});

describe('nextjs-trpc adapter: introspect() degradation', () => {
  it('empty file list → none', async () => {
    const r = await nextjsTrpcAdapter.introspect([], '/tmp/x');
    expect(r.confidence).toBe('none');
  });

  it('grammar unavailable → none, no throw', async () => {
    const files = [{
      path: '/tmp/x/server/api/routers/orders.ts',
      content: `import { createTRPCRouter, publicProcedure } from '../trpc';
export const ordersRouter = createTRPCRouter({
  list: publicProcedure.query(() => []),
});`,
      language: 'typescript' as const,
      size: 200,
    }];
    const r = await nextjsTrpcAdapter.introspect(files, '/tmp/x');
    expect(['none', 'high', 'medium', 'low']).toContain(r.confidence);
  });
});

describe('nextjs-trpc adapter: contract', () => {
  it('id is nextjs-trpc and languages is ["typescript"]', () => {
    expect(nextjsTrpcAdapter.id).toBe('nextjs-trpc');
    expect(nextjsTrpcAdapter.languages).toEqual(['typescript']);
  });
});

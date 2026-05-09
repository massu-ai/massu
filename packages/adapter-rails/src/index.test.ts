// Smoke-test only. Behavioral tests for this adapter live at
// `packages/core/src/__tests__/rails.test.ts` — that file is the canonical
// test surface. This smoke test exists to validate that the workspace
// package's own dist/index.js loads, exports the expected adapter, and
// produces the same 'high' verdict as the strict gate at
// `packages/core/src/__tests__/adapter-grammar-strict.test.ts:60`.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceFile } from '@massu/core/adapter';
import { railsAdapter } from './index.ts';

describe('@massu/adapter-rails smoke test', () => {
  it('exports an adapter with id "rails" and language "ruby"', () => {
    expect(railsAdapter.id).toBe('rails');
    expect(railsAdapter.languages).toEqual(['ruby']);
    expect(typeof railsAdapter.matches).toBe('function');
    expect(typeof railsAdapter.introspect).toBe('function');
  });

  it('returns "high" confidence on clear-cut Rails routes.rb fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-adapter-rails-smoke-'));
    try {
      const relPath = 'config/routes.rb';
      const content = `Rails.application.routes.draw do
  get '/health', to: 'health#show'
  namespace :api do
    resources :users
  end
  root 'pages#home'
end
`;
      const fullPath = join(root, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      const file: SourceFile = {
        path: fullPath,
        content,
        language: 'ruby',
        size: Buffer.byteLength(content, 'utf-8'),
      };
      const result = await railsAdapter.introspect([file], root);
      expect(result.confidence).toBe('high');
      expect(Object.keys(result.conventions).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

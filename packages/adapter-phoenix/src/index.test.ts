// Smoke-test only. Behavioral tests for this adapter live at
// `packages/core/src/__tests__/phoenix.test.ts` — that file is the canonical
// test surface. This smoke test exists to validate that the workspace
// package's own dist/index.js loads, exports the expected adapter, and
// produces the same 'high' verdict as the strict gate at
// `packages/core/src/__tests__/adapter-grammar-strict.test.ts:107`.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceFile } from '@massu/core/adapter';
import { phoenixAdapter } from './index.ts';

describe('@massu/adapter-phoenix smoke test', () => {
  it('exports an adapter with id "phoenix" and language "elixir"', () => {
    expect(phoenixAdapter.id).toBe('phoenix');
    expect(phoenixAdapter.languages).toEqual(['elixir']);
    expect(typeof phoenixAdapter.matches).toBe('function');
    expect(typeof phoenixAdapter.introspect).toBe('function');
  });

  it('returns "high" confidence on clear-cut Phoenix router.ex fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-adapter-phoenix-smoke-'));
    try {
      const relPath = 'lib/my_app_web/router.ex';
      const content = `defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/api", MyAppWeb do
    get "/health", HealthController, :show
  end
end
`;
      const fullPath = join(root, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      const file: SourceFile = {
        path: fullPath,
        content,
        language: 'elixir',
        size: Buffer.byteLength(content, 'utf-8'),
      };
      const result = await phoenixAdapter.introspect([file], root);
      expect(result.confidence).toBe('high');
      expect(Object.keys(result.conventions).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

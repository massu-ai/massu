// Smoke-test only. Behavioral tests for this adapter live at
// `packages/core/src/__tests__/go-chi.test.ts` — that file is the canonical
// test surface. This smoke test exists to validate that the workspace
// package's own dist/index.js loads, exports the expected adapter, and
// produces the same 'high' verdict as the strict gate at
// `packages/core/src/__tests__/adapter-grammar-strict.test.ts:120`.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceFile } from '@massu/core/adapter';
import { goChiAdapter } from './index.ts';

describe('@massu/adapter-go-chi smoke test', () => {
  it('exports an adapter with id "go-chi" and language "go"', () => {
    expect(goChiAdapter.id).toBe('go-chi');
    expect(goChiAdapter.languages).toEqual(['go']);
    expect(typeof goChiAdapter.matches).toBe('function');
    expect(typeof goChiAdapter.introspect).toBe('function');
  });

  it('returns "high" confidence on clear-cut Go Chi router fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-adapter-go-chi-smoke-'));
    try {
      const relPath = 'internal/api/router.go';
      const content = `package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func NewRouter() http.Handler {
    r := chi.NewRouter()
    r.Use(middleware.Logger)
    r.Get("/users", func(w http.ResponseWriter, req *http.Request) {})
    r.Mount("/api/v1", apiHandler())
    return r
}

func apiHandler() http.Handler { return nil }
`;
      const fullPath = join(root, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      const file: SourceFile = {
        path: fullPath,
        content,
        language: 'go',
        size: Buffer.byteLength(content, 'utf-8'),
      };
      const result = await goChiAdapter.introspect([file], root);
      expect(result.confidence).toBe('high');
      expect(Object.keys(result.conventions).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

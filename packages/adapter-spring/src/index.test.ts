// Smoke-test only. Behavioral tests for this adapter live at
// `packages/core/src/__tests__/spring.test.ts` — that file is the canonical
// test surface. This smoke test exists to validate that the workspace
// package's own dist/index.js loads, exports the expected adapter, and
// produces the same 'high' verdict as the strict gate at
// `packages/core/src/__tests__/adapter-grammar-strict.test.ts:72`.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceFile } from '@massu/core/adapter';
import { springAdapter } from './index.ts';

describe('@massu/adapter-spring smoke test', () => {
  it('exports an adapter with id "spring" and language "java"', () => {
    expect(springAdapter.id).toBe('spring');
    expect(springAdapter.languages).toEqual(['java']);
    expect(typeof springAdapter.matches).toBe('function');
    expect(typeof springAdapter.introspect).toBe('function');
  });

  it('returns "high" confidence on clear-cut Spring controller fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-adapter-spring-smoke-'));
    try {
      const relPath = 'src/main/java/UserController.java';
      const content = `package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/{id}")
    public String getById(@PathVariable Long id) {
        return "";
    }
}
`;
      const fullPath = join(root, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      const file: SourceFile = {
        path: fullPath,
        content,
        language: 'java',
        size: Buffer.byteLength(content, 'utf-8'),
      };
      const result = await springAdapter.introspect([file], root);
      expect(result.confidence).toBe('high');
      expect(Object.keys(result.conventions).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

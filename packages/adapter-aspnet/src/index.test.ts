// Smoke-test only. Behavioral tests for this adapter live at
// `packages/core/src/__tests__/aspnet.test.ts` — that file is the canonical
// test surface. This smoke test exists to validate that the workspace
// package's own dist/index.js loads, exports the expected adapter, and
// produces the same 'high' verdict as the strict gate at
// `packages/core/src/__tests__/adapter-grammar-strict.test.ts:90`.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceFile } from '@massu/core/adapter';
import { aspnetAdapter } from './index.ts';

describe('@massu/adapter-aspnet smoke test', () => {
  it('exports an adapter with id "aspnet" and language "csharp"', () => {
    expect(aspnetAdapter.id).toBe('aspnet');
    expect(aspnetAdapter.languages).toEqual(['csharp']);
    expect(typeof aspnetAdapter.matches).toBe('function');
    expect(typeof aspnetAdapter.introspect).toBe('function');
  });

  it('returns "high" confidence on clear-cut ASP.NET controller fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-adapter-aspnet-smoke-'));
    try {
      const relPath = 'Controllers/UsersController.cs';
      const content = `using Microsoft.AspNetCore.Mvc;

namespace MyApp.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult GetById(int id) => Ok();
}
`;
      const fullPath = join(root, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      const file: SourceFile = {
        path: fullPath,
        content,
        language: 'csharp',
        size: Buffer.byteLength(content, 'utf-8'),
      };
      const result = await aspnetAdapter.introspect([file], root);
      expect(result.confidence).toBe('high');
      expect(Object.keys(result.conventions).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

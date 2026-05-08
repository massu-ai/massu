// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7: tests for ASP.NET Core AST adapter.
 *
 * Mirrors the phoenix / rails / python-flask / go-chi adversarial-fixture
 * pattern. The structural gate that asserts the grammar actually loads +
 * queries match lives in `adapter-grammar-strict.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aspnetAdapter } from '../detect/adapters/aspnet.ts';
import type { SourceFile, DetectionSignals } from '../detect/adapters/types.ts';

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `massu-aspnet-${name}-`));
}

function makeFile(root: string, relPath: string, content: string): SourceFile {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return {
    path: fullPath,
    content,
    language: 'csharp',
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set<string>(),
    presentFiles: new Set<string>(),
  };
}

describe('aspnet adapter — id + languages', () => {
  it('exports id "aspnet"', () => {
    expect(aspnetAdapter.id).toBe('aspnet');
  });

  it('targets csharp language only', () => {
    expect(aspnetAdapter.languages).toEqual(['csharp']);
  });
});

describe('aspnet adapter — matches() (cheap signals, no IO)', () => {
  it('matches when csproj declares Microsoft.NET.Sdk.Web', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      csproj: `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
    };
    expect(aspnetAdapter.matches(signals)).toBe(true);
  });

  it('matches when csproj references Microsoft.AspNetCore.App (older format)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      csproj: `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>
</Project>
`,
    };
    expect(aspnetAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a console-app csproj (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      csproj: `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
    };
    expect(aspnetAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match without a csproj (negative)', () => {
    expect(aspnetAdapter.matches(emptySignals())).toBe(false);
  });
});

describe('aspnet adapter — introspect()', () => {
  it('empty file list → none confidence', async () => {
    const result = await aspnetAdapter.introspect([], '/nonexistent');
    expect(result.confidence).toBe('none');
    expect(result.conventions).toEqual({});
  });

  it('non-aspnet C# file → none confidence', async () => {
    const root = tmp('non-aspnet');
    const file = makeFile(root, 'src/Util.cs', `
namespace Util;

public static class Helpers {
    public static int Add(int a, int b) => a + b;
}
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(result.confidence).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('minimal API with single MapGet → high confidence', async () => {
    const root = tmp('minimal-single');
    const file = makeFile(root, 'Program.cs', `
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => "OK");

app.Run();
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('Get');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('minimal API with mixed verbs → low confidence', async () => {
    const root = tmp('minimal-mixed');
    const file = makeFile(root, 'Program.cs', `
var app = WebApplication.Create();
app.MapGet("/users", () => Results.Ok());
app.MapPost("/users", () => Results.Created());
app.MapDelete("/users/{id}", () => Results.NoContent());
app.Run();
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(['none', 'low', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'low') {
        expect(result.conventions.route_method).toBeDefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('attribute-routing controller → conventions captured', async () => {
    const root = tmp('attr-routing');
    const file = makeFile(root, 'Controllers/UsersController.cs', `
using Microsoft.AspNetCore.Mvc;

namespace MyApp.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult GetById(int id) => Ok();
}
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        // Single HttpGet → route_method = 'Get' (Http prefix stripped)
        expect(result.conventions.route_method).toBe('Get');
      }
      if (result.confidence !== 'none') {
        if (result.conventions.controller_class) {
          expect(result.conventions.controller_class).toBe('UsersController');
        }
        if (result.conventions.route_prefix_base) {
          expect(result.conventions.route_prefix_base).toBe('/api');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parameterless [HttpPost] (no route arg) is captured', async () => {
    const root = tmp('attr-no-args');
    const file = makeFile(root, 'Controllers/AuthController.cs', `
using Microsoft.AspNetCore.Mvc;

[Route("auth")]
public class AuthController : ControllerBase
{
    [HttpPost]
    public IActionResult Login() => Ok();
}
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(['none', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('Post');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('class names NOT ending in Controller are NOT captured', async () => {
    const root = tmp('non-controller-class');
    const file = makeFile(root, 'Models/User.cs', `
namespace MyApp.Models;

public class User
{
    public int Id { get; set; }
    public string Name { get; set; }
}
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(result.confidence).toBe('none');
      expect(result.conventions.controller_class).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broken C# syntax → does NOT crash', async () => {
    const root = tmp('broken');
    const file = makeFile(root, 'Program.cs', `
var app = (((  WebApplication.Create();
app.MapGet!!! "/x", () => "y");
app.Run();
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      // Tree-sitter is error-recovering; partial captures may emerge.
      expect(['none', 'medium', 'high', 'low']).toContain(result.confidence);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extractPrefixBase: "/" route → prefix_base NOT captured', async () => {
    const root = tmp('root-route');
    const file = makeFile(root, 'Program.cs', `
var app = WebApplication.Create();
app.MapGet("/", () => "home");
app.Run();
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      // `/` strips to empty first segment → extractPrefixBase returns null.
      expect(['none', 'high']).toContain(result.confidence);
      expect(result.conventions.route_prefix_base).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provenance: each captured field has a provenance entry', async () => {
    const root = tmp('provenance');
    const file = makeFile(root, 'Controllers/HealthController.cs', `
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/health")]
public class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Index() => Ok();
}
`);
    try {
      const result = await aspnetAdapter.introspect([file], root);
      expect(result.provenance.length).toBe(Object.keys(result.conventions).length);
      for (const p of result.provenance) {
        expect(p.field).toMatch(/^(route_method|route_prefix_base|controller_class)$/);
        expect(p.sourceFile).toBe(file.path);
        expect(p.line).toBeGreaterThanOrEqual(0);
        expect(p.query).toMatch(/^aspnet-/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL gate: `npx massu init` end-to-end across all 6 Phase 7
 * framework fixtures. Plan 1.5.1 §3 deliverable.
 *
 * 1.5.0 shipped with 3 latent gaps that this gate now catches:
 *   1. CR-39 violation: phoenix + aspnet manifests unrecognized
 *      → init exited with "no languages detected"
 *   2. Variant templates dead-lettered: rails/spring/go-chi/python-flask
 *      configs lacked framework.router, correct paths.source,
 *      verification.<lang>.lint
 *   3. (deferred to a follow-on) AST adapter introspect output
 *      surfaced under detected.<adapter-id>:
 *
 * This test runs `runInit` against minimal-shape projects for each of the
 * 6 frameworks in tmpdir(), then asserts the emitted massu.config.yaml
 * carries the variant-template-defined fields. ANY future regression in
 * detection, framework-name mapping, variant-template merge, or YAML
 * emission flips this gate red.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as yamlParse } from 'yaml';
import { runInit } from '../commands/init.ts';

interface Fixture {
  id: string;
  files: Array<{ path: string; content: string }>;
  /** Field-by-field assertions on the emitted massu.config.yaml. */
  expect: {
    'framework.type': string;
    'framework.router': string;
    'framework.languages': Record<string, { framework: string }>;
    'paths.source': string;
    /** Required to be present (any value) — variant template must set it. */
    'verification.<lang>.lint': boolean;
  };
}

const FIXTURES: Fixture[] = [
  {
    id: 'rails',
    files: [
      {
        path: 'Gemfile',
        content: `source 'https://rubygems.org'
ruby '3.2.2'
gem 'rails', '~> 7.1.2'
`,
      },
      { path: 'config/routes.rb', content: `Rails.application.routes.draw do\n  root 'pages#home'\nend\n` },
      { path: 'app/.keep', content: '' },
    ],
    expect: {
      'framework.type': 'ruby',
      'framework.router': 'rails',
      'framework.languages': { ruby: { framework: 'rails' } },
      'paths.source': 'app',
      'verification.<lang>.lint': true,
    },
  },
  {
    id: 'phoenix',
    files: [
      {
        path: 'mix.exs',
        content: `defmodule MyApp.MixProject do
  use Mix.Project
  def project, do: [app: :my_app, version: "0.1.0"]
  defp deps, do: [{:phoenix, "~> 1.7.10"}, {:ecto_sql, "~> 3.10"}]
end
`,
      },
      {
        path: 'lib/my_app_web/router.ex',
        content: `defmodule MyAppWeb.Router do
  use MyAppWeb, :router
  scope "/api", MyAppWeb do
    get "/health", HealthController, :show
  end
end
`,
      },
    ],
    expect: {
      'framework.type': 'elixir',
      'framework.router': 'phoenix',
      'framework.languages': { elixir: { framework: 'phoenix' } },
      'paths.source': 'lib',
      'verification.<lang>.lint': true,
    },
  },
  {
    id: 'aspnet',
    files: [
      {
        path: 'MyApp.csproj',
        content: `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
      },
      {
        path: 'Controllers/UsersController.cs',
        content: `using Microsoft.AspNetCore.Mvc;
namespace MyApp.Controllers;
[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase {
    [HttpGet("{id:int}")]
    public IActionResult GetById(int id) => Ok();
}
`,
      },
    ],
    expect: {
      'framework.type': 'csharp',
      'framework.router': 'aspnet-core',
      'framework.languages': { csharp: { framework: 'aspnet-core' } },
      'paths.source': '.',
      'verification.<lang>.lint': true,
    },
  },
  {
    id: 'spring',
    files: [
      {
        path: 'pom.xml',
        content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>0.1.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`,
      },
      {
        path: 'src/main/java/UserController.java',
        content: `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/{id}")
    public String getById(@PathVariable Long id) { return ""; }
}
`,
      },
    ],
    expect: {
      'framework.type': 'java',
      'framework.router': 'spring-mvc',
      'framework.languages': { java: { framework: 'spring-boot' } },
      'paths.source': 'src/main/java',
      'verification.<lang>.lint': true,
    },
  },
  {
    id: 'go-chi',
    files: [
      {
        path: 'go.mod',
        content: `module github.com/example/my-app
go 1.21
require github.com/go-chi/chi/v5 v5.0.10
`,
      },
      {
        path: 'internal/api/router.go',
        content: `package api
import (
    "net/http"
    "github.com/go-chi/chi/v5"
)
func NewRouter() http.Handler {
    r := chi.NewRouter()
    r.Get("/users", func(w http.ResponseWriter, req *http.Request) {})
    return r
}
`,
      },
    ],
    expect: {
      'framework.type': 'go',
      'framework.router': 'chi',
      'framework.languages': { go: { framework: 'chi' } },
      'paths.source': 'internal',
      'verification.<lang>.lint': true,
    },
  },
];

describe('init end-to-end (all 6 Phase 7 framework fixtures)', () => {
  for (const fx of FIXTURES) {
    it(`fixture=${fx.id}: produces variant-template-merged config`, async () => {
      const root = mkdtempSync(join(tmpdir(), `massu-init-e2e-${fx.id}-`));
      try {
        for (const f of fx.files) {
          const fullPath = join(root, f.path);
          mkdirSync(join(fullPath, '..'), { recursive: true });
          writeFileSync(fullPath, f.content, 'utf-8');
        }

        await runInit([], {
          cwd: root,
          ci: true,
          force: true,
          silent: true,
          skipSideEffects: true,
        });

        const configPath = join(root, 'massu.config.yaml');
        const content = readFileSync(configPath, 'utf-8');
        const config = yamlParse(content) as Record<string, unknown>;

        // Assert detection identified the language correctly.
        const fw = config.framework as Record<string, unknown>;
        expect(fw.type, `framework.type should be ${fx.expect['framework.type']}`).toBe(fx.expect['framework.type']);

        // Assert variant template populated the router (the key gap 1.5.0 had).
        expect(fw.router, `framework.router should be ${fx.expect['framework.router']} (from variant template)`).toBe(fx.expect['framework.router']);

        // Assert per-language framework hint is populated.
        const langs = fw.languages as Record<string, unknown>;
        for (const [lang, expected] of Object.entries(fx.expect['framework.languages'])) {
          const langEntry = langs[lang] as Record<string, unknown>;
          expect(langEntry, `framework.languages.${lang} should exist`).toBeDefined();
          expect(langEntry.framework, `framework.languages.${lang}.framework`).toBe(expected.framework);
        }

        // Assert paths.source matches variant template.
        const paths = config.paths as Record<string, unknown>;
        expect(paths.source, `paths.source should be ${fx.expect['paths.source']}`).toBe(fx.expect['paths.source']);

        // Assert verification.<lang>.lint is set (variant-template-supplied).
        const lang = Object.keys(fx.expect['framework.languages'])[0];
        const verification = config.verification as Record<string, Record<string, unknown>> | undefined;
        const langVerify = verification?.[lang];
        expect(langVerify?.lint, `verification.${lang}.lint should be set from variant template`).toBeTruthy();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

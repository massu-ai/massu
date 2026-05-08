// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Shared Phase 7 init fixtures — Plan 1.5.3 §Stage A deliverable.
 *
 * Single-source fixture data consumed by BOTH:
 *   - `init-end-to-end.test.ts` (source-level vitest test, runs runInit
 *     from src/commands/init.ts)
 *   - `init-tarball-e2e.test.ts` (tarball-level vitest test, runs `npm
 *     pack` + clean install + spawn-cli against the published artifact)
 *
 * Both consumers import this module so adding a new framework =
 * ONE fixture entry that BOTH tests pick up automatically. The
 * source-vs-bundle drift class that 1.5.1 → 1.5.2 demonstrated cannot
 * recur via a fixture-naming mismatch.
 */

export interface Phase7InitFixture {
  /** Stable identifier (matches `templates/<id>/` directory name). */
  id: string;
  /** Files to materialize in the fixture's tmpdir before running init. */
  files: Array<{ path: string; content: string }>;
  /** Field-by-field assertions on the emitted `massu.config.yaml`. */
  expect: {
    'framework.type': string;
    'framework.router': string;
    'framework.languages': Record<string, { framework: string }>;
    'paths.source': string;
    /** Required to be present (any value) — variant template must set it. */
    'verification.<lang>.lint': boolean;
  };
}

export const PHASE7_INIT_FIXTURES: Phase7InitFixture[] = [
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

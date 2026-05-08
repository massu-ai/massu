// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL gate: every shipped first-party AST adapter MUST produce a
 * non-'none' confidence on a clear-cut fixture. Closes the lenient-test-
 * pattern hole that previously allowed grammar-load failures (web-tree-
 * sitter ↔ tree-sitter-wasms ABI mismatch) and bad-node-name query bugs
 * (rails `method_call` typo) to silently degrade adapters to regex-fallback
 * for three commits — see `docs/plans/2026-05-07-massu-to-100-percent.md`
 * Phase 7 retrospective.
 *
 * Per CR-46 / Rule 0 structural drift-prevention: this test makes "AST
 * adapter silently degrades to regex fallback" IMPOSSIBLE TO MERGE. Any
 * future grammar-ABI change, query typo, or wasm-cache corruption flips
 * this gate red.
 *
 * Why the existing per-adapter tests don't suffice (R-011 evidence):
 *   - `go-chi.test.ts:130-134`, `rails.test.ts:163-178`,
 *     `python-flask.test.ts:*` all use the lenient pattern
 *     `expect(['none', 'medium', 'high']).toContain(result.confidence)`.
 *   - That pattern passes whether the grammar loads OR silently fails to
 *     load — because the adapter degrades to 'none' when `loadGrammar()`
 *     throws (rails.ts:166, go-chi.ts:135, python-flask.ts:133).
 *   - The strict assertions in this file (`expect(...).toBe('high')`)
 *     differentiate the two cases.
 *
 * Each test uses a fixture small enough to fit one screen and large enough
 * that the adapter's queries MUST find at least one signal.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { aspnetAdapter } from '../detect/adapters/aspnet.ts';
import { goChiAdapter } from '../detect/adapters/go-chi.ts';
import { springAdapter } from '../detect/adapters/spring.ts';
import { railsAdapter } from '../detect/adapters/rails.ts';
import { phoenixAdapter } from '../detect/adapters/phoenix.ts';
import { pythonFlaskAdapter } from '../detect/adapters/python-flask.ts';
import { pythonFastApiAdapter } from '../detect/adapters/python-fastapi.ts';
import { pythonDjangoAdapter } from '../detect/adapters/python-django.ts';
import { nextjsTrpcAdapter } from '../detect/adapters/nextjs-trpc.ts';
import { swiftSwiftUiAdapter } from '../detect/adapters/swift-swiftui.ts';
import type { CodebaseAdapter, SourceFile } from '../detect/adapters/types.ts';

interface Fixture {
  adapter: CodebaseAdapter;
  relPath: string;
  content: string;
  /** Acceptable confidences for a CLEAR signal. 'none' is NEVER acceptable here. */
  expectIn: ReadonlyArray<'high' | 'medium' | 'low'>;
}

const FIXTURES: Fixture[] = [
  {
    adapter: railsAdapter,
    relPath: 'config/routes.rb',
    content: `Rails.application.routes.draw do
  get '/health', to: 'health#show'
  namespace :api do
    resources :users
  end
  root 'pages#home'
end
`,
    expectIn: ['high'],
  },
  {
    adapter: springAdapter,
    relPath: 'src/main/java/UserController.java',
    content: `package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/{id}")
    public String getById(@PathVariable Long id) {
        return "";
    }
}
`,
    expectIn: ['high'],
  },
  {
    adapter: aspnetAdapter,
    relPath: 'Controllers/UsersController.cs',
    content: `using Microsoft.AspNetCore.Mvc;

namespace MyApp.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult GetById(int id) => Ok();
}
`,
    expectIn: ['high'],
  },
  {
    adapter: phoenixAdapter,
    relPath: 'lib/my_app_web/router.ex',
    content: `defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/api", MyAppWeb do
    get "/health", HealthController, :show
  end
end
`,
    expectIn: ['high'],
  },
  {
    adapter: goChiAdapter,
    relPath: 'internal/api/router.go',
    content: `package api

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
`,
    expectIn: ['high'],
  },
  {
    adapter: pythonFlaskAdapter,
    relPath: 'app/views.py',
    content: `from flask import Blueprint, Flask
from flask_login import login_required

bp = Blueprint('users', __name__, url_prefix='/api')

@bp.route('/me')
@login_required
def me():
    return {}

def create_app():
    app = Flask(__name__)
    return app
`,
    expectIn: ['high'],
  },
  {
    adapter: pythonFastApiAdapter,
    relPath: 'app/routes.py',
    content: `from fastapi import APIRouter, Depends

def get_current_user():
    return None

router = APIRouter(prefix='/api/v1')

@router.get('/me')
async def me(user = Depends(get_current_user)):
    return user
`,
    // python-fastapi may emit medium when only api_prefix found and no
    // distinct auth_dep; high when both. We accept any non-none.
    expectIn: ['high', 'medium'],
  },
  {
    adapter: pythonDjangoAdapter,
    relPath: 'project/views.py',
    content: `from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import ListView

class UserListView(LoginRequiredMixin, ListView):
    model = None

urlpatterns = []
`,
    expectIn: ['high', 'medium'],
  },
  {
    adapter: nextjsTrpcAdapter,
    relPath: 'src/server/api/root.ts',
    content: `import { createTRPCRouter, publicProcedure } from "./trpc";

export const appRouter = createTRPCRouter({
  hello: publicProcedure.query(() => 'world'),
});
`,
    expectIn: ['high', 'medium'],
  },
  {
    adapter: swiftSwiftUiAdapter,
    relPath: 'App/ContentView.swift',
    content: `import SwiftUI
import LocalAuthentication

struct ContentView: View {
    var body: some View {
        NavigationStack {
            Text("Hello")
        }
    }
}

let context = LAContext()
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "auth") { _, _ in }
`,
    expectIn: ['high', 'medium'],
  },
];

function languageOf(adapter: CodebaseAdapter): SourceFile['language'] {
  return adapter.languages[0]!;
}

describe('STRUCTURAL gate: shipped AST adapters produce non-none confidence on clear fixtures', () => {
  for (const fx of FIXTURES) {
    it(`${fx.adapter.id}: introspect() returns one of [${fx.expectIn.join('|')}]`, async () => {
      const root = mkdtempSync(join(tmpdir(), `massu-strict-${fx.adapter.id}-`));
      try {
        const fullPath = join(root, fx.relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, fx.content, 'utf-8');
        const file: SourceFile = {
          path: fullPath,
          content: fx.content,
          language: languageOf(fx.adapter),
          size: Buffer.byteLength(fx.content, 'utf-8'),
        };
        const result = await fx.adapter.introspect([file], root);
        // ASSERTIONS:
        // 1. confidence is NOT 'none' — `'none'` means the adapter silently
        //    degraded (grammar load failed OR queries returned 0 captures).
        //    Either is a structural failure of the AST tier this gate
        //    exists to catch.
        expect(result.confidence).not.toBe('none');
        // 2. confidence is in the per-fixture allowlist — the adapter MUST
        //    classify the clear signal at the expected strength.
        expect(fx.expectIn).toContain(result.confidence);
        // 3. provenance is non-empty when conventions were captured. (If
        //    conventions are empty but confidence != 'none', that's a bug
        //    in the adapter — confidence must derive from non-empty
        //    captures per types.ts:122-126.)
        expect(Object.keys(result.conventions).length).toBeGreaterThan(0);
        expect(result.provenance.length).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

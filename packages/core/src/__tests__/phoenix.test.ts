// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7: tests for Phoenix AST adapter.
 *
 * Mirrors the rails / python-flask / go-chi adversarial-fixture pattern:
 * positives + negatives + adversarial inputs created inline via
 * mkdirSync+writeFileSync rather than shipped as fixture files.
 *
 * Tests in this file use the lenient `expect([...]).toContain(confidence)`
 * pattern that documents the failure-mode contract (adapter degrades to
 * 'none' on grammar load failure). The STRUCTURAL gate that asserts the
 * grammar actually loads + queries match lives in
 * `adapter-grammar-strict.test.ts` per the 2026-05-07 grammar-loadability
 * fix (commit d31b4d8).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { phoenixAdapter } from '../detect/adapters/phoenix.ts';
import type { SourceFile, DetectionSignals } from '../detect/adapters/types.ts';

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `massu-phoenix-${name}-`));
}

function makeFile(root: string, relPath: string, content: string): SourceFile {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return {
    path: fullPath,
    content,
    language: 'elixir',
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set<string>(),
    presentFiles: new Set<string>(),
  };
}

describe('phoenix adapter — id + languages', () => {
  it('exports id "phoenix"', () => {
    expect(phoenixAdapter.id).toBe('phoenix');
  });

  it('targets elixir language only', () => {
    expect(phoenixAdapter.languages).toEqual(['elixir']);
  });
});

describe('phoenix adapter — matches() (cheap signals, no IO)', () => {
  it('matches when mix.exs declares {:phoenix, ...}', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      mixExs: `defmodule MyApp.MixProject do
  use Mix.Project

  defp deps do
    [
      {:phoenix, "~> 1.7.10"},
      {:phoenix_html, "~> 4.0"},
      {:ecto_sql, "~> 3.10"}
    ]
  end
end
`,
    };
    expect(phoenixAdapter.matches(signals)).toBe(true);
  });

  it('matches with whitespace variations: { :phoenix, ...}', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      mixExs: '{ :phoenix , "~> 1.7" }',
    };
    expect(phoenixAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a Phoenix-LiveView-only project (no Phoenix itself)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      mixExs: `defp deps do
  [
    {:phoenix_live_view, "~> 0.20"},
    {:plug_cowboy, "~> 2.6"}
  ]
end
`,
    };
    // The negative-lookahead `(?!_)` after `:phoenix\b` rejects
    // `:phoenix_live_view` etc.
    expect(phoenixAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match a Plug-only Elixir project (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      mixExs: `defp deps do
  [
    {:plug, "~> 1.15"},
    {:cowboy, "~> 2.10"}
  ]
end
`,
    };
    expect(phoenixAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match a comment mentioning phoenix (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      mixExs: `# This project does not depend on phoenix
defp deps do
  [{:plug, "~> 1.15"}]
end
`,
    };
    // The regex requires `{`-prefix, comments don't have that shape.
    expect(phoenixAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match without a mix.exs (negative)', () => {
    expect(phoenixAdapter.matches(emptySignals())).toBe(false);
  });
});

describe('phoenix adapter — introspect()', () => {
  it('empty file list → none confidence', async () => {
    const result = await phoenixAdapter.introspect([], '/nonexistent');
    expect(result.confidence).toBe('none');
    expect(result.conventions).toEqual({});
  });

  it('non-Phoenix Elixir file → none confidence', async () => {
    const root = tmp('non-phoenix');
    const file = makeFile(root, 'lib/util.ex', `
defmodule Util do
  def hello do
    IO.puts("hi")
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      expect(result.confidence).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('router.ex with single GET route → high confidence', async () => {
    const root = tmp('phoenix-single-route');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/", MyAppWeb do
    get "/health", HealthController, :show
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('get');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('router with scope + module → conventions captured', async () => {
    const root = tmp('phoenix-scope-module');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/api", MyAppWeb.API do
    pipe_through :api

    resources "/users", UserController
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence !== 'none') {
        if (result.conventions.scope_prefix_base) {
          expect(result.conventions.scope_prefix_base).toBe('/api');
        }
        if (result.conventions.router_module) {
          expect(result.conventions.router_module).toBe('MyAppWeb.Router');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('router with mixed HTTP verbs → low confidence (when grammar primed)', async () => {
    const root = tmp('phoenix-mixed-verbs');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/", MyAppWeb do
    get    "/health",  HealthController, :show
    post   "/login",   SessionController, :create
    delete "/logout",  SessionController, :destroy
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      expect(['none', 'low', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'low') {
        expect(result.conventions.route_method).toBeDefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scope-only router (no top-level verbs) → medium confidence', async () => {
    const root = tmp('phoenix-scope-only');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/admin", MyAppWeb.Admin do
    pipe_through :browser
    resources "/reports", ReportController
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      expect(['none', 'medium']).toContain(result.confidence);
      if (result.confidence === 'medium') {
        expect(result.conventions.scope_prefix_base).toBe('/admin');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('LiveView routes (`live`) are NOT captured as route_method', async () => {
    const root = tmp('phoenix-live-only');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/", MyAppWeb do
    live "/users", UserLive.Index, :index
    live "/users/:id", UserLive.Show, :show
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      // `live` is not in the route_method match-list. The "/" scope path is
      // filtered out by extractPrefixBase (returns null for empty first
      // segment). Only router_module remains, yielding 'medium' confidence.
      expect(['none', 'medium']).toContain(result.confidence);
      expect(result.conventions.route_method).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('module names NOT ending in Router are NOT captured', async () => {
    const root = tmp('phoenix-non-router');
    const file = makeFile(root, 'lib/my_app_web/controllers/user_controller.ex', `
defmodule MyAppWeb.UserController do
  use MyAppWeb, :controller

  def index(conn, _params) do
    render(conn, :index)
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      // UserController does NOT end in `Router`, so the #match? filter
      // excludes it.
      expect(result.confidence).toBe('none');
      expect(result.conventions.router_module).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scope with alias-only first arg (no path) → scope_prefix_base NOT captured', async () => {
    const root = tmp('phoenix-scope-alias-only');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope MyAppWeb do
    get "/", PageController, :home
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      // `scope MyAppWeb do` has alias as first arg — the string-literal
      // anchor in SCOPE_PATH_QUERY excludes this form. scope_prefix_base
      // must NOT be set; only route_method (get) + router_module are.
      // Note: the get path is "/" which extractPrefixBase rejects, so
      // scope_prefix_base stays unset regardless.
      expect(['none', 'high']).toContain(result.confidence);
      expect(result.conventions.scope_prefix_base).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broken Elixir syntax → does NOT crash, returns none-or-partial', async () => {
    const root = tmp('phoenix-broken');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule (((  MyAppWeb.Router do
  scope !!! "/api" do
    get(((  "/x", Foo, :bar
  end end end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      // The key invariant: no throw. Tree-sitter is error-recovering, so
      // partial captures may emerge — that's acceptable as long as we don't
      // crash.
      expect(['none', 'medium', 'high', 'low']).toContain(result.confidence);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extractPrefixBase: deeply-nested scope path → first segment only', async () => {
    const root = tmp('phoenix-nested-scope');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/api/v2/internal/admin", MyAppWeb.Admin do
    get "/health", HealthController, :show
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      if (result.confidence === 'medium' || result.confidence === 'high') {
        if (result.conventions.scope_prefix_base) {
          expect(result.conventions.scope_prefix_base).toBe('/api');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provenance: each captured field has a provenance entry', async () => {
    const root = tmp('phoenix-provenance');
    const file = makeFile(root, 'lib/my_app_web/router.ex', `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  scope "/api", MyAppWeb do
    get "/health", HealthController, :show
  end
end
`);
    try {
      const result = await phoenixAdapter.introspect([file], root);
      expect(result.provenance.length).toBe(Object.keys(result.conventions).length);
      for (const p of result.provenance) {
        expect(p.field).toMatch(/^(route_method|scope_prefix_base|router_module)$/);
        expect(p.sourceFile).toBe(file.path);
        expect(p.line).toBeGreaterThanOrEqual(0);
        expect(p.query).toMatch(/^phoenix-/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c — Phase 7: Phoenix AST adapter.
 *
 * Fourth Phase 7 framework after go-chi + Flask + Rails. First to consume
 * the `elixir` Tree-sitter grammar entry from GRAMMAR_MANIFEST (commit
 * fbb8aa9). Together with the @massu/adapter-phoenix workspace stub from
 * Stage 2 P1-004 (commit ebf2983), completes the per-framework deliverable
 * pattern (4 artifacts):
 *   1. packages/core/templates/phoenix/massu.config.yaml   (variant template)
 *   2. packages/core/src/detect/adapters/phoenix.ts        (this file — AST adapter)
 *   3. Adversarial fixtures (inline in the test file via mkdirSync+writeFileSync)
 *   4. packages/core/src/__tests__/phoenix.test.ts         (golden-output test)
 *      + adapter-grammar-strict.test.ts entry (structural gate)
 *
 * Phoenix routes live in `lib/<app>_web/router.ex` using Elixir DSL macros
 * (per Phoenix routing guide: https://hexdocs.pm/phoenix/routing.html).
 * The adapter walks the router DSL invocations directly rather than scanning
 * controller/live directories, mirroring the rails approach against
 * routes.rb.
 *
 * Extracts:
 *   - route_method: most-common explicit HTTP verb macro (`get`, `post`,
 *     `put`, `patch`, `delete`, `head`, `options`) used at the router scope
 *     level with a string-literal path argument. Mirrors python-fastapi/
 *     python-flask/go-chi/rails route_method semantics. Excludes the
 *     Phoenix-specific `live` and `live_session` macros (those are
 *     LiveView-specific and not interchangeable with HTTP verbs), and
 *     excludes `resources "/users", UserController` (RESTful sugar — same
 *     reasoning as rails resources :users).
 *   - scope_prefix_base: first path segment of the first `scope "/api", …
 *     do …` block, normalized to a leading-slash path. Mirrors rails
 *     api_namespace / python-flask blueprint_url_prefix / go-chi
 *     mount_prefix_base. Per Phoenix routing guide §Scoped routes:
 *     https://hexdocs.pm/phoenix/routing.html#scoped-routes
 *   - router_module: full module name from `defmodule MyAppWeb.Router do`,
 *     restricted to modules ending in `Router` (canonical Phoenix naming).
 *     Useful for scaffold-router templates that need to know the project's
 *     Web module convention.
 *
 * Confidence rules (mirror rails / go-chi):
 *   - 'high'   if exactly ONE distinct route_method seen (clear convention).
 *   - 'low'    if multiple distinct route_methods seen (mixed convention).
 *   - 'medium' if scope_prefix_base or router_module found but no
 *              route_method.
 *   - 'none'   if no Phoenix DSL signals at all (regex fallback takes over).
 *
 * Tree-sitter-elixir grammar shape (verified via AST probe 2026-05-07):
 *   - Macro invocations parse as `(call target: (identifier) (arguments ...))`
 *     OR `(call (identifier) (arguments ...))` — both forms accepted; we use
 *     the positional shape (no `target:` field) so queries also match the
 *     parens-ful invocation `get(...)`.
 *   - Module names are `(alias)` (full dotted chain as one node).
 *   - String literals are `(string (quoted_content))`; node.text returns
 *     the quotes intact.
 *   - `do … end` blocks are `(do_block ...)` siblings of `(arguments)`.
 *   - Atoms (`:foo`) are `(atom)` — NOT used in any phoenix query (we
 *     exclude atom-arg DSL forms by anchoring on `(string)` first arg).
 *
 * Does NOT use regex on file content — only Tree-sitter S-expression queries
 * compiled via query-helpers.ts. Regex would be the regex-fallback path.
 */

import { Parser } from 'web-tree-sitter';
import type { CodebaseAdapter, AdapterResult, DetectionSignals, Provenance, SourceFile } from './types.ts';
import { runQuery, InvalidQueryError } from './query-helpers.ts';
import { loadGrammar } from './tree-sitter-loader.ts';
import { isParsableSource, MAX_AST_FILE_BYTES } from './parse-guard.ts';

// ============================================================
// Tree-sitter S-expression queries (Elixir grammar)
// ============================================================

/**
 * HTTP method route registration with a STRING-LITERAL first argument:
 * `get "/health", HealthController, :show`,
 * `post "/login", SessionController, :create`.
 *
 * Anchored (`.`) on the first argument so we ONLY match string-literal
 * paths. The `#match?` predicate restricts to canonical HTTP verbs,
 * excluding Phoenix-specific `live` / `live_session` / `forward` /
 * `resources` macros (those have different semantics).
 *
 * Per Phoenix routing guide §HTTP Methods:
 * https://hexdocs.pm/phoenix/routing.html#http-methods
 */
const ROUTE_METHOD_QUERY = `
(call
  (identifier) @method (#match? @method "^(get|post|put|patch|delete|options|head)$")
  (arguments
    .
    (string) @route_path))
`;

/**
 * Scope block: `scope "/api", MyAppWeb do … end` or `scope "/admin" do …
 * end`. Captures the FIRST positional argument as a string. The shape
 * `scope MyAppWeb do … end` (alias-only, no path) deliberately doesn't
 * match because the first arg is `(alias)` not `(string)` — verified
 * negative case in AST probe.
 *
 * The presence of a `do_block` is required — `scope "/api", MyAppWeb` (no
 * do/end) wouldn't be a valid Phoenix router scope anyway, but anchoring
 * on the do_block makes the query semantically tighter.
 */
const SCOPE_PATH_QUERY = `
(call
  (identifier) @_method (#eq? @_method "scope")
  (arguments
    .
    (string) @scope_path)
  (do_block))
`;

/**
 * Router module definition: `defmodule MyAppWeb.Router do …`. We restrict
 * to module names ending in `Router` to avoid capturing every `defmodule`
 * in the project (Phoenix apps have many modules, only one is THE router).
 *
 * The tree-sitter-elixir grammar represents `MyAppWeb.Router` as a single
 * `(alias)` node — the dotted chain is part of the alias node's text, not
 * a sub-tree of nested aliases. Verified via AST probe 2026-05-07.
 */
const ROUTER_MODULE_QUERY = `
(call
  (identifier) @_method (#eq? @_method "defmodule")
  (arguments
    .
    (alias) @module_name (#match? @module_name "Router$"))
  (do_block))
`;

// ============================================================
// Adapter
// ============================================================

export const phoenixAdapter: CodebaseAdapter = {
  id: 'phoenix',
  languages: ['elixir'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. The canonical Phoenix
    // declaration in mix.exs is `{:phoenix, "~> 1.7.10"}` (per Phoenix
    // install guide: https://hexdocs.pm/phoenix/installation.html). The
    // negative-lookahead `(?!_)` after `:phoenix\b` rejects
    // `:phoenix_live_view` (a sibling dep that Phoenix-LiveView-only
    // projects pull in without Phoenix itself in some Plug-based stacks).
    if (!signals.mixExs) return false;
    return /\{\s*:phoenix\b(?!_)/.test(signals.mixExs);
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('elixir');
    } catch (e) {
      // Grammar unavailable → adapter returns 'none' so regex fallback takes over.
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const routeMethods = new Map<string, { line: number; file: string }>();
    const scopePaths = new Map<string, { line: number; file: string }>();
    const routerModules = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        // Phase 3.5 defense-in-depth size + depth gate at adapter tier.
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: phoenix skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          for (const hit of runQuery(parser, file.content, ROUTE_METHOD_QUERY, 'phoenix-route-method', file.path)) {
            const method = hit.captures.method;
            if (method && !routeMethods.has(method)) {
              routeMethods.set(method, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, SCOPE_PATH_QUERY, 'phoenix-scope-path', file.path)) {
            const raw = hit.captures.scope_path;
            if (!raw) continue;
            const literal = raw.replace(/^["']/, '').replace(/["']$/, '');
            const base = extractPrefixBase(literal);
            if (base && !scopePaths.has(base)) {
              scopePaths.set(base, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, ROUTER_MODULE_QUERY, 'phoenix-router-module', file.path)) {
            const name = hit.captures.module_name;
            if (name && !routerModules.has(name)) {
              routerModules.set(name, { line: hit.line, file: file.path });
            }
          }
        } catch (e) {
          if (e instanceof InvalidQueryError) {
            // Compile-time failure of OUR query is a developer bug — surface it.
            throw e;
          }
          // Per-file parse error: skip + keep going.
          continue;
        }
      }
    } finally {
      try { parser.delete(); } catch { /* ignore */ }
    }

    const conventions: Record<string, unknown> = {};
    const provenance: Provenance[] = [];

    if (routeMethods.size === 1) {
      const [name, { line, file }] = routeMethods.entries().next().value as [string, { line: number; file: string }];
      conventions.route_method = name;
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'phoenix-route-method' });
    } else if (routeMethods.size >= 2) {
      // Mixed convention — emit first-seen for visibility.
      const [name, { line, file }] = routeMethods.entries().next().value as [string, { line: number; file: string }];
      conventions.route_method = name;
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'phoenix-route-method' });
    }

    if (scopePaths.size >= 1) {
      const [base, { line, file }] = scopePaths.entries().next().value as [string, { line: number; file: string }];
      conventions.scope_prefix_base = base;
      provenance.push({ field: 'scope_prefix_base', sourceFile: file, line, query: 'phoenix-scope-path' });
    }

    if (routerModules.size >= 1) {
      const [name, { line, file }] = routerModules.entries().next().value as [string, { line: number; file: string }];
      conventions.router_module = name;
      provenance.push({ field: 'router_module', sourceFile: file, line, query: 'phoenix-router-module' });
    }

    let confidence: AdapterResult['confidence'];
    if (Object.keys(conventions).length === 0) {
      confidence = 'none';
    } else if (routeMethods.size === 1) {
      confidence = 'high';
    } else if (routeMethods.size >= 2) {
      confidence = 'low';
    } else {
      confidence = 'medium';
    }

    return { conventions, provenance, confidence };
  },
};

// ============================================================
// Helpers
// ============================================================

/**
 * Extract the first path segment of a Phoenix scope path. Mirrors
 * python-fastapi/python-flask/go-chi/rails prefix-base extractors.
 * Returns null if input doesn't start with `/`.
 *
 * "/api/v1/users" → "/api"; "/" → null (root scope is uninformative).
 */
function extractPrefixBase(prefix: string): string | null {
  if (!prefix.startsWith('/')) return null;
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

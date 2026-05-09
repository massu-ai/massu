// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c — Phase 7: Rails AST adapter.
 *
 * Second Phase 7 framework after go-chi; first to consume the new `ruby`
 * Tree-sitter grammar entry from GRAMMAR_MANIFEST (commit fbb8aa9). Together
 * with the @massu/adapter-rails workspace stub created in Stage 2 P1-004
 * (commit ebf2983), this completes the per-framework deliverable pattern
 * established by Phase 7 commits 1–3:
 *   1. packages/core/templates/rails/massu.config.yaml      (variant template)
 *   2. packages/core/src/detect/adapters/rails.ts           (this file — AST adapter)
 *   3. Adversarial fixtures (inline in the test file via mkdirSync+writeFileSync)
 *   4. packages/core/src/__tests__/rails.test.ts            (golden-output test)
 *
 * Rails uses a DSL-heavy `config/routes.rb` (per Rails routing guide:
 * https://guides.rubyonrails.org/routing.html). The adapter walks the
 * routes.rb DSL invocations directly rather than scanning controller
 * directories, mirroring the go-chi approach against router.go files.
 *
 * Extracts:
 *   - route_method: most-common explicit HTTP verb (`get`, `post`, `put`,
 *     `patch`, `delete`, `head`, `options`) used at TOP LEVEL with a
 *     string-literal path argument. Mirrors python-fastapi/python-flask/
 *     go-chi route_method semantics. Distinct from `resources :users`
 *     RESTful blocks — those imply all seven verbs in one declaration and
 *     should NOT pin the project to one verb. The string-literal anchor
 *     also excludes member/collection block calls like `get :preview`
 *     (where the arg is a symbol, not a string).
 *   - api_namespace: first segment of the first `namespace :foo do …` or
 *     `namespace 'foo' do …` block, normalized to a leading-slash path
 *     (mirrors python-fastapi/flask's blueprint_url_prefix and go-chi's
 *     mount_prefix_base). Per Rails routing guide §3:
 *     https://guides.rubyonrails.org/routing.html#controller-namespaces-and-routing
 *   - root_controller: controller name from `root 'pages#home'` or
 *     `root to: 'pages#home'`. The `Foo#bar` syntax canonically denotes
 *     `FooController#bar`. Useful for scaffold-router/scaffold-page
 *     templates that need to know the project's home route convention.
 *
 * Confidence rules (mirror go-chi):
 *   - 'high'   if exactly ONE distinct route_method seen (clear convention).
 *   - 'low'    if multiple distinct route_methods seen (mixed convention).
 *   - 'medium' if api_namespace or root_controller found but no route_method.
 *   - 'none'   if no Rails DSL signals at all (regex fallback takes over).
 *
 * Does NOT use regex on file content — only Tree-sitter S-expression queries
 * compiled via query-helpers.ts. Regex would be the regex-fallback path.
 */

// Plan 3c Phase 9b P-A-001: workspace adapter consumes `@massu/core/adapter`
// SemVer-stable subpath instead of reaching into core internals.
import { Parser } from 'web-tree-sitter';
import type { CodebaseAdapter, AdapterResult, DetectionSignals, Provenance, SourceFile } from '@massu/core/adapter';
import { runQuery, InvalidQueryError, loadGrammar, isParsableSource, MAX_AST_FILE_BYTES } from '@massu/core/adapter';

// ============================================================
// Tree-sitter S-expression queries (Ruby grammar)
// ============================================================

/**
 * HTTP method route registration with a STRING-LITERAL first argument:
 * `get '/health', to: 'health#show'`, `post "/login", to: 'sessions#create'`.
 *
 * Anchored (`.`) on the first argument so that we ONLY match string-literal
 * paths — symbol arguments (`get :preview` inside a member block) are
 * deliberately excluded because those are nested action declarations, NOT
 * top-level routes.
 *
 * tree-sitter-ruby (v0.20.1, pinned by tree-sitter-wasms@0.1.13) emits
 * `(call method: (identifier) arguments: (argument_list ...))` for the
 * parens-less DSL form `get '/x', ...` AND for the parens-ful `get('/x', ...)`
 * form. Verified by AST probe (2026-05-07): there is NO separate `method_call`
 * node in this grammar — historical web sources mentioning `method_call`
 * refer to a different/older grammar fork.
 */
const ROUTE_METHOD_QUERY = `
(call
  method: (identifier) @method (#match? @method "^(get|post|put|patch|delete|options|head)$")
  arguments: (argument_list
    .
    (string) @route_path))
`;

/**
 * Namespace block: `namespace :api do ... end` or `namespace 'api' do ... end`.
 * Captures the first symbol-or-string argument so we can normalize to a
 * leading-slash path.
 *
 * Rails accepts both `namespace :api` (symbol — canonical) and the rarer
 * `namespace 'api'` (string). Both forms produce a `namespace` identifier
 * call; the first arg differs only in node type.
 */
const NAMESPACE_QUERY = `
(call
  method: (identifier) @_method (#eq? @_method "namespace")
  arguments: (argument_list
    .
    [
      (simple_symbol) @namespace_symbol
      (string) @namespace_string
    ]))
`;

/**
 * Root route: `root 'pages#home'`, `root "pages#home"`, or
 * `root to: 'pages#home'`. We capture the string literal in either the
 * positional or `to:` keyword position; the controller is whatever
 * precedes the `#`.
 *
 * Rails routing guide §2.6:
 * https://guides.rubyonrails.org/routing.html#using-root
 */
const ROOT_ROUTE_QUERY = `
(call
  method: (identifier) @_method (#eq? @_method "root")
  arguments: (argument_list
    .
    (string) @root_target))

(call
  method: (identifier) @_method (#eq? @_method "root")
  arguments: (argument_list
    (pair
      key: (hash_key_symbol) @_key (#eq? @_key "to")
      value: (string) @root_target)))
`;

// ============================================================
// Adapter
// ============================================================

export const railsAdapter: CodebaseAdapter = {
  id: 'rails',
  languages: ['ruby'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. The canonical Rails declaration
    // is `gem 'rails'` in Gemfile (per Rails install guide:
    // https://guides.rubyonrails.org/getting_started.html). The strict
    // `gem ['"]rails['"]` regex deliberately rejects `gem 'rails-api'`,
    // `gem 'rails_admin'`, etc. — those are Rails-adjacent gems that may
    // appear in non-Rails Ruby projects.
    if (!signals.gemfile) return false;
    return /^\s*gem\s+['"]rails['"]/im.test(signals.gemfile);
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('ruby');
    } catch (e) {
      // Grammar unavailable → adapter returns 'none' so regex fallback takes over.
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const routeMethods = new Map<string, { line: number; file: string }>();
    const namespaces = new Map<string, { line: number; file: string }>();
    const rootControllers = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        // Phase 3.5 defense-in-depth size + depth gate at adapter tier.
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: rails skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          for (const hit of runQuery(parser, file.content, ROUTE_METHOD_QUERY, 'rails-route-method', file.path)) {
            const method = hit.captures.method;
            if (method && !routeMethods.has(method)) {
              routeMethods.set(method, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, NAMESPACE_QUERY, 'rails-namespace', file.path)) {
            const symbolRaw = hit.captures.namespace_symbol;
            const stringRaw = hit.captures.namespace_string;
            const name = symbolRaw
              ? symbolRaw.replace(/^:/, '')
              : stringRaw
                ? stringRaw.replace(/^['"]/, '').replace(/['"]$/, '')
                : null;
            if (!name) continue;
            const path = '/' + name;
            if (!namespaces.has(path)) {
              namespaces.set(path, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, ROOT_ROUTE_QUERY, 'rails-root', file.path)) {
            const raw = hit.captures.root_target;
            if (!raw) continue;
            const literal = raw.replace(/^['"]/, '').replace(/['"]$/, '');
            const controller = extractRootController(literal);
            if (controller && !rootControllers.has(controller)) {
              rootControllers.set(controller, { line: hit.line, file: file.path });
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
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'rails-route-method' });
    } else if (routeMethods.size >= 2) {
      // Mixed convention — emit first-seen for visibility.
      const [name, { line, file }] = routeMethods.entries().next().value as [string, { line: number; file: string }];
      conventions.route_method = name;
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'rails-route-method' });
    }

    if (namespaces.size >= 1) {
      const [path, { line, file }] = namespaces.entries().next().value as [string, { line: number; file: string }];
      conventions.api_namespace = path;
      provenance.push({ field: 'api_namespace', sourceFile: file, line, query: 'rails-namespace' });
    }

    if (rootControllers.size >= 1) {
      const [name, { line, file }] = rootControllers.entries().next().value as [string, { line: number; file: string }];
      conventions.root_controller = name;
      provenance.push({ field: 'root_controller', sourceFile: file, line, query: 'rails-root' });
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
 * Extract the controller name from a Rails `controller#action` string.
 * `'pages#home'` → `'pages'`; `'admin/dashboard#index'` → `'admin/dashboard'`.
 * Returns null for malformed input (no `#` separator).
 *
 * Per Rails routing guide §2.6: the string before `#` is the controller
 * (with optional namespace prefix), the part after is the action.
 */
function extractRootController(target: string): string | null {
  const idx = target.indexOf('#');
  if (idx <= 0) return null;
  const controller = target.slice(0, idx).trim();
  return controller || null;
}

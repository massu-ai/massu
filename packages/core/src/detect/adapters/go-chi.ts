// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c — Phase 7: go-chi AST adapter.
 *
 * First Phase 7 framework that introduces a NEW Tree-sitter grammar
 * (`go`) — added to GRAMMAR_MANIFEST in the preceding Commit 1
 * (plan-3c-phase7-grammar-infra). End-to-end proof that the grammar
 * load + parse + query path works for non-Python/JS/Swift languages.
 *
 * Establishes the per-framework deliverable pattern (4 artifacts) for
 * the remaining registry-verified frameworks (rails / aspnet / spring /
 * phoenix) and the bundled Go adapters (gin / echo / fiber / net-http):
 *   1. packages/core/templates/go-chi/massu.config.yaml      (variant template)
 *   2. packages/core/src/detect/adapters/go-chi.ts           (this file — AST adapter)
 *   3. Adversarial fixtures (inline in the test file via mkdirSync+writeFileSync)
 *   4. packages/core/src/__tests__/go-chi.test.ts            (golden-output test)
 *
 * Extracts:
 *   - route_method: most-common HTTP method registered via `r.<Method>(...)`
 *     (one of Get/Post/Put/Delete/Patch/Head/Options/Connect/Trace).
 *     Useful for scaffold-router templates that need to know which verb
 *     style the project uses.
 *   - mount_prefix_base: first path segment of `r.Mount("/api/...", ...)`
 *     mirroring python-fastapi's APIRouter prefix extraction. The chi
 *     `Mount` call is the canonical way to attach a sub-router under
 *     a path prefix (per chi docs: https://go-chi.io/#/pages/routing).
 *   - middleware_name: first chi middleware registered via
 *     `r.Use(middleware.<Name>)` (e.g., "Logger", "Recoverer", "RequestID").
 *     Captured from the canonical chi `middleware.*` package qualifier.
 *
 * Confidence rules (mirror python-fastapi/python-flask):
 *   - 'high' if exactly ONE distinct route_method seen (clear convention).
 *   - 'medium' if mount_prefix_base or middleware_name found but no route_method.
 *   - 'low' if multiple distinct route_methods seen (mixed convention).
 *   - 'none' if no chi signals at all (regex fallback takes over).
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
// Tree-sitter S-expression queries (Go grammar)
// ============================================================

/**
 * HTTP method route registration: matches `r.Get("/path", handler)`,
 * `r.Post(...)`, etc. Anchored on the chi-canonical method names; we
 * deliberately do NOT match arbitrary `r.<Anything>(...)` calls because
 * Go's selector_expression shape is shared by every method call.
 *
 * The Tree-sitter Go grammar represents `r.Get(...)` as:
 *   call_expression {
 *     function: selector_expression {
 *       operand: identifier   (e.g. "r")
 *       field:   field_identifier  (e.g. "Get")
 *     }
 *     arguments: argument_list { ... }
 *   }
 *
 * The #match? predicate constrains @method to chi's HTTP verb set.
 */
const ROUTE_METHOD_QUERY = `
(call_expression
  function: (selector_expression
    field: (field_identifier) @method (#match? @method "^(Get|Post|Put|Delete|Patch|Head|Options|Connect|Trace)$"))
  arguments: (argument_list
    .
    (interpreted_string_literal) @route_path))
`;

/**
 * Subrouter mount: `r.Mount("/api/v1", apiRouter)`. Captures the path
 * literal so we can split off the base segment, mirroring python-fastapi's
 * APIRouter prefix extraction.
 *
 * Per chi docs (https://go-chi.io/#/pages/routing#mounting):
 *   "Mount attaches another http.Handler along ./pattern/*"
 */
const MOUNT_PREFIX_QUERY = `
(call_expression
  function: (selector_expression
    field: (field_identifier) @_field (#eq? @_field "Mount"))
  arguments: (argument_list
    .
    (interpreted_string_literal) @mount_path))
`;

/**
 * chi middleware registration: `r.Use(middleware.Logger)`,
 * `r.Use(middleware.Recoverer)`, etc. We require the canonical
 * `middleware.<Name>` qualifier to avoid matching user-defined
 * middleware (which we couldn't classify by name alone).
 *
 * The selector_expression inside the argument captures the package
 * qualifier (`middleware`) and the function name (`Logger`/etc).
 */
const MIDDLEWARE_USE_QUERY = `
(call_expression
  function: (selector_expression
    field: (field_identifier) @_use (#eq? @_use "Use"))
  arguments: (argument_list
    .
    (selector_expression
      operand: (identifier) @_pkg (#eq? @_pkg "middleware")
      field: (field_identifier) @middleware_name)))
`;

// ============================================================
// Adapter
// ============================================================

export const goChiAdapter: CodebaseAdapter = {
  id: 'go-chi',
  languages: ['go'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. Match if:
    //   1. go.mod text mentions github.com/go-chi/chi (canonical require), OR
    //   2. project has cmd/ + internal/ AND go.mod is present (Go layout) — but
    //      only when go.mod ALSO mentions chi (avoids matching every Go project).
    if (!signals.goMod) return false;
    if (/github\.com\/go-chi\/chi/i.test(signals.goMod)) return true;
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('go');
    } catch (e) {
      // Grammar unavailable → adapter returns 'none' so regex fallback takes over.
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const routeMethods = new Map<string, { line: number; file: string }>();
    const mountBases = new Map<string, { line: number; file: string }>();
    const middlewareNames = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        // Phase 3.5 defense-in-depth size + depth gate at adapter tier.
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: go-chi skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          for (const hit of runQuery(parser, file.content, ROUTE_METHOD_QUERY, 'chi-route-method', file.path)) {
            const method = hit.captures.method;
            if (method && !routeMethods.has(method)) {
              routeMethods.set(method, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, MOUNT_PREFIX_QUERY, 'chi-mount-prefix', file.path)) {
            const raw = hit.captures.mount_path;
            if (!raw) continue;
            const literal = raw.replace(/^["`]/, '').replace(/["`]$/, '');
            const base = extractPrefixBase(literal);
            if (base && !mountBases.has(base)) {
              mountBases.set(base, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, MIDDLEWARE_USE_QUERY, 'chi-middleware-use', file.path)) {
            const name = hit.captures.middleware_name;
            if (name && !middlewareNames.has(name)) {
              middlewareNames.set(name, { line: hit.line, file: file.path });
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
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'chi-route-method' });
    } else if (routeMethods.size >= 2) {
      // Mixed convention — emit first-seen for visibility.
      const [name, { line, file }] = routeMethods.entries().next().value as [string, { line: number; file: string }];
      conventions.route_method = name;
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'chi-route-method' });
    }

    if (mountBases.size >= 1) {
      const [base, { line, file }] = mountBases.entries().next().value as [string, { line: number; file: string }];
      conventions.mount_prefix_base = base;
      provenance.push({ field: 'mount_prefix_base', sourceFile: file, line, query: 'chi-mount-prefix' });
    }

    if (middlewareNames.size >= 1) {
      const [name, { line, file }] = middlewareNames.entries().next().value as [string, { line: number; file: string }];
      conventions.middleware_name = name;
      provenance.push({ field: 'middleware_name', sourceFile: file, line, query: 'chi-middleware-use' });
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
 * Extract the first path segment of a chi mount path. Mirrors
 * python-fastapi/python-flask's extractPrefixBase. Returns null if input
 * doesn't start with `/`.
 *
 * NOTE: future refactor opportunity once a third adapter needs identical
 * logic — extracting a shared helper module. The Phase 7 Flask commit
 * deliberately copied this from python-fastapi rather than premature
 * extraction (per its self-attest #3); the same reasoning applies here
 * until a fourth consumer appears.
 */
function extractPrefixBase(prefix: string): string | null {
  if (!prefix.startsWith('/')) return null;
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

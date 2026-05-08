// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c — Phase 7: ASP.NET Core AST adapter.
 *
 * Fifth Phase 7 framework after go-chi + Flask + Rails + Phoenix. First to
 * consume the `csharp` Tree-sitter grammar entry from GRAMMAR_MANIFEST
 * (commit fbb8aa9). All queries verified against actual tree-sitter-c-sharp
 * AST shape via probe (R-011) BEFORE writing the adapter.
 *
 * ASP.NET Core supports two routing styles, both first-class per the
 * official routing guide (https://learn.microsoft.com/aspnet/core/fundamentals/routing):
 *   1. **Minimal API** (recommended for new projects since .NET 6):
 *      `app.MapGet("/path", handler)`, `app.MapPost(...)`, etc. in
 *      Program.cs.
 *   2. **Attribute routing** (MVC controllers): `[HttpGet("{id}")]`,
 *      `[HttpPost]`, `[Route("api/[controller]")]` on controller classes
 *      and methods.
 *
 * The adapter handles BOTH styles uniformly — extracted route_method
 * normalizes `MapGet`/`HttpGet` → `Get`, `MapPost`/`HttpPost` → `Post`,
 * etc. so downstream consumers don't need to know which style produced
 * the signal.
 *
 * Extracts:
 *   - route_method: most-common HTTP verb captured from EITHER `app.Map<Verb>`
 *     invocations (minimal API) OR `[Http<Verb>]` attributes (MVC).
 *   - route_prefix_base: first path segment from EITHER the first `MapGet`
 *     string-literal path arg OR the first class-level `[Route("template")]`
 *     attribute. Mirrors phoenix scope_prefix_base / rails api_namespace.
 *   - controller_class: name of the first class ending in `Controller`
 *     (attribute-routing style only — minimal API has no controllers).
 *     Mirrors python-flask app_factory / phoenix router_module.
 *
 * Confidence rules (mirror phoenix / rails / go-chi):
 *   - 'high'   if exactly ONE distinct route_method seen.
 *   - 'low'    if multiple distinct route_methods seen.
 *   - 'medium' if route_prefix_base or controller_class found but no
 *              route_method.
 *   - 'none'   if no ASP.NET signals at all (regex fallback takes over).
 *
 * Tree-sitter-c-sharp AST shape (verified via probe 2026-05-07):
 *   - Method calls: `(invocation_expression function: (member_access_expression
 *     name: (identifier)) arguments: (argument_list (argument
 *     (string_literal)) ...))`.
 *   - Attributes: `(attribute name: (identifier) (attribute_argument_list
 *     (attribute_argument (string_literal))?))` — argument list is optional
 *     because attributes like `[HttpPost]` have no args.
 *   - Class declarations: `(class_declaration name: (identifier)
 *     bases: (base_list (identifier)?))` — bases optional.
 *
 * Does NOT use regex on file content — only Tree-sitter S-expression queries
 * compiled via query-helpers.ts.
 */

import { Parser } from 'web-tree-sitter';
import type { CodebaseAdapter, AdapterResult, DetectionSignals, Provenance, SourceFile } from './types.ts';
import { runQuery, InvalidQueryError } from './query-helpers.ts';
import { loadGrammar } from './tree-sitter-loader.ts';
import { isParsableSource, MAX_AST_FILE_BYTES } from './parse-guard.ts';

// ============================================================
// Tree-sitter S-expression queries (C# grammar)
// ============================================================

/**
 * Minimal-API verb mapping: `app.MapGet("/path", handler)`,
 * `app.MapPost(...)`, etc. Anchored on the first argument being a
 * string_literal so we capture the route path together with the verb.
 *
 * The captured @method is the full method name like `MapGet` — the
 * adapter strips the `Map` prefix in post-processing.
 *
 * Per ASP.NET Core minimal API docs:
 * https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis
 */
const MAP_VERB_QUERY = `
(invocation_expression
  function: (member_access_expression
    name: (identifier) @method (#match? @method "^Map(Get|Post|Put|Patch|Delete|Head|Options)$"))
  arguments: (argument_list
    .
    (argument (string_literal) @route_path)))
`;

/**
 * Attribute-routing HTTP verb attributes: `[HttpGet]`, `[HttpGet("{id}")]`,
 * `[HttpPost]`, etc. Captures BOTH the parameterless and parameterized
 * forms — the route path may or may not be present.
 *
 * The captured @attr_name is `HttpGet` etc. — the adapter strips the
 * `Http` prefix in post-processing.
 *
 * Per ASP.NET Core attribute routing docs:
 * https://learn.microsoft.com/aspnet/core/mvc/controllers/routing
 */
const HTTP_ATTR_QUERY = `
(attribute
  name: (identifier) @attr_name (#match? @attr_name "^Http(Get|Post|Put|Patch|Delete|Head|Options)$"))
`;

/**
 * Class-level `[Route("api/[controller]")]` attribute. Captures the
 * route template string so we can extract its first path segment.
 * Tokens like `[controller]` inside the template are kept verbatim —
 * the prefix-base extractor splits on `/` so `api/[controller]` → `/api`.
 */
const ROUTE_ATTR_QUERY = `
(attribute
  name: (identifier) @_attr_name (#eq? @_attr_name "Route")
  (attribute_argument_list
    (attribute_argument (string_literal) @route_template)))
`;

/**
 * Controller class declaration: `class FooController : ControllerBase`.
 * We restrict to class names ending in `Controller` to avoid every class
 * in the project (canonical ASP.NET MVC naming convention).
 */
const CONTROLLER_CLASS_QUERY = `
(class_declaration
  name: (identifier) @class_name (#match? @class_name "Controller$"))
`;

// ============================================================
// Adapter
// ============================================================

export const aspnetAdapter: CodebaseAdapter = {
  id: 'aspnet',
  languages: ['csharp'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. The canonical ASP.NET Core
    // declaration is `<Project Sdk="Microsoft.NET.Sdk.Web">` in the .csproj
    // file (per https://learn.microsoft.com/aspnet/core/fundamentals/target-aspnetcore).
    // Fallback: presence of `Microsoft.AspNetCore.App` framework reference,
    // which appears in older .csproj formats.
    if (!signals.csproj) return false;
    if (/Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web["']/i.test(signals.csproj)) return true;
    if (/Microsoft\.AspNetCore\.App/i.test(signals.csproj)) return true;
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('csharp');
    } catch (e) {
      // Grammar unavailable → adapter returns 'none' so regex fallback takes over.
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const routeMethods = new Map<string, { line: number; file: string }>();
    const prefixBases = new Map<string, { line: number; file: string }>();
    const controllerClasses = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: aspnet skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          // Minimal API: app.MapGet("/path", ...)
          for (const hit of runQuery(parser, file.content, MAP_VERB_QUERY, 'aspnet-map-verb', file.path)) {
            const methodRaw = hit.captures.method;
            if (!methodRaw) continue;
            const verb = methodRaw.replace(/^Map/, ''); // MapGet → Get
            if (!routeMethods.has(verb)) {
              routeMethods.set(verb, { line: hit.line, file: file.path });
            }
            // Also capture the route path for prefix base
            const pathRaw = hit.captures.route_path;
            if (pathRaw) {
              const literal = pathRaw.replace(/^["']/, '').replace(/["']$/, '');
              const base = extractPrefixBase(literal);
              if (base && !prefixBases.has(base)) {
                prefixBases.set(base, { line: hit.line, file: file.path });
              }
            }
          }
          // Attribute routing: [HttpGet], [HttpPost], etc.
          for (const hit of runQuery(parser, file.content, HTTP_ATTR_QUERY, 'aspnet-http-attr', file.path)) {
            const attrRaw = hit.captures.attr_name;
            if (!attrRaw) continue;
            const verb = attrRaw.replace(/^Http/, ''); // HttpGet → Get
            if (!routeMethods.has(verb)) {
              routeMethods.set(verb, { line: hit.line, file: file.path });
            }
          }
          // Class-level [Route("api/[controller]")]
          for (const hit of runQuery(parser, file.content, ROUTE_ATTR_QUERY, 'aspnet-route-attr', file.path)) {
            const tplRaw = hit.captures.route_template;
            if (!tplRaw) continue;
            const literal = tplRaw.replace(/^["']/, '').replace(/["']$/, '');
            const base = extractPrefixBase(literal);
            if (base && !prefixBases.has(base)) {
              prefixBases.set(base, { line: hit.line, file: file.path });
            }
          }
          // Controller class: class FooController : ControllerBase
          for (const hit of runQuery(parser, file.content, CONTROLLER_CLASS_QUERY, 'aspnet-controller-class', file.path)) {
            const name = hit.captures.class_name;
            if (name && !controllerClasses.has(name)) {
              controllerClasses.set(name, { line: hit.line, file: file.path });
            }
          }
        } catch (e) {
          if (e instanceof InvalidQueryError) {
            throw e;
          }
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
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'aspnet-map-verb' });
    } else if (routeMethods.size >= 2) {
      const [name, { line, file }] = routeMethods.entries().next().value as [string, { line: number; file: string }];
      conventions.route_method = name;
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'aspnet-map-verb' });
    }

    if (prefixBases.size >= 1) {
      const [base, { line, file }] = prefixBases.entries().next().value as [string, { line: number; file: string }];
      conventions.route_prefix_base = base;
      provenance.push({ field: 'route_prefix_base', sourceFile: file, line, query: 'aspnet-route-prefix' });
    }

    if (controllerClasses.size >= 1) {
      const [name, { line, file }] = controllerClasses.entries().next().value as [string, { line: number; file: string }];
      conventions.controller_class = name;
      provenance.push({ field: 'controller_class', sourceFile: file, line, query: 'aspnet-controller-class' });
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
 * Extract the first path segment of an ASP.NET route template. Mirrors
 * phoenix/rails/python-flask/go-chi prefix-base extractors. Returns null
 * if input is empty or `/`-only.
 *
 * Examples (verified against test fixtures):
 *   "/health"             → "/health"
 *   "api/[controller]"    → "/api"
 *   "/api/v1/users"       → "/api"
 *   "/"                   → null
 *   ""                    → null
 */
function extractPrefixBase(prefix: string): string | null {
  // ASP.NET route templates may or may not begin with `/`. Normalize.
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

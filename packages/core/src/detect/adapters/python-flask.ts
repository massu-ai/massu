// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c — Phase 7: Flask AST adapter.
 *
 * First Phase 7 framework after Plan 3b's 4 (FastAPI/Django/tRPC/SwiftUI).
 * Establishes the per-framework deliverable pattern (4 artifacts) all
 * remaining Phase 7 frameworks follow:
 *   1. packages/core/templates/python-flask/massu.config.yaml  (variant template)
 *   2. packages/core/src/detect/adapters/python-flask.ts        (this file — AST adapter)
 *   3. Adversarial fixtures (inline in the test file via mkdirSync+writeFileSync,
 *      following the python-fastapi pattern in ast-adapters-adversarial.test.ts)
 *   4. packages/core/src/__tests__/python-flask.test.ts          (golden-output snapshot)
 *
 * Extracts:
 *   - auth_decorator: name of the auth-gating decorator (`@login_required`,
 *     `@auth_required`, or other Flask-Login-style decorator on a view).
 *   - blueprint_url_prefix: first path segment of `Blueprint(name, __name__,
 *     url_prefix="/api/...")`, mirroring the python-fastapi APIRouter prefix
 *     extraction.
 *   - app_factory: name of the Flask app-factory function (`def create_app():`
 *     or similar). Useful for scaffold-router templates that need to know
 *     where to register a new Blueprint.
 *
 * Confidence rules (mirror python-fastapi):
 *   - 'high' if exactly ONE auth_decorator is found (clear single convention).
 *   - 'medium' if blueprint_url_prefix or app_factory found but no auth decorator.
 *   - 'low' if multiple distinct auth_decorators are found (ambiguous).
 *   - 'none' if no Flask signals at all (regex fallback takes over).
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
// Tree-sitter S-expression queries
// ============================================================

/**
 * Auth decorator: matches `@login_required`, `@auth_required`,
 * `@some_auth_required`, etc. on a view function.
 *
 * The Tree-sitter Python grammar represents `@some_name` decorators as
 * a `decorator` node containing an `identifier` (for bare names) OR an
 * `attribute` (for `@module.name`). We capture both shapes and filter to
 * names ending in `_required` since that's the Flask-Login convention
 * and avoids matching unrelated decorators like `@app.route(...)`.
 */
const AUTH_DECORATOR_QUERY = `
(decorator
  (identifier) @auth_decorator (#match? @auth_decorator "_required$"))
`;

/**
 * Blueprint URL prefix: `Blueprint(name, __name__, url_prefix="/api/orders")`.
 * Captures the keyword-arg string literal so the runner can split off the
 * base segment.
 */
const BLUEPRINT_URL_PREFIX_QUERY = `
(call
  function: (identifier) @_callee (#eq? @_callee "Blueprint")
  arguments: (argument_list
    (keyword_argument
      name: (identifier) @_kw (#eq? @_kw "url_prefix")
      value: (string) @url_prefix)))
`;

/**
 * App factory: `def create_app():` (or any function whose name starts with
 * `create_` and contains `Flask`). The factory pattern is canonical in Flask
 * (per Flask docs: https://flask.palletsprojects.com/en/2.3.x/patterns/appfactories/).
 * We capture the function name + assert its body contains `Flask(`.
 *
 * The Tree-sitter Python grammar represents `def name():` as a
 * `function_definition` node with `name: (identifier)` field.
 */
const APP_FACTORY_QUERY = `
(function_definition
  name: (identifier) @factory_name (#match? @factory_name "^create_")
  body: (block
    (expression_statement
      (assignment
        right: (call
          function: (identifier) @_flask_call (#eq? @_flask_call "Flask"))))))
`;

// ============================================================
// Adapter
// ============================================================

export const pythonFlaskAdapter: CodebaseAdapter = {
  id: 'python-flask',
  languages: ['python'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. Match if:
    //   1. pyproject.toml mentions flask (raw text contains 'flask'), OR
    //   2. project has app/ + python files at top level (Flask convention)
    const pyToml = signals.pyprojectToml as { __raw?: string } | undefined;
    if (pyToml?.__raw && /\bflask\b/i.test(pyToml.__raw)) return true;
    if (signals.presentDirs.has('app') && signals.presentFiles.has('app.py')) return true;
    if (signals.presentDirs.has('app') && signals.presentFiles.has('wsgi.py')) return true;
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('python');
    } catch (e) {
      // Grammar unavailable → adapter returns 'none' so regex fallback takes over.
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const authDecorators = new Map<string, { line: number; file: string }>();
    const urlPrefixes = new Map<string, { line: number; file: string }>();
    const appFactories = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        // Phase 3.5 defense-in-depth size + depth gate at adapter tier.
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: python-flask skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          for (const hit of runQuery(parser, file.content, AUTH_DECORATOR_QUERY, 'flask-auth-decorator', file.path)) {
            const name = hit.captures.auth_decorator;
            if (name && !authDecorators.has(name)) {
              authDecorators.set(name, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, BLUEPRINT_URL_PREFIX_QUERY, 'flask-blueprint-url-prefix', file.path)) {
            const raw = hit.captures.url_prefix;
            if (!raw) continue;
            const literal = raw.replace(/^['"]/, '').replace(/['"]$/, '');
            const base = extractPrefixBase(literal);
            if (base && !urlPrefixes.has(base)) {
              urlPrefixes.set(base, { line: hit.line, file: file.path });
            }
          }
          for (const hit of runQuery(parser, file.content, APP_FACTORY_QUERY, 'flask-app-factory', file.path)) {
            const name = hit.captures.factory_name;
            if (name && !appFactories.has(name)) {
              appFactories.set(name, { line: hit.line, file: file.path });
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

    // Build result
    const conventions: Record<string, unknown> = {};
    const provenance: Provenance[] = [];

    if (authDecorators.size === 1) {
      const [name, { line, file }] = authDecorators.entries().next().value as [string, { line: number; file: string }];
      conventions.auth_decorator = name;
      provenance.push({ field: 'auth_decorator', sourceFile: file, line, query: 'flask-auth-decorator' });
    } else if (authDecorators.size >= 2) {
      // Ambiguous — prefer first-seen (stable order from input file list).
      const [name, { line, file }] = authDecorators.entries().next().value as [string, { line: number; file: string }];
      conventions.auth_decorator = name;
      provenance.push({ field: 'auth_decorator', sourceFile: file, line, query: 'flask-auth-decorator' });
    }

    if (urlPrefixes.size >= 1) {
      const [base, { line, file }] = urlPrefixes.entries().next().value as [string, { line: number; file: string }];
      conventions.blueprint_url_prefix = base;
      provenance.push({ field: 'blueprint_url_prefix', sourceFile: file, line, query: 'flask-blueprint-url-prefix' });
    }

    if (appFactories.size >= 1) {
      const [name, { line, file }] = appFactories.entries().next().value as [string, { line: number; file: string }];
      conventions.app_factory = name;
      provenance.push({ field: 'app_factory', sourceFile: file, line, query: 'flask-app-factory' });
    }

    let confidence: AdapterResult['confidence'];
    if (Object.keys(conventions).length === 0) {
      confidence = 'none';
    } else if (authDecorators.size === 1) {
      confidence = 'high';
    } else if (authDecorators.size >= 2) {
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
 * Extract the first path segment of a Blueprint url_prefix. Mirrors
 * python-fastapi's extractPrefixBase. Returns null if input doesn't
 * start with `/`.
 */
function extractPrefixBase(prefix: string): string | null {
  if (!prefix.startsWith('/')) return null;
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

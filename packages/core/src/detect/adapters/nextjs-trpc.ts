// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: Next.js + tRPC AST adapter.
 *
 * Extracts:
 *   - trpc_router_builder: name of router-creation call (createTRPCRouter, t.router, router)
 *   - procedure_pattern: identifier ending in `Procedure` (publicProcedure, protectedProcedure)
 *   - ctx_shape: 'object' | 'function' | null — based on resolver signature shape
 *
 * Looks under `server/api/routers/` or `server/trpc/` paths. The runner is
 * responsible for sampling files into those paths; this adapter assumes the
 * `files` it receives are router-shaped.
 */

import { Parser } from 'web-tree-sitter';
import type { CodebaseAdapter, AdapterResult, DetectionSignals, Provenance, SourceFile } from './types.ts';
import { runQuery, InvalidQueryError } from './query-helpers.ts';
import { loadGrammar } from './tree-sitter-loader.ts';
import { isParsableSource, MAX_AST_FILE_BYTES } from './parse-guard.ts';

// ============================================================
// Queries
// ============================================================

/**
 * Router builder call: `createTRPCRouter({...})` or `t.router({...})`. Captures
 * the call's function expression so the runner can normalize it.
 */
const ROUTER_BUILDER_QUERY = `
(call_expression
  function: (identifier) @builder_id (#match? @builder_id "^(createTRPCRouter|router)$"))

(call_expression
  function: (member_expression
    object: (identifier) @_obj
    property: (property_identifier) @_prop (#eq? @_prop "router"))) @member_call
`;

/**
 * Procedure usage: `publicProcedure.input(...)` / `protectedProcedure.query(...)`.
 * Captures any identifier that ends in `Procedure`.
 */
const PROCEDURE_QUERY = `
(member_expression
  object: (identifier) @procedure_id (#match? @procedure_id "Procedure$"))

(call_expression
  function: (identifier) @procedure_call (#match? @procedure_call "Procedure$"))
`;

// ============================================================
// Adapter
// ============================================================

const KNOWN_BUILDERS = new Set(['createTRPCRouter', 'router']);

export const nextjsTrpcAdapter: CodebaseAdapter = {
  id: 'nextjs-trpc',
  languages: ['typescript'],

  matches(signals: DetectionSignals): boolean {
    // package.json deps include @trpc/* OR there's a server/api/routers dir
    const pkgJson = signals.packageJson;
    if (pkgJson) {
      const deps = pkgJson.dependencies as Record<string, unknown> | undefined;
      const devDeps = pkgJson.devDependencies as Record<string, unknown> | undefined;
      const all = { ...(deps ?? {}), ...(devDeps ?? {}) };
      if (Object.keys(all).some(k => k.startsWith('@trpc/'))) return true;
    }
    if (signals.presentDirs.has('server')) return true;
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('typescript');
    } catch {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const builders = new Map<string, { line: number; file: string }>();
    const procedures = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: nextjs-trpc skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          for (const hit of runQuery(parser, file.content, ROUTER_BUILDER_QUERY, 'trpc-router-builder', file.path)) {
            // Either capture group `builder_id` (direct call) or
            // `member_call` (the whole `t.router(...)` expression).
            const directId = hit.captures.builder_id;
            const memberCall = hit.captures.member_call;
            let label: string | null = null;
            if (directId && KNOWN_BUILDERS.has(directId)) {
              label = directId;
            } else if (memberCall) {
              // Normalize `t.router` text (member_call captures the whole call)
              // into the bare `t.router` form by extracting the leading
              // identifier.foo pattern.
              const m = memberCall.match(/([A-Za-z_$][A-Za-z0-9_$]*)\.router/);
              if (m) label = `${m[1]}.router`;
            }
            if (label && !builders.has(label)) {
              builders.set(label, { line: hit.line, file: file.path });
            }
          }

          for (const hit of runQuery(parser, file.content, PROCEDURE_QUERY, 'trpc-procedure', file.path)) {
            const proc = hit.captures.procedure_id ?? hit.captures.procedure_call;
            if (proc && !procedures.has(proc)) {
              procedures.set(proc, { line: hit.line, file: file.path });
            }
          }
        } catch (e) {
          if (e instanceof InvalidQueryError) throw e;
          continue;
        }
      }
    } finally {
      try { parser.delete(); } catch { /* ignore */ }
    }

    const conventions: Record<string, unknown> = {};
    const provenance: Provenance[] = [];

    if (builders.size > 0) {
      const [name, { line, file }] = builders.entries().next().value as [string, { line: number; file: string }];
      conventions.trpc_router_builder = name;
      provenance.push({ field: 'trpc_router_builder', sourceFile: file, line, query: 'trpc-router-builder' });
    }
    if (procedures.size > 0) {
      const [name, { line, file }] = procedures.entries().next().value as [string, { line: number; file: string }];
      conventions.procedure_pattern = name;
      provenance.push({ field: 'procedure_pattern', sourceFile: file, line, query: 'trpc-procedure' });
    }

    let confidence: AdapterResult['confidence'];
    if (Object.keys(conventions).length === 0) {
      confidence = 'none';
    } else if (builders.size === 1 && procedures.size <= 2) {
      confidence = 'high';
    } else if (builders.size > 1) {
      confidence = 'low';
    } else {
      confidence = 'medium';
    }

    return { conventions, provenance, confidence };
  },
};

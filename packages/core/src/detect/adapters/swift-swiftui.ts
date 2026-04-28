// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: SwiftUI AST adapter.
 *
 * Extracts:
 *   - api_client_class: identifier ending in `API` (e.g. `HedgeAPI`)
 *   - biometric_policy: `LAPolicy.deviceOwnerAuthenticationWithBiometrics` etc.
 *   - navigation_pattern: 'NavigationStack' | 'NavigationView' | null
 *
 * Tree-sitter Swift grammar quirks: the `tree-sitter-swift` grammar names some
 * nodes differently from python/typescript. We use simpler, more permissive
 * S-expressions that fall back to capture-text matching where needed.
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
 * Identifier that looks like an API client class. Captures any uppercase-led
 * identifier ending in `API`. Predicate filtering is done in JS — Swift's
 * grammar doesn't surface a clean class-instantiation pattern uniformly.
 */
const API_CLASS_QUERY = `
(simple_identifier) @ident
`;

/**
 * `.deviceOwnerAuthentication` / `.deviceOwnerAuthenticationWithBiometrics`
 * member access. Captures the property name.
 */
const POLICY_QUERY = `
(navigation_expression
  suffix: (navigation_suffix
    (simple_identifier) @policy_name))
`;

/**
 * NavigationStack / NavigationView usage. Captures any reference to either
 * symbol.
 */
const NAV_QUERY = `
(simple_identifier) @nav_ident
`;

// ============================================================
// Adapter
// ============================================================

const POLICY_NAMES = new Set([
  'deviceOwnerAuthentication',
  'deviceOwnerAuthenticationWithBiometrics',
]);

export const swiftSwiftUiAdapter: CodebaseAdapter = {
  id: 'swift-swiftui',
  languages: ['swift'],

  matches(signals: DetectionSignals): boolean {
    // Swift signal: presence of Package.swift, *.xcodeproj, or Sources/ dir
    if (signals.presentFiles.has('Package.swift')) return true;
    for (const dir of signals.presentDirs) {
      if (dir.endsWith('.xcodeproj') || dir.endsWith('.xcworkspace')) return true;
      if (dir === 'Sources') return true;
    }
    for (const file of signals.presentFiles) {
      if (file.endsWith('.swift')) return true;
    }
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('swift');
    } catch {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const apiClasses = new Map<string, { line: number; file: string }>();
    const policies = new Map<string, { line: number; file: string }>();
    const navs = new Map<string, { line: number; file: string }>();

    try {
      for (const file of files) {
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: swift-swiftui skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          // API class names: filter via JS regex on the captured identifier
          for (const hit of runQuery(parser, file.content, API_CLASS_QUERY, 'swift-api-class', file.path)) {
            const ident = hit.captures.ident;
            if (ident && /^[A-Z][A-Za-z0-9_]*API$/.test(ident) && !apiClasses.has(ident)) {
              apiClasses.set(ident, { line: hit.line, file: file.path });
            }
          }
          // Biometric policy
          for (const hit of runQuery(parser, file.content, POLICY_QUERY, 'swift-biometric-policy', file.path)) {
            const name = hit.captures.policy_name;
            if (name && POLICY_NAMES.has(name) && !policies.has(name)) {
              policies.set(name, { line: hit.line, file: file.path });
            }
          }
          // Navigation
          for (const hit of runQuery(parser, file.content, NAV_QUERY, 'swift-navigation', file.path)) {
            const ident = hit.captures.nav_ident;
            if ((ident === 'NavigationStack' || ident === 'NavigationView') && !navs.has(ident)) {
              navs.set(ident, { line: hit.line, file: file.path });
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

    if (apiClasses.size > 0) {
      const [name, { line, file }] = apiClasses.entries().next().value as [string, { line: number; file: string }];
      conventions.api_client_class = name;
      provenance.push({ field: 'api_client_class', sourceFile: file, line, query: 'swift-api-class' });
    }
    if (policies.size > 0) {
      const [name, { line, file }] = policies.entries().next().value as [string, { line: number; file: string }];
      conventions.biometric_policy = name;
      provenance.push({ field: 'biometric_policy', sourceFile: file, line, query: 'swift-biometric-policy' });
    }
    if (navs.size > 0) {
      const [name, { line, file }] = navs.entries().next().value as [string, { line: number; file: string }];
      conventions.navigation_pattern = name;
      provenance.push({ field: 'navigation_pattern', sourceFile: file, line, query: 'swift-navigation' });
    }

    let confidence: AdapterResult['confidence'];
    if (Object.keys(conventions).length === 0) {
      confidence = 'none';
    } else if (apiClasses.size === 1 && policies.size <= 1) {
      confidence = 'high';
    } else if (apiClasses.size > 1) {
      confidence = 'low';
    } else {
      confidence = 'medium';
    }

    return { conventions, provenance, confidence };
  },
};

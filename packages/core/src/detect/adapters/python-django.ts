// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: Django AST adapter.
 *
 * Extracts:
 *   - mixin_classes: class-based-view base classes inheriting LoginRequiredMixin etc.
 *   - decorator_usage: `@login_required` or `@permission_required` decorators
 *   - urlpatterns_shape: 'function-views' | 'class-views' | 'mixed'
 *
 * Conservative gate: returns 'none' if no `INSTALLED_APPS` Django marker is
 * present in the signal bundle. Adapter wants HIGH precision: false-positive
 * Django classification would push regex fallback aside for projects that
 * don't actually use Django.
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
 * `@login_required` / `@permission_required` decorator on a function def.
 * Captures the decorator name (`login_required` or any `*_required`/`*_login`).
 */
const DECORATOR_QUERY = `
(decorator
  (identifier) @decorator_name)
`;

/**
 * Class definition with a base list — captures bases like `LoginRequiredMixin`,
 * `PermissionRequiredMixin`, `View`, `ListView`. The runner filters for the
 * Django-specific names.
 */
const CLASS_BASE_QUERY = `
(class_definition
  name: (identifier) @class_name
  superclasses: (argument_list
    (identifier) @base_name))
`;

/**
 * urlpatterns assignment — captures the rhs (a list) so we can inspect what's
 * inside (path() / re_path() calls indicate function-view style; class names
 * indicate class-view style).
 */
const URLPATTERNS_QUERY = `
(assignment
  left: (identifier) @_target (#eq? @_target "urlpatterns")
  right: (list) @urlpatterns_list)
`;

// ============================================================
// Adapter
// ============================================================

const DJANGO_MIXIN_NAMES = new Set([
  'LoginRequiredMixin',
  'PermissionRequiredMixin',
  'UserPassesTestMixin',
  'StaffuserRequiredMixin',
]);

const DJANGO_DECORATOR_PATTERNS = [
  /^login_required$/,
  /^permission_required$/,
  /_required$/,
  /^require_/,
];

export const pythonDjangoAdapter: CodebaseAdapter = {
  id: 'python-django',
  languages: ['python'],

  matches(signals: DetectionSignals): boolean {
    // Conservative gate: require an explicit Django marker.
    // - manage.py at root, OR
    // - settings.py with INSTALLED_APPS reference, OR
    // - pyproject.toml dep on Django
    if (signals.presentFiles.has('manage.py')) return true;
    const pyToml = signals.pyprojectToml as { __raw?: string } | undefined;
    if (pyToml?.__raw && /\bdjango\b/i.test(pyToml.__raw)) return true;
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('python');
    } catch {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    const parser = new Parser();
    parser.setLanguage(language);

    const decoratorsFound = new Map<string, { line: number; file: string }>();
    const mixinsFound = new Map<string, { line: number; file: string }>();
    const urlpatternsShape: { value: 'function-views' | 'class-views' | 'mixed' | null; line: number; file: string } = {
      value: null,
      line: 0,
      file: '',
    };

    try {
      for (const file of files) {
        const skip = isParsableSource(file.content, file.size);
        if (skip) {
          process.stderr.write(
            `[massu/ast] WARN: python-django skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          // Decorators
          for (const hit of runQuery(parser, file.content, DECORATOR_QUERY, 'django-decorator', file.path)) {
            const name = hit.captures.decorator_name;
            if (!name) continue;
            // Filter to Django-shaped decorator names only.
            if (DJANGO_DECORATOR_PATTERNS.some(re => re.test(name)) && !decoratorsFound.has(name)) {
              decoratorsFound.set(name, { line: hit.line, file: file.path });
            }
          }
          // Mixins
          for (const hit of runQuery(parser, file.content, CLASS_BASE_QUERY, 'django-mixin', file.path)) {
            const base = hit.captures.base_name;
            if (base && DJANGO_MIXIN_NAMES.has(base) && !mixinsFound.has(base)) {
              mixinsFound.set(base, { line: hit.line, file: file.path });
            }
          }
          // urlpatterns shape — naive heuristic: inspect the captured text
          for (const hit of runQuery(parser, file.content, URLPATTERNS_QUERY, 'django-urlpatterns', file.path)) {
            const listText = hit.captures.urlpatterns_list ?? '';
            const hasFunctionForm = /\bpath\s*\(/.test(listText) || /\bre_path\s*\(/.test(listText);
            const hasClassForm = /\.as_view\s*\(/.test(listText);
            let shape: 'function-views' | 'class-views' | 'mixed' | null = null;
            if (hasFunctionForm && hasClassForm) shape = 'mixed';
            else if (hasFunctionForm) shape = 'function-views';
            else if (hasClassForm) shape = 'class-views';
            if (shape && !urlpatternsShape.value) {
              urlpatternsShape.value = shape;
              urlpatternsShape.line = hit.line;
              urlpatternsShape.file = file.path;
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

    if (decoratorsFound.size > 0) {
      const list = Array.from(decoratorsFound.keys());
      conventions.decorator_usage = list;
      const [first, { line, file }] = decoratorsFound.entries().next().value as [string, { line: number; file: string }];
      provenance.push({ field: 'decorator_usage', sourceFile: file, line, query: 'django-decorator' });
      // Also emit first decorator as auth_dep proxy for compatibility with
      // regex-fallback's behavior — auth_dep was the regex's primary output.
      conventions.auth_dep = first;
      provenance.push({ field: 'auth_dep', sourceFile: file, line, query: 'django-decorator' });
    }

    if (mixinsFound.size > 0) {
      const list = Array.from(mixinsFound.keys());
      conventions.mixin_classes = list;
      const [, { line, file }] = mixinsFound.entries().next().value as [string, { line: number; file: string }];
      provenance.push({ field: 'mixin_classes', sourceFile: file, line, query: 'django-mixin' });
    }

    if (urlpatternsShape.value) {
      conventions.urlpatterns_shape = urlpatternsShape.value;
      provenance.push({
        field: 'urlpatterns_shape',
        sourceFile: urlpatternsShape.file,
        line: urlpatternsShape.line,
        query: 'django-urlpatterns',
      });
    }

    let confidence: AdapterResult['confidence'];
    if (Object.keys(conventions).length === 0) {
      confidence = 'none';
    } else if (decoratorsFound.size > 0 || mixinsFound.size > 0) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    return { conventions, provenance, confidence };
  },
};

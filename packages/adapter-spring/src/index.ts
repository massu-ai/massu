// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c — Phase 7: Spring (Spring Boot / Spring MVC) AST adapter.
 *
 * Sixth and final Phase 7 framework after go-chi + Flask + Rails + Phoenix
 * + ASP.NET. First to consume the `java` Tree-sitter grammar entry from
 * GRAMMAR_MANIFEST (commit fbb8aa9). All four queries verified against
 * actual tree-sitter-java AST shape via probe (R-011) BEFORE writing the
 * adapter — same discipline as phoenix + aspnet.
 *
 * Spring uses annotation-based routing per the Spring MVC reference
 * (https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller.html):
 *   - `@RestController` / `@Controller` at the class level
 *   - `@RequestMapping("/api/users")` at class level for path prefix
 *   - `@GetMapping("/{id}")` / `@PostMapping` / etc. on methods for verb +
 *     optional sub-path
 *
 * Extracts:
 *   - route_method: most-common HTTP verb captured from
 *     `@<Verb>Mapping` annotations. Normalized: `GetMapping` → `Get`,
 *     `PostMapping` → `Post`, etc. Mirrors aspnet's MapGet/HttpGet
 *     normalization for downstream consumer consistency.
 *   - route_prefix_base: first segment of the first class-level
 *     `@RequestMapping("/api/...")` template, normalized to a leading-
 *     slash path. Mirrors aspnet route_prefix_base / phoenix
 *     scope_prefix_base.
 *   - controller_class: name of the first class annotated with
 *     `@RestController` or `@Controller`. Mirrors aspnet controller_class
 *     / phoenix router_module.
 *
 * Confidence rules (mirror phoenix / rails / aspnet):
 *   - 'high'   if exactly ONE distinct route_method seen.
 *   - 'low'    if multiple distinct route_methods seen.
 *   - 'medium' if route_prefix_base or controller_class found but no
 *              route_method.
 *   - 'none'   if no Spring signals at all.
 *
 * Tree-sitter-java AST shape (verified via probe 2026-05-07):
 *   - Annotations come in TWO node-type flavors:
 *       - `(marker_annotation name: (identifier))` for parameterless
 *         annotations like `@PostMapping`, `@RestController`.
 *       - `(annotation name: (identifier) arguments: (annotation_argument_list
 *         (string_literal) ...))` for parameterized annotations like
 *         `@GetMapping("/{id}")`, `@RequestMapping("/api/users")`.
 *     Adapter queries cover BOTH where applicable.
 *   - Class declarations: `(class_declaration (modifiers (annotation ...) /
 *     (marker_annotation ...)) name: (identifier) body: (class_body ...))`.
 *   - String literals are `(string_literal (string_fragment))`; node.text
 *     returns the quoted source verbatim.
 *
 * Does NOT use regex on file content — only Tree-sitter S-expression queries
 * compiled via query-helpers.ts.
 */

// Plan 3c Phase 9b P-A-001: workspace adapter consumes `@massu/core/adapter`
// SemVer-stable subpath instead of reaching into core internals.
import { Parser } from 'web-tree-sitter';
import type { CodebaseAdapter, AdapterResult, DetectionSignals, Provenance, SourceFile } from '@massu/core/adapter';
import { runQuery, InvalidQueryError, loadGrammar, isParsableSource, MAX_AST_FILE_BYTES } from '@massu/core/adapter';

// ============================================================
// Tree-sitter S-expression queries (Java grammar)
// ============================================================

/**
 * Parameterized HTTP mapping annotations: `@GetMapping("/{id}")`,
 * `@PostMapping("/login")`, etc. Captures both the verb (from the
 * annotation name) AND the path string for prefix-base extraction.
 *
 * Per Spring docs:
 * https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html
 */
const HTTP_MAPPING_QUERY = `
(annotation
  name: (identifier) @method (#match? @method "^(Get|Post|Put|Patch|Delete|Head|Options)Mapping$")
  arguments: (annotation_argument_list
    (string_literal) @route_path))
`;

/**
 * Parameterless HTTP mapping annotations: `@PostMapping`, `@DeleteMapping`,
 * etc. The tree-sitter-java grammar uses a separate `marker_annotation`
 * node for annotations without an argument list — distinct from the
 * parameterized `annotation` node above.
 */
const HTTP_MAPPING_NO_ARGS_QUERY = `
(marker_annotation
  name: (identifier) @method (#match? @method "^(Get|Post|Put|Patch|Delete|Head|Options)Mapping$"))
`;

/**
 * Class-level `@RequestMapping("/api/users")`. Captures the path template
 * so we can extract its first segment.
 */
const REQUEST_MAPPING_QUERY = `
(annotation
  name: (identifier) @_name (#eq? @_name "RequestMapping")
  arguments: (annotation_argument_list
    (string_literal) @route_template))
`;

/**
 * Class declarations annotated with `@RestController` or `@Controller`.
 * Both annotation flavors (marker + parameterized) are captured because
 * Spring controllers usually use parameterless `@RestController` /
 * `@Controller` but some use `@Controller(value = "name")`.
 */
const CONTROLLER_CLASS_QUERY = `
(class_declaration
  (modifiers
    (marker_annotation
      name: (identifier) @_anno (#match? @_anno "^(RestController|Controller)$")))
  name: (identifier) @class_name)

(class_declaration
  (modifiers
    (annotation
      name: (identifier) @_anno (#match? @_anno "^(RestController|Controller)$")))
  name: (identifier) @class_name)
`;

// ============================================================
// Adapter
// ============================================================

export const springAdapter: CodebaseAdapter = {
  id: 'spring',
  languages: ['java'],

  matches(signals: DetectionSignals): boolean {
    // Cheap signal-only check. No file IO. The canonical Spring Boot
    // declaration is the `spring-boot-starter-web` artifact (Maven) or
    // dependency string (Gradle), per the Spring Boot reference:
    // https://docs.spring.io/spring-boot/reference/using/build-systems.html
    if (signals.pomXml && /\bspring-boot-starter[\w-]*\b/.test(signals.pomXml)) {
      return true;
    }
    if (signals.gradleBuild && /\bspring-boot-starter[\w-]*\b/.test(signals.gradleBuild)) {
      return true;
    }
    // Fallback: explicit `spring-webmvc` or `org.springframework` references
    // catch projects that use Spring without Spring Boot (rare today but
    // canonical Spring MVC pre-Boot apps).
    if (signals.pomXml && /\borg\.springframework\b/.test(signals.pomXml)) {
      return true;
    }
    if (signals.gradleBuild && /\borg\.springframework\b/.test(signals.gradleBuild)) {
      return true;
    }
    return false;
  },

  async introspect(files: SourceFile[], _rootDir: string): Promise<AdapterResult> {
    if (files.length === 0) {
      return { conventions: {}, provenance: [], confidence: 'none' };
    }

    let language;
    try {
      language = await loadGrammar('java');
    } catch (e) {
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
            `[massu/ast] WARN: spring skipping ${file.path}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES}. (Phase 3.5 mitigation)\n`,
          );
          continue;
        }
        try {
          // Parameterized @<Verb>Mapping("/path")
          for (const hit of runQuery(parser, file.content, HTTP_MAPPING_QUERY, 'spring-http-mapping', file.path)) {
            const methodRaw = hit.captures.method;
            if (!methodRaw) continue;
            const verb = methodRaw.replace(/Mapping$/, ''); // GetMapping → Get
            if (!routeMethods.has(verb)) {
              routeMethods.set(verb, { line: hit.line, file: file.path });
            }
          }
          // Parameterless @<Verb>Mapping
          for (const hit of runQuery(parser, file.content, HTTP_MAPPING_NO_ARGS_QUERY, 'spring-http-mapping-marker', file.path)) {
            const methodRaw = hit.captures.method;
            if (!methodRaw) continue;
            const verb = methodRaw.replace(/Mapping$/, '');
            if (!routeMethods.has(verb)) {
              routeMethods.set(verb, { line: hit.line, file: file.path });
            }
          }
          // @RequestMapping("/api/...")
          for (const hit of runQuery(parser, file.content, REQUEST_MAPPING_QUERY, 'spring-request-mapping', file.path)) {
            const tplRaw = hit.captures.route_template;
            if (!tplRaw) continue;
            const literal = tplRaw.replace(/^["']/, '').replace(/["']$/, '');
            const base = extractPrefixBase(literal);
            if (base && !prefixBases.has(base)) {
              prefixBases.set(base, { line: hit.line, file: file.path });
            }
          }
          // @RestController / @Controller class
          for (const hit of runQuery(parser, file.content, CONTROLLER_CLASS_QUERY, 'spring-controller-class', file.path)) {
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
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'spring-http-mapping' });
    } else if (routeMethods.size >= 2) {
      const [name, { line, file }] = routeMethods.entries().next().value as [string, { line: number; file: string }];
      conventions.route_method = name;
      provenance.push({ field: 'route_method', sourceFile: file, line, query: 'spring-http-mapping' });
    }

    if (prefixBases.size >= 1) {
      const [base, { line, file }] = prefixBases.entries().next().value as [string, { line: number; file: string }];
      conventions.route_prefix_base = base;
      provenance.push({ field: 'route_prefix_base', sourceFile: file, line, query: 'spring-request-mapping' });
    }

    if (controllerClasses.size >= 1) {
      const [name, { line, file }] = controllerClasses.entries().next().value as [string, { line: number; file: string }];
      conventions.controller_class = name;
      provenance.push({ field: 'controller_class', sourceFile: file, line, query: 'spring-controller-class' });
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
 * Extract the first path segment of a Spring `@RequestMapping` template.
 * Mirrors aspnet/phoenix/rails/python-flask/go-chi extractors. Returns
 * null if input is empty or `/`-only.
 */
function extractPrefixBase(prefix: string): string | null {
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

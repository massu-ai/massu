// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Massu codebase-aware templating engine — string substitution only.
 *
 * Spec: docs/internal/2026-04-26-codebase-aware-templates-spec.md
 *
 * Grammar (the entire surface):
 *   {{path.to.var}}                       Look up + render
 *   {{path.to.var | default("fallback")}} Look up; use literal on miss
 *   \{{                                   Literal `{{` (escape)
 *
 * Hard rules (do not weaken in maintenance):
 *   - NO `eval`, `Function`, `new Function`, `vm`, `child_process`, `exec`, `spawn`.
 *   - Variable lookup uses `Object.hasOwn` ONLY — no prototype walk.
 *   - Output is NEVER re-rendered (a value containing `{{x}}` stays literal).
 *   - No HTML escaping; output is markdown.
 *   - Single linear pass; no recursion, no fixed-point loop.
 */

/** Thrown when a variable is missing and no `| default("...")` was given. */
export class MissingVariableError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Template variable not found: "${path}"`);
    this.name = 'MissingVariableError';
    this.path = path;
  }
}

/** Thrown on an unbalanced or malformed template token. */
export class TemplateParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`Template parse error at position ${position}: ${message}`);
    this.name = 'TemplateParseError';
    this.position = position;
  }
}

/**
 * Render `template` against the given variables object.
 *
 * Throws:
 *   - `MissingVariableError` if a token references a path that doesn't exist
 *     and no `default("...")` is provided.
 *   - `TemplateParseError` on unbalanced `{{` (no closing `}}`) or malformed
 *     `default(...)` syntax.
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  const out: string[] = [];
  const len = template.length;
  let i = 0;

  while (i < len) {
    const ch = template[i];

    // Escape sequence: \{{ → literal {{
    if (ch === '\\' && i + 2 < len && template[i + 1] === '{' && template[i + 2] === '{') {
      out.push('{{');
      i += 3;
      continue;
    }

    // Token open: {{...}}
    if (ch === '{' && i + 1 < len && template[i + 1] === '{') {
      const tokenStart = i;
      const closeIdx = findTokenClose(template, i + 2);
      if (closeIdx === -1) {
        throw new TemplateParseError('unclosed `{{` (no matching `}}`)', tokenStart);
      }
      const inner = template.slice(i + 2, closeIdx);
      const rendered = renderToken(inner, vars, tokenStart);
      out.push(rendered);
      i = closeIdx + 2;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}

/**
 * Find the closing `}}` for a token that starts at index `start` (which points
 * to the first character INSIDE the `{{`). Skips `}}` that occur inside a
 * double-quoted string literal (so `default("a }} b")` works).
 *
 * Returns the index of the first `}` of the closing `}}`, or -1 if not found.
 */
function findTokenClose(template: string, start: number): number {
  const len = template.length;
  let i = start;
  let inString = false;

  while (i < len) {
    const ch = template[i];

    if (inString) {
      if (ch === '\\' && i + 1 < len) {
        // Skip the next char (escape sequence inside default string literal).
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === '}' && i + 1 < len && template[i + 1] === '}') {
      return i;
    }

    i++;
  }

  return -1;
}

/**
 * Render a single token (text BETWEEN `{{` and `}}`).
 * Format: `path.to.var` OR `path.to.var | default("fallback")`.
 */
function renderToken(
  inner: string,
  vars: Record<string, unknown>,
  tokenStart: number,
): string {
  const trimmed = inner.trim();
  if (trimmed === '') {
    throw new TemplateParseError('empty token `{{}}`', tokenStart);
  }

  // Split on the first unquoted `|`. Anything inside a string literal is preserved.
  const pipeIdx = findUnquotedPipe(trimmed);

  let path: string;
  let defaultValue: string | null = null;

  if (pipeIdx === -1) {
    path = trimmed;
  } else {
    path = trimmed.slice(0, pipeIdx).trim();
    const filterPart = trimmed.slice(pipeIdx + 1).trim();
    defaultValue = parseDefaultFilter(filterPart, tokenStart);
  }

  if (!isValidPath(path)) {
    throw new TemplateParseError(
      `invalid variable path: "${path}" (allowed: dot-separated identifiers)`,
      tokenStart,
    );
  }

  const looked = lookup(vars, path);
  if (looked === undefined) {
    if (defaultValue !== null) return defaultValue;
    throw new MissingVariableError(path);
  }

  return stringify(looked);
}

/**
 * Find the first `|` outside a double-quoted string literal. Returns -1 if none.
 * Backslash escapes are honored inside the string.
 */
function findUnquotedPipe(s: string): number {
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '|') return i;
  }
  return -1;
}

/**
 * Parse a `default("...")` filter, returning the literal string.
 * Throws `TemplateParseError` on any deviation from the grammar.
 */
function parseDefaultFilter(filter: string, tokenStart: number): string {
  // Must be exactly: `default(<string-literal>)`
  const m = /^default\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*$/.exec(filter);
  if (!m) {
    throw new TemplateParseError(
      `malformed filter: expected default("...")`,
      tokenStart,
    );
  }
  // Decode \" → ", \\ → \. Other backslashes are preserved verbatim per spec.
  const raw = m[1];
  return raw.replace(/\\(["\\])/g, '$1');
}

/**
 * Validate a dot-walk path: must be one or more segments, each a valid identifier.
 * Identifiers: ASCII letters, digits, underscore, hyphen; must not start with a digit.
 * Hyphens are allowed because some YAML keys (e.g., `web-source`) use them.
 */
function isValidPath(path: string): boolean {
  if (path.length === 0) return false;
  const segments = path.split('.');
  for (const seg of segments) {
    if (seg.length === 0) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg)) return false;
  }
  return true;
}

/**
 * Walk a dot-path through `obj` using own-property lookups only. NEVER traverses
 * the prototype chain. Returns `undefined` if any segment is missing or if the
 * value at any non-leaf segment is not an object.
 */
function lookup(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current as object, seg)) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Stringify a looked-up value. `undefined` is impossible at this point (caller
 * already checked). `null` becomes the literal `"null"`. Everything else uses
 * `String(value)`.
 */
function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-010: RCE-safe template renderer
// for custom-destination templates. Regex-substitution ONLY — never `eval`,
// never `new Function`, never `with`. Allowlisted variable names only.
//
// Safety argument: the renderer parses `${...}` interpolations, validates
// each captured token against a fixed identifier shape, then validates
// against ALLOWED_VARS. An interpolation of the form `${HOST.method(...)}`
// fails the identifier-shape check (the `.` and `(` are not identifier
// chars). A bare `${HOST}` passes the shape check but fails the allowlist.
// Neither path can reach `process`, `require`, `global`, or any other
// host object — see `template-renderer.test.ts` for explicit RCE-attempt
// cases.

const ALLOWED_VARS = new Set([
  'date',
  'slug',
  'score',
  'signals_csv',
  'prompt_preview',
  'destination_name',
] as const);

export type AllowedVarName = typeof ALLOWED_VARS extends Set<infer T> ? T : never;

export type TemplateVars = Partial<Record<AllowedVarName, string | number>>;

export class TemplateAllowlistError extends Error {
  constructor(public readonly key: string, public readonly allowedVars: readonly string[]) {
    super(`template variable "${key}" is not in the allowlist [${allowedVars.join(', ')}]`);
    this.name = 'TemplateAllowlistError';
  }
}

export class TemplateMissingValueError extends Error {
  constructor(public readonly key: string) {
    super(`template variable "${key}" is allowed but no value was supplied`);
    this.name = 'TemplateMissingValueError';
  }
}

const IDENTIFIER_SHAPE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const INTERPOLATION_TOKEN = /\$\{([^}]*)\}/g;

/**
 * Render a template by substituting `${var}` tokens. Throws
 * `TemplateAllowlistError` for unknown / non-identifier tokens and
 * `TemplateMissingValueError` when an allowed variable is undefined.
 *
 * Allowed variables:
 *   - `date` — ISO-8601 timestamp of the promote action
 *   - `slug` — sanitized correction-derived identifier
 *   - `score` — numeric correction score (0-100)
 *   - `signals_csv` — comma-joined SignalHit names (caller pre-renders)
 *   - `prompt_preview` — first 120 chars of the user-correction prompt
 *   - `destination_name` — matched custom-destination's `name` field
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(INTERPOLATION_TOKEN, (_, raw: string) => {
    const key = raw.trim();
    if (!IDENTIFIER_SHAPE.test(key)) {
      throw new TemplateAllowlistError(key, [...ALLOWED_VARS]);
    }
    if (!ALLOWED_VARS.has(key as AllowedVarName)) {
      throw new TemplateAllowlistError(key, [...ALLOWED_VARS]);
    }
    const v = vars[key as AllowedVarName];
    if (v === undefined) {
      throw new TemplateMissingValueError(key);
    }
    return String(v);
  });
}

export function listAllowedTemplateVars(): readonly string[] {
  return [...ALLOWED_VARS];
}

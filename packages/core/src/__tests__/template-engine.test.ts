// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  renderTemplate,
  MissingVariableError,
  TemplateParseError,
} from '../commands/template-engine.ts';

/**
 * Plan #2 P1-002: Templating engine tests.
 *
 * Coverage:
 *   - Happy path (simple substitution, dot-walk, default filter, escape)
 *   - Error cases (missing var, malformed token, malformed default)
 *   - Adversarial security tests TPL-SEC-01..07
 *   - Static guard: source contains no `eval`/`Function`/`vm`/`exec`/`spawn`
 *
 * Spec: docs/internal/2026-04-26-codebase-aware-templates-spec.md
 */

describe('Template Engine: happy path', () => {
  it('returns the input verbatim when there are no tokens', () => {
    expect(renderTemplate('hello world', {})).toBe('hello world');
  });

  it('substitutes a simple top-level variable', () => {
    expect(renderTemplate('hello {{name}}!', { name: 'world' })).toBe('hello world!');
  });

  it('substitutes multiple variables in one template', () => {
    const tpl = '{{greeting}}, {{name}}! Today is {{day}}.';
    const out = renderTemplate(tpl, { greeting: 'Hi', name: 'Ada', day: 'Friday' });
    expect(out).toBe('Hi, Ada! Today is Friday.');
  });

  it('walks dot-paths into nested objects', () => {
    const tpl = 'src dir is {{paths.source}}';
    expect(renderTemplate(tpl, { paths: { source: 'src/' } })).toBe('src dir is src/');
  });

  it('walks 4-level-deep paths', () => {
    const tpl = '{{a.b.c.d}}';
    expect(renderTemplate(tpl, { a: { b: { c: { d: 'leaf' } } } })).toBe('leaf');
  });

  it('treats whitespace inside `{{ }}` as trimmable', () => {
    expect(renderTemplate('{{ name }}', { name: 'x' })).toBe('x');
    expect(renderTemplate('{{   name   }}', { name: 'x' })).toBe('x');
  });

  it('renders booleans and numbers via String()', () => {
    expect(renderTemplate('{{n}} and {{b}}', { n: 42, b: true })).toBe('42 and true');
  });

  it('renders null as the literal "null"', () => {
    expect(renderTemplate('{{x}}', { x: null })).toBe('null');
  });

  it('handles empty template', () => {
    expect(renderTemplate('', {})).toBe('');
  });

  it('handles a single-character template', () => {
    expect(renderTemplate('a', {})).toBe('a');
  });

  it('renders adjacent tokens with no whitespace between them', () => {
    expect(renderTemplate('{{a}}{{b}}', { a: 'x', b: 'y' })).toBe('xy');
  });

  it('preserves all whitespace and newlines outside tokens', () => {
    const tpl = '  line1\n\t{{x}}\n  line3\n';
    expect(renderTemplate(tpl, { x: 'mid' })).toBe('  line1\n\tmid\n  line3\n');
  });
});

describe('Template Engine: default filter', () => {
  it('uses the default value when the variable is missing', () => {
    expect(renderTemplate('{{x | default("fallback")}}', {})).toBe('fallback');
  });

  it('uses the actual value when present (default ignored)', () => {
    expect(renderTemplate('{{x | default("fallback")}}', { x: 'real' })).toBe('real');
  });

  it('accepts an empty string as the default', () => {
    expect(renderTemplate('[{{x | default("")}}]', {})).toBe('[]');
  });

  it('decodes \\" inside the default literal', () => {
    expect(renderTemplate('{{x | default("a\\"b")}}', {})).toBe('a"b');
  });

  it('decodes \\\\ inside the default literal', () => {
    expect(renderTemplate('{{x | default("a\\\\b")}}', {})).toBe('a\\b');
  });

  it('preserves other backslash sequences verbatim per spec', () => {
    // \n is NOT a recognized escape — preserved as literal backslash-n.
    expect(renderTemplate('{{x | default("a\\nb")}}', {})).toBe('a\\nb');
  });

  it('tolerates whitespace around the pipe and the filter name', () => {
    expect(renderTemplate('{{ x  |  default("fb") }}', {})).toBe('fb');
  });

  it('walks the dot path, then falls back to default if any segment missing', () => {
    expect(renderTemplate('{{a.b.c | default("D")}}', { a: { b: {} } })).toBe('D');
    expect(renderTemplate('{{a.b.c | default("D")}}', { a: { b: { c: 'C' } } })).toBe('C');
  });

  it('uses the default when the parent is null', () => {
    expect(renderTemplate('{{a.b | default("D")}}', { a: null })).toBe('D');
  });
});

describe('Template Engine: escape sequence', () => {
  it('treats `\\{{` as a literal `{{`', () => {
    expect(renderTemplate('\\{{not a token}}', {})).toBe('{{not a token}}');
  });

  it('still recognizes a real token after an escape', () => {
    expect(renderTemplate('\\{{ literal }} but {{x}} is real', { x: 'val' })).toBe(
      '{{ literal }} but val is real',
    );
  });
});

describe('Template Engine: error cases', () => {
  it('throws MissingVariableError when a top-level var is missing', () => {
    expect(() => renderTemplate('{{nope}}', {})).toThrow(MissingVariableError);
  });

  it('throws MissingVariableError with the missing path on the error', () => {
    try {
      renderTemplate('{{a.b.c}}', { a: { b: {} } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingVariableError);
      expect((e as MissingVariableError).path).toBe('a.b.c');
    }
  });

  it('throws TemplateParseError on unclosed `{{`', () => {
    expect(() => renderTemplate('{{ x', {})).toThrow(TemplateParseError);
    expect(() => renderTemplate('foo {{ x bar', {})).toThrow(TemplateParseError);
  });

  it('throws TemplateParseError on empty `{{}}`', () => {
    expect(() => renderTemplate('{{}}', {})).toThrow(TemplateParseError);
    expect(() => renderTemplate('{{   }}', {})).toThrow(TemplateParseError);
  });

  it('throws TemplateParseError on malformed default filter', () => {
    expect(() => renderTemplate('{{x | default(no-quotes)}}', {})).toThrow(TemplateParseError);
    expect(() => renderTemplate('{{x | unknown_filter}}', {})).toThrow(TemplateParseError);
    expect(() => renderTemplate('{{x | default()}}', {})).toThrow(TemplateParseError);
  });

  it('throws TemplateParseError on invalid path characters', () => {
    expect(() => renderTemplate('{{a..b}}', { a: { b: 1 } })).toThrow(TemplateParseError);
    expect(() => renderTemplate('{{1bad}}', {})).toThrow(TemplateParseError);
    expect(() => renderTemplate('{{a/b}}', {})).toThrow(TemplateParseError);
  });
});

describe('Template Engine: TPL-SEC-01 (template-literal injection has no effect)', () => {
  it('renders ${process.env.PATH} as literal data', () => {
    // The token contents are NEVER passed to a template-literal evaluator.
    // The lookup of `${process.env.PATH}` is "missing" and (with default) the
    // default literal is returned. The dollar-sign string is not touched.
    const out = renderTemplate('{{x | default("${process.env.PATH}")}}', {});
    expect(out).toBe('${process.env.PATH}');
  });
});

describe('Template Engine: TPL-SEC-02 (Function-constructor escape blocked)', () => {
  it('treats `constructor.constructor("...")()` as an invalid path', () => {
    // Path syntax forbids parens; this is a parse error, not a code execution.
    expect(() =>
      renderTemplate('{{constructor.constructor("return process")()}}', {}),
    ).toThrow(TemplateParseError);
  });

  it('looks up `constructor.prototype` as a missing variable, never via prototype chain', () => {
    // No parens, no string literal — but the path still walks through
    // Object.hasOwn only, so it cannot reach the prototype chain.
    const result = renderTemplate('{{a.constructor.prototype | default("blocked")}}', {
      a: {},
    });
    expect(result).toBe('blocked');
  });
});

describe('Template Engine: TPL-SEC-03 (no auto-escape; output is markdown)', () => {
  it('renders <script>alert(1)</script> verbatim', () => {
    const tpl = 'value: {{val}}';
    const out = renderTemplate(tpl, { val: '<script>alert(1)</script>' });
    expect(out).toBe('value: <script>alert(1)</script>');
  });
});

describe('Template Engine: TPL-SEC-04 (no recursive expansion)', () => {
  it('renders a value containing `{{another}}` as literal data', () => {
    const out = renderTemplate('{{val}}', { val: '{{another}}', another: 'INJECTED' });
    expect(out).toBe('{{another}}');
    expect(out).not.toContain('INJECTED');
  });

  it('does not re-render output even when default contains a token-like literal', () => {
    const out = renderTemplate('{{x | default("{{y}}")}}', { y: 'INJECTED' });
    expect(out).toBe('{{y}}');
    expect(out).not.toContain('INJECTED');
  });
});

describe('Template Engine: TPL-SEC-05 (no quadratic blowup)', () => {
  it('renders 100,000 instances of {{var}} in <100ms', () => {
    const piece = '{{x}}';
    const tpl = piece.repeat(100_000);
    const start = process.hrtime.bigint();
    const out = renderTemplate(tpl, { x: 'a' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(out.length).toBe(100_000);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('Template Engine: TPL-SEC-06 (malformed `{{{{var}}}}`)', () => {
  it('renders `{{{{var}}}}` deterministically without recursive expansion', () => {
    // Per spec rule 9: scan left-to-right. The first `{{` opens a token;
    // findTokenClose stops at the FIRST `}}`. So we treat `{{{{var}}}}` as:
    //   token contents = `{{var`  (between `{{` and the first `}}`)
    //   followed by literal `}}`.
    // The token `{{var` fails path validation → TemplateParseError.
    // This matches the spec's "MUST NOT execute or expand recursively" rule —
    // the engine raises a deterministic error instead of evaluating anything.
    expect(() => renderTemplate('{{{{var}}}}', { var: 'INJECTED' })).toThrow(
      TemplateParseError,
    );
  });

  it('writers can use the escape sequence to render literal `{{x}}`', () => {
    expect(renderTemplate('\\{{x}}', { x: 'unused' })).toBe('{{x}}');
  });
});

describe('Template Engine: TPL-SEC-07 (no prototype walk)', () => {
  it('rejects `__proto__.foo` as missing (with default)', () => {
    expect(renderTemplate('{{__proto__.foo | default("safe")}}', {})).toBe('safe');
  });

  it('rejects `__proto__` lookup itself even when set on Object.prototype', () => {
    // Even if a global Object.prototype.foo existed (it doesn't here), our lookup
    // uses `Object.hasOwn` and never reaches it. The variable is "missing".
    expect(() => renderTemplate('{{__proto__.toString}}', {})).toThrow(
      MissingVariableError,
    );
  });

  it('rejects `constructor.prototype.toString` as missing (with default)', () => {
    expect(
      renderTemplate('{{a.constructor.prototype.toString | default("safe")}}', { a: {} }),
    ).toBe('safe');
  });

  it('does not walk prototype even if the value has a __proto__ chain', () => {
    // Construct an object whose prototype has `injected: "BAD"`. Our lookup
    // uses Object.hasOwn so the value is never reached.
    const proto = { injected: 'BAD' };
    const obj = Object.create(proto);
    expect(renderTemplate('{{x.injected | default("safe")}}', { x: obj })).toBe('safe');
  });
});

describe('Template Engine: source guard — no eval/Function/vm/exec/spawn', () => {
  it('template-engine.ts contains zero unsafe primitives (comments stripped)', () => {
    const path = resolve(__dirname, '../commands/template-engine.ts');
    const raw = readFileSync(path, 'utf-8');
    // Strip JSDoc block comments and line comments (the rule applies to source
    // CODE, not prose). Method-style `.exec(`/`.spawn(` regex calls are fine —
    // we only ban un-dotted forms (i.e., the dangerous shell-exec/cp calls).
    const noBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    const stripped = noBlockComments
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const unsafeRegex =
      /\beval\s*\(|\bnew\s+Function\s*\(|(?<!\.)\bFunction\s*\(|\bvm\.run|\bchild_process\b|(?<!\.)\bexec\s*\(|(?<!\.)\bspawn\s*\(/;
    expect(unsafeRegex.test(stripped)).toBe(false);
  });
});

describe('Template Engine: dot-path edge cases', () => {
  it('rejects digit-leading path segments at parse time (no array indexing)', () => {
    // `arr.0` is a parse error: the spec forbids numeric segments. Templates
    // never index arrays by position; pass scalars to the engine instead.
    expect(() => renderTemplate('{{arr.0}}', { arr: ['a', 'b'] })).toThrow(
      TemplateParseError,
    );
  });

  it('treats valid-but-missing leaf on an array as missing (uses default)', () => {
    // `arr.foo` is a syntactically valid path; the lookup walks into the
    // array, sees it's an array (not a plain object), and returns undefined.
    expect(renderTemplate('{{arr.foo | default("D")}}', { arr: ['a', 'b'] })).toBe('D');
  });

  it('treats traversal into a string as missing', () => {
    expect(renderTemplate('{{s.length | default("D")}}', { s: 'hello' })).toBe('D');
  });

  it('hyphenated identifiers are allowed in path segments', () => {
    expect(renderTemplate('{{my-key}}', { 'my-key': 'ok' })).toBe('ok');
  });

  it('underscored identifiers are allowed in path segments', () => {
    expect(renderTemplate('{{my_key}}', { my_key: 'ok' })).toBe('ok');
  });
});

describe('Template Engine: integration — Plan #2 variable scope', () => {
  it('substitutes a typical scaffold template', () => {
    const tpl = `import { APIRouter } from "fastapi"
router = APIRouter(prefix="{{detected.python.api_prefix_base | default("/api")}}/{{name}}")
auth = Depends({{detected.python.auth_dep | default("get_current_user")}})`;
    const out = renderTemplate(tpl, {
      name: 'foo',
      detected: {
        python: {
          api_prefix_base: '/api',
          auth_dep: 'require_tier_or_guardian',
        },
      },
    });
    expect(out).toContain('prefix="/api/foo"');
    expect(out).toContain('Depends(require_tier_or_guardian)');
  });

  it('falls back to defaults when detected block is empty', () => {
    const tpl = 'auth = {{detected.python.auth_dep | default("get_current_user")}}';
    const out = renderTemplate(tpl, { detected: {} });
    expect(out).toBe('auth = get_current_user');
  });
});

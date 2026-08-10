// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Detector for RUNTIME `require()` OF A TYPESCRIPT SPECIFIER.
 *
 * THE DEFECT CLASS
 * ----------------
 * `require('./x.ts')` is a RUNTIME call, so it is resolved by whatever loader is
 * running — not by the TypeScript compiler and not by vitest's transform. Node
 * only learned to `require()` a `.ts` file in **22.18**, where require-of-ESM and
 * type-stripping became on-by-default. Below that floor the CJS loader hands the
 * raw TypeScript to the ESM parser, which dies on the first type annotation:
 *
 *   SyntaxError: Unexpected identifier 'as'      <- from `as const`
 *
 * `packages/core` declares `"engines": { "node": ">=22.16.0" }` and CI pins
 * exactly that floor, while this machine develops on Node 26. So the call
 * PASSES locally and FAILS on every runner — the worst available split, because
 * the local suite is what people read before pushing.
 *
 * Measured 2026-08-10: three such calls in `hooks-stdout-convention.test.ts` had
 * CI red in BOTH repos for two days (massu-internal run 31414707704, public
 * mirror run 31427990033), 3 failed / 3583 passed each time.
 *
 * THE REPLACEMENT
 * ---------------
 * A static `import … from './x.ts'`. It is resolved at build/transform time by
 * the toolchain, so the Node floor never sees the specifier at all.
 *
 * WHEN `require()` IS STILL CORRECT
 * ---------------------------------
 * Only when LAZINESS is the point. Measured with esbuild 0.28 (bundle, esm,
 * platform=node), evaluation order of the dependency vs the entry module:
 *
 *   require('./dep.js')  ->  ENTRY LOADED, then DEP MODULE EVALUATED   (lazy)
 *   import from './dep.ts' -> DEP MODULE EVALUATED, then ENTRY LOADED  (eager)
 *
 * esbuild resolves BOTH specifiers to `dep.ts` and inlines them, so no runtime
 * `require()` of a path survives into a bundle. A site that genuinely needs the
 * lazy form belongs in the guard's ALLOWLIST with that reason written down.
 *
 * WHAT COUNTS AS A HIT
 * --------------------
 * A `require(` in CODE position — never inside a comment, a string, or a
 * template literal — whose sole argument is a string literal ending in `.ts`,
 * `.tsx`, `.mts` or `.cts`.
 *
 * The scan is a state machine rather than a regex over stripped text because
 * this detector's own fixtures, and the guard's, are TypeScript source quoted
 * inside string literals. A `strip comments, then match` rule reads those as
 * code and flags the file that documents the defect — the prose-as-code failure
 * that has bitten three scanners in this repo already.
 */

export interface RequireTsHit {
  /** Repo-relative path of the file the hit is in. */
  file: string;
  /** 1-indexed line of the `require(`. */
  line: number;
  /** The specifier as written, e.g. `../hooks/lib/write-hook-message.ts`. */
  specifier: string;
  /** The source line, trimmed — for the failure message. */
  text: string;
}

const TS_SPECIFIER = /\.(ts|tsx|mts|cts)$/;

/**
 * Keywords after which a `/` begins a REGEX LITERAL rather than a division.
 *
 * Regex literals are why this scanner needs a real state machine and not just
 * quote tracking: `src.replace(/"(?:\\.|[^"\\])*"/g, '')` contains a lone `"`,
 * and a lexer blind to regex literals reads it as the START of a string and
 * desynchronises for the rest of the file — silently, reporting clean.
 *
 * That is not hypothetical. The first revision of this detector did exactly
 * that, and the live-fire in `scripts/tests/test-require-ts-specifier-guard-mutation.sh`
 * planted the real defect into `hooks-stdout-convention.test.ts` — a file full
 * of such regexes — and the guard stayed GREEN. The mutation test is the only
 * reason this is here.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * True when the `/` at `src[i]` starts a regex literal rather than a division.
 *
 * Decided by the previous significant character: after a value (identifier,
 * literal, `)`, `]`) a `/` is division; after an operator, a separator, or an
 * opening bracket it is a regex.
 */
function regexAllowedAt(src: string, i: number): boolean {
  let j = i - 1;
  // Walk back over whitespace.
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true; // start of file
  const c = src[j];
  if (/[A-Za-z0-9_$]/.test(c)) {
    // An identifier — a regex only follows a KEYWORD, never a variable.
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return REGEX_PRECEDING_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  // After a value-terminator a `/` is division; after anything else, a regex.
  return !(c === ')' || c === ']' || c === '}' || c === '"' || c === "'" || c === '`');
}

/** True when `src[i]` begins the identifier `require` used as a call. */
function isRequireCallAt(src: string, i: number): boolean {
  if (!src.startsWith('require', i)) return false;
  // Must not be part of a longer identifier (`myRequire`, `require_x`).
  const before = i > 0 ? src[i - 1] : '';
  if (before && /[A-Za-z0-9_$.]/.test(before)) return false;
  const after = src[i + 'require'.length];
  return after === '(';
}

/**
 * Scan `source` for runtime `require()` calls whose argument is a TypeScript
 * specifier.
 *
 * Single left-to-right pass tracking lexer state, so comment and string content
 * is structurally unreachable rather than filtered after the fact.
 */
export function findRequireTsSpecifiers(file: string, source: string): RequireTsHit[] {
  const hits: RequireTsHit[] = [];
  const lines = source.split('\n');

  type State =
    | 'code'
    | 'line-comment'
    | 'block-comment'
    | 'single'
    | 'double'
    | 'template'
    | 'regex'
    | 'regex-class';
  let state: State = 'code';
  let line = 1;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') line++;

    switch (state) {
      case 'line-comment':
        if (c === '\n') state = 'code';
        break;

      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;

      case 'single':
      case 'double': {
        if (c === '\\') {
          // Escape: skip the next char, but keep the line counter honest.
          if (next === '\n') line++;
          i++;
        } else if ((state === 'single' && c === "'") || (state === 'double' && c === '"')) {
          state = 'code';
        }
        break;
      }

      // A regex literal's body is not code. `[...]` character classes may
      // contain an unescaped `/`, so they get their own state.
      case 'regex':
        if (c === '\\') {
          i++;
        } else if (c === '[') {
          state = 'regex-class';
        } else if (c === '/') {
          state = 'code';
        } else if (c === '\n') {
          // A regex cannot span lines; an unterminated one means the heuristic
          // misfired. Recover to code rather than swallow the rest of the file.
          state = 'code';
        }
        break;

      case 'regex-class':
        if (c === '\\') {
          i++;
        } else if (c === ']') {
          state = 'regex';
        } else if (c === '\n') {
          state = 'code';
        }
        break;

      case 'template':
        if (c === '\\') {
          if (next === '\n') line++;
          i++;
        } else if (c === '`') {
          state = 'code';
        }
        // `${ … }` interpolations are treated as string body. A require() inside
        // one is exotic enough that missing it is the safer error: this detector
        // reports what it CAN see, and the guard asserts its denominator.
        break;

      case 'code': {
        if (c === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (c === '/' && regexAllowedAt(source, i)) {
          state = 'regex';
        } else if (c === "'") {
          state = 'single';
        } else if (c === '"') {
          state = 'double';
        } else if (c === '`') {
          state = 'template';
        } else if (isRequireCallAt(source, i)) {
          // `require(` — read an optional-whitespace-wrapped string literal arg.
          let j = i + 'require('.length;
          while (j < source.length && /\s/.test(source[j])) j++;
          const quote = source[j];
          if (quote === "'" || quote === '"') {
            const end = source.indexOf(quote, j + 1);
            if (end !== -1) {
              const specifier = source.slice(j + 1, end);
              if (TS_SPECIFIER.test(specifier)) {
                hits.push({
                  file,
                  line,
                  specifier,
                  text: (lines[line - 1] ?? '').trim(),
                });
              }
            }
          }
          // Advance past the identifier so the '(' is not re-examined.
          i += 'require'.length;
        }
        break;
      }
    }
  }

  return hits;
}
